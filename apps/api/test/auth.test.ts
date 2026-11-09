import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { testDb, type Sql } from './helpers/db.js';
import type { Db } from '../src/types.js';

const APP_ORIGIN = 'https://play.kitchenquest.test';
const config = loadConfig({
  DATABASE_URL: 'postgres://x@localhost/x',
  DATA_KEY: Buffer.alloc(32, 7).toString('base64'),
  APP_ORIGIN,
});

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
  app = await buildApp({ config, db, mailer, now: () => clock, logger: false });
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
  return m![2]!;
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
    const [pair, ...attrs] = header[0]!.split('; ');
    expect(pair).toMatch(/^kq_session=[A-Za-z0-9_-]{43}$/);
    expect(attrs.sort()).toEqual(['HttpOnly', 'Path=/', 'SameSite=Lax', 'Secure']);

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
    expect((row!.token_hash as Buffer).length).toBe(32); // SHA-256
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
    expect(new Date(user!.age_confirmed_at).toISOString()).toBe(clock.toISOString());
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

  it('rejects a malformed email with 400 bad_request', async () => {
    const res = await requestLink('not-an-email');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_request');
    expect(mailer.sent).toHaveLength(0);
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
});
