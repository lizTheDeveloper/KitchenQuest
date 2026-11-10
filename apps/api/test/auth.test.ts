import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { NOTICES } from '../src/consent/notices.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { testEnv } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import type { Db } from '../src/types.js';

const APP_ORIGIN = 'https://play.kitchenquest.test';
const env = {
  ...testEnv,
  APP_ORIGIN,
};
const config = loadConfig(env);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let clock: Date;
let seq = 0;

const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms);
};
const freshEmail = () => `cook${++seq}@example.com`;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  clock = new Date('2026-03-01T12:00:00Z');
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => clock, logger: false });
});
afterEach(async () => {
  await app?.close();
});

function requestLink(email: string, remoteAddress = '10.0.0.1') {
  return app.inject({ method: 'POST', url: '/auth/request', payload: { email }, remoteAddress });
}

/** Requests a link for `email` and returns the raw token from the captured mail. */
async function tokenFor(email: string): Promise<string> {
  const res = await requestLink(email);
  expect(res.statusCode).toBe(202);
  const mail = mailer.sent.at(-1)!;
  expect(mail.to).toBe(email);
  const m = mail.text.match(/(https?:\/\/\S+\/auth\/verify\?token=([A-Za-z0-9_-]+))/);
  expect(m, mail.text).not.toBeNull();
  return m![2];
}

function verify(token: string, ageConfirmed?: boolean) {
  return app.inject({
    method: 'POST',
    url: '/auth/verify',
    payload: ageConfirmed === undefined ? { token } : { token, ageConfirmed },
  });
}

function sessionCookie(res: LightMyRequestResponse): string {
  const c = res.cookies.find((c) => c.name === 'kq_session');
  expect(c).toBeDefined();
  return c!.value;
}

function me(cookie?: string) {
  return app.inject({
    method: 'GET',
    url: '/me',
    ...(cookie === undefined ? {} : { cookies: { kq_session: cookie } }),
  });
}

async function signIn(email = freshEmail()): Promise<{ email: string; cookie: string }> {
  const res = await verify(await tokenFor(email), true);
  expect(res.statusCode).toBe(200);
  return { email, cookie: sessionCookie(res) };
}

describe('magic-link sign-in', () => {
  it('full flow: request, mail, verify, secure cookie, /me', async () => {
    const email = freshEmail();
    const req = await requestLink(email);
    expect(req.statusCode).toBe(202);
    expect(req.json()).toEqual({ ok: true });

    expect(mailer.sent).toHaveLength(1);
    const token = await tokenFor(email);
    expect(mailer.sent.at(-1)!.text).toContain(`${APP_ORIGIN}/auth/verify?token=${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    const res = await verify(token, true);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ user: { id: expect.any(String), email } });

    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw : [raw!];
    expect(header).toHaveLength(1);
    const [pair, ...attrs] = header[0].split('; ');
    expect(pair).toMatch(/^kq_session=[A-Za-z0-9_-]{43}$/);
    expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=2592000', 'Path=/', 'SameSite=Lax', 'Secure']);

    const who = await me(sessionCookie(res));
    expect(who.statusCode).toBe(200);
    expect(who.json()).toEqual({ id: body.user.id, email, entitlements: [] });
  });

  it('stores only hashes: no row holds the raw login or session token', async () => {
    const email = freshEmail();
    const token = await tokenFor(email);
    const res = await verify(token, true);
    const session = sessionCookie(res);

    const dump = async () => {
      const lt = await sql`select * from login_tokens`;
      const ss = await sql`select * from sessions`;
      return JSON.stringify([...lt, ...ss], (_k, v) =>
        v && v.type === 'Buffer' ? Buffer.from(v.data).toString('latin1') + Buffer.from(v.data).toString('hex') : v,
      );
    };
    const text = await dump();
    for (const secret of [token, session]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(Buffer.from(secret, 'base64url').toString('hex'));
    }
    const [row] = await sql`select token_hash from login_tokens where email = ${email}`;
    expect((row.token_hash as Buffer).length).toBe(32); // SHA-256
  });

  it('a token works once: replay is 401', async () => {
    const token = await tokenFor(freshEmail());
    expect((await verify(token, true)).statusCode).toBe(200);
    const again = await verify(token, true);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('unauthorized');
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('two concurrent verifies: exactly one 200, one session', async () => {
    const email = freshEmail();
    const token = await tokenFor(email);
    const results = await Promise.all([verify(token, true), verify(token, true), verify(token, true)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 401, 401]);
    const [{ n }] = await sql`
      select count(*)::int as n from sessions s join users u on u.id = s.user_id where u.email = ${email}`;
    expect(n).toBe(1);
  });

  it('a tampered or unknown token is 401', async () => {
    const token = await tokenFor(freshEmail());
    const last = token.at(-1)!;
    const tampered = token.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect((await verify(tampered, true)).statusCode).toBe(401);
    expect((await verify('x'.repeat(43), true)).statusCode).toBe(401);
    expect((await verify('', true)).statusCode).toBe(401);
    // The genuine token is still good afterwards.
    expect((await verify(token, true)).statusCode).toBe(200);
  });

  it('expires after 15 minutes', async () => {
    const token = await tokenFor(freshEmail());
    advance(15 * MIN + 1000);
    expect((await verify(token, true)).statusCode).toBe(401);
  });

  it('is still valid just before 15 minutes', async () => {
    const token = await tokenFor(freshEmail());
    advance(15 * MIN - 1000);
    expect((await verify(token, true)).statusCode).toBe(200);
  });

  it('new user without ageConfirmed: 400 and the token is not consumed', async () => {
    const email = freshEmail();
    const token = await tokenFor(email);
    for (const age of [undefined, false]) {
      const res = await verify(token, age);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'bad_request', details: { code: 'age_confirmation_required' } });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const [{ n }] = await sql`select count(*)::int as n from users where email = ${email}`;
    expect(n).toBe(0);

    const ok = await verify(token, true);
    expect(ok.statusCode).toBe(200);
    const [user] = await sql`select age_confirmed_at from users where email = ${email}`;
    expect(new Date(user.age_confirmed_at).toISOString()).toBe(clock.toISOString());
  });

  it('an existing user signs in again without ageConfirmed, same id', async () => {
    const email = freshEmail();
    const first = (await verify(await tokenFor(email), true)).json();
    const second = await verify(await tokenFor(email.toUpperCase()));
    expect(second.statusCode).toBe(200);
    expect(second.json().user.id).toBe(first.user.id);
  });

  it('unknown and known emails get the same 202 and both get mail', async () => {
    const { email: known } = await signIn();
    const unknown = freshEmail();
    const a = await requestLink(known);
    const b = await requestLink(unknown);
    expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
    expect(a.body).toBe(b.body);
    expect(mailer.sent.slice(-2).map((m) => m.to)).toEqual([known, unknown]);
  });

  it('accepts only JSON: a text/plain or form POST to /auth/verify is 415 and consumes nothing (CSRF)', async () => {
    const token = await tokenFor(freshEmail());
    const plain = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ token, ageConfirmed: true }),
    });
    expect(plain.statusCode).toBe(415);
    expect(plain.headers['set-cookie']).toBeUndefined();
    const form = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${token}&ageConfirmed=true`,
    });
    expect(form.statusCode).toBe(415);
    expect((await verify(token, true)).statusCode).toBe(200);
  });

  it('rejects a malformed email with 400 bad_request', async () => {
    const res = await requestLink('not-an-email');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('verify lock order (M-1)', () => {
  it("takes the email's sign-in lock before locking the token, as account delete does", async () => {
    const { email } = await signIn();
    const token = await tokenFor(email.toUpperCase());
    const blocker = await sql.reserve();
    try {
      // Stand in for an account delete holding the email lock.
      await blocker`begin`;
      await blocker`select pg_advisory_xact_lock(${ADVISORY_LOCK.signInEmail}, hashtext(lower(${email})))`;
      const verifying = verify(token);
      for (let i = 0; ; i++) {
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        if (w.n >= 1) break;
        if (i > 300) throw new Error('verify never waited on the email lock');
        await new Promise((r) => setTimeout(r, 10));
      }
      // The token row is not locked yet, so the delete could still remove it without waiting.
      expect(await blocker`select 1 from login_tokens where lower(email) = lower(${email}) for update nowait`).not.toHaveLength(0);
      await blocker`commit`;
      expect((await verifying).statusCode).toBe(200);
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
  });
});

describe('the magic-link email (N-1)', () => {
  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

  it('is plain text with exactly one URL, the verify link, and no health content', async () => {
    // A player with health data on file: rules, consent and a profile.
    const { email, cookie } = await signIn();
    const cookies = { kq_session: cookie };
    const grant = await app.inject({
      method: 'POST',
      url: '/me/consents',
      cookies,
      payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
    });
    expect(grant.statusCode).toBe(201);
    const rule = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic', note: 'epipen' };
    expect((await app.inject({ method: 'POST', url: '/rules', cookies, payload: { rule, confirmed: true } })).statusCode).toBe(201);
    await app.inject({ method: 'PUT', url: '/profile', cookies, payload: { country: 'NZ', mealWindows: [{ name: 'dinner', start: '18:00', end: '19:00' }] } });

    const token = await tokenFor(email);
    const mail = mailer.sent.at(-1)!;
    // Only these fields: no HTML body, attachments or extra headers.
    expect(Object.keys(mail).sort()).toEqual(['subject', 'text', 'to']);
    expect(mail.text.match(URL_RE)).toEqual([`${APP_ORIGIN}/auth/verify?token=${token}`]);
    expect(mail.text).not.toMatch(/<[a-z!/]/i); // no markup, so nothing to wrap or track
    // The token is random text, so look only at the words around it.
    const all = `${mail.subject}\n${mail.text.replace(URL_RE, '')}`.toLowerCase();
    for (const word of ['peanut', 'epipen', 'anaphyla', 'allerg', 'diet', 'rule', 'health', 'consent', 'dinner', 'nz', 'halal', 'kosher', 'fast', 'unsubscribe']) {
      expect(all, word).not.toContain(word);
    }
  });
});

describe('sessions', () => {
  it('/me without a cookie or with a bogus cookie is 401', async () => {
    const none = await me();
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('unauthorized');
    expect((await me('nope')).statusCode).toBe(401);
  });

  it('logout deletes the session and clears the cookie', async () => {
    const { cookie } = await signIn();
    const out = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { kq_session: cookie } });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === 'kq_session');
    expect(cleared?.value).toBe('');
    expect(cleared?.path).toBe('/');
    expect(cleared?.maxAge).toBe(0);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it('logout without a session is still 204', async () => {
    const out = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(out.statusCode).toBe(204);
  });

  it('a session lasts 30 days and expires 1 s after', async () => {
    const { cookie } = await signIn();
    advance(30 * DAY - 1000);
    expect((await me(cookie)).statusCode).toBe(200);
    advance(2000);
    expect((await me(cookie)).statusCode).toBe(401);
  });
});

describe('rate limits on /auth/request', () => {
  it('6th request for one email within an hour is 429; allowed again after the hour', async () => {
    const email = freshEmail();
    for (let i = 0; i < 5; i++) {
      expect((await requestLink(email, `10.1.0.${i}`)).statusCode).toBe(202);
      advance(MIN);
    }
    const sixth = await requestLink(email.toUpperCase(), '10.1.0.99');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('rate_limited');
    expect(mailer.sent).toHaveLength(5);

    advance(56 * MIN); // the first request is now more than an hour old
    expect((await requestLink(email, '10.1.0.100')).statusCode).toBe(202);
  });

  it('21st request from one IP within an hour is 429', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await requestLink(freshEmail(), '10.2.0.1')).statusCode).toBe(202);
    }
    const res = await requestLink(freshEmail(), '10.2.0.1');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect((await requestLink(freshEmail(), '10.2.0.2')).statusCode).toBe(202);
  });

  it('a request refused by the email limit does not use up the IP budget', async () => {
    const ip = '10.3.0.1';
    const email = freshEmail();
    for (let i = 0; i < 5; i++) expect((await requestLink(email, ip)).statusCode).toBe(202);
    for (let i = 0; i < 10; i++) expect((await requestLink(email, ip)).statusCode).toBe(429);
    // 5 of the IP's 20 are used; 15 more for other emails pass, then the IP is full.
    for (let i = 0; i < 15; i++) expect((await requestLink(freshEmail(), ip)).statusCode).toBe(202);
    expect((await requestLink(freshEmail(), ip)).statusCode).toBe(429);
  });

  it('limits IPv6 clients by /64', async () => {
    for (let i = 1; i <= 20; i++) {
      expect((await requestLink(freshEmail(), `2001:db8:1:2::${i.toString(16)}`)).statusCode).toBe(202);
    }
    expect((await requestLink(freshEmail(), '2001:0db8:0001:0002:ffff:1:2:3')).statusCode).toBe(429);
    expect((await requestLink(freshEmail(), '2001:db8:1:3::1')).statusCode).toBe(202);
  });

  describe('X-Forwarded-For', () => {
    async function flood(trustProxy: string | undefined) {
      const proxied = await buildApp({
        config: loadConfig({ ...env, ...(trustProxy === undefined ? {} : { TRUST_PROXY: trustProxy }) }),
        db,
        mailer,
        ai: null,
        now: () => clock,
        logger: false,
      });
      const send = (client: string) =>
        proxied.inject({
          method: 'POST',
          url: '/auth/request',
          payload: { email: freshEmail() },
          remoteAddress: '10.9.9.9', // the proxy
          headers: { 'x-forwarded-for': client },
        });
      try {
        for (let i = 0; i < 20; i++) expect((await send('203.0.113.7')).statusCode).toBe(202);
        expect((await send('203.0.113.7')).statusCode).toBe(429);
        return (await send('203.0.113.8')).statusCode;
      } finally {
        await proxied.close();
      }
    }

    it('is ignored by default: every client behind the proxy shares its address', async () => {
      expect(await flood(undefined)).toBe(429);
    });

    it('sets the client address when TRUST_PROXY names the proxy', async () => {
      expect(await flood('10.9.9.0/24')).toBe(202);
      expect(await flood('true')).toBe(202);
      expect(await flood('1')).toBe(202);
    });
  });
});

describe('audit events (C-5)', () => {
  const eventsFor = (userId: string) =>
    sql`select actor_kind, actor_id, subject_user_id, action, target, request_id, at
        from audit_events where subject_user_id = ${userId} order by id`;

  it('sign-in and sign-out each write a content-free event', async () => {
    const { email, cookie } = await signIn();
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    const [signedIn] = await eventsFor(userId);
    expect(signedIn).toMatchObject({
      actor_kind: 'user',
      actor_id: userId,
      subject_user_id: userId,
      action: 'auth.sign_in',
      target: null,
      request_id: expect.any(String),
    });
    expect(new Date(signedIn.at).getTime()).toBe(clock.getTime());
    // No email anywhere in the audit log.
    expect(await sql`select 1 from audit_events where row_to_json(audit_events)::text ilike ${'%' + email + '%'}`).toHaveLength(0);

    advance(MIN);
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { kq_session: cookie } });
    expect((await eventsFor(userId)).map((e) => e.action)).toEqual(['auth.sign_in', 'auth.sign_out']);
  });

  it('a failed verify writes no sign-in event', async () => {
    const before = await sql`select count(*)::int as n from audit_events`;
    const res = await verify('A'.repeat(43), true);
    expect(res.statusCode).toBe(401);
    expect(await sql`select count(*)::int as n from audit_events`).toEqual(before);
  });

  it('a logout without a live session writes nothing', async () => {
    const before = await sql`select count(*)::int as n from audit_events`;
    await app.inject({ method: 'POST', url: '/auth/logout', cookies: { kq_session: 'B'.repeat(43) } });
    expect(await sql`select count(*)::int as n from audit_events`).toEqual(before);
  });
});
