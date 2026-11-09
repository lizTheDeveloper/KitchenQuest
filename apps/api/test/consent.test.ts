import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { grantConsent, hasConsent, requireConsent, withdrawConsent } from '../src/consent/ledger.js';
import { NOTICES } from '../src/consent/notices.js';
import { sealFor } from '../src/crypto/userkeys.js';
import { rules, users } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();

let db: Db;
let sql: Sql;
let close: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let clock: Date;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close } = await testDb());
});
afterAll(async () => {
  await close?.();
});
beforeEach(async () => {
  clock = new Date('2026-06-01T12:00:00Z');
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, now: () => clock, logger: false });
});
afterEach(async () => {
  await app?.close();
});

async function newUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `consent${++seq}@example.com`, ageConfirmedAt: clock })
    .returning({ id: users.id });
  return u.id;
}

const auditFor = (userId: string) =>
  sql`select actor_kind, actor_id, action, target from audit_events where subject_user_id = ${userId} order by id`;

describe('consent ledger (C-1)', () => {
  it('grants, checks against the clock, and withdraws', async () => {
    const userId = await newUser();
    const t0 = new Date('2026-06-01T00:00:00Z');
    const t1 = new Date('2026-06-02T00:00:00Z');
    expect(await hasConsent(db, userId, 'health_data', t0)).toBe(false);
    await grantConsent(db, userId, 'health_data', 'v1', sha('notice'), 'tap', t0);
    expect(await hasConsent(db, userId, 'health_data', t0)).toBe(true);
    expect(await hasConsent(db, userId, 'health_data', new Date(t0.getTime() - 1))).toBe(false);
    expect(await hasConsent(db, userId, 'ai_health', t0)).toBe(false);

    await withdrawConsent(db, userId, 'health_data', t1);
    expect(await hasConsent(db, userId, 'health_data', t1)).toBe(false);
    // History is kept: it was given at t0 and still reads as given just before t1.
    expect(await hasConsent(db, userId, 'health_data', new Date(t1.getTime() - 1))).toBe(true);
    const rows = await sql`select purpose, notice_version, notice_sha256, method, granted_at, withdrawn_at from consents where user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'health_data', notice_version: 'v1', method: 'tap' });
    expect(new Date(rows[0].granted_at).getTime()).toBe(t0.getTime());
    expect(new Date(rows[0].withdrawn_at).getTime()).toBe(t1.getTime());
    expect(Buffer.from(rows[0].notice_sha256).equals(sha('notice'))).toBe(true);
  });

  it('a repeat grant of the same notice is a no-op; a new notice version supersedes the old', async () => {
    const userId = await newUser();
    const t0 = new Date('2026-06-01T00:00:00Z');
    const t1 = new Date('2026-07-01T00:00:00Z');
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', t0);
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', t1);
    expect(await sql`select 1 from consents where user_id = ${userId}`).toHaveLength(1);
    await grantConsent(db, userId, 'voice', 'v2', sha('b'), 'tap', t1);
    const rows = await sql`select notice_version, withdrawn_at from consents where user_id = ${userId} order by granted_at`;
    expect(rows.map((r) => [r.notice_version, r.withdrawn_at && new Date(r.withdrawn_at).getTime()])).toEqual([
      ['v1', t1.getTime()],
      ['v2', null],
    ]);
    expect(await hasConsent(db, userId, 'voice', t1)).toBe(true);
  });

  it('grant, withdraw, grant again: consent is back, with full history', async () => {
    const userId = await newUser();
    const t = (h: number) => new Date(Date.UTC(2026, 5, 1, h));
    await grantConsent(db, userId, 'health_data', 'v1', sha('a'), 'tap', t(1));
    await withdrawConsent(db, userId, 'health_data', t(2));
    expect(await hasConsent(db, userId, 'health_data', t(2))).toBe(false);
    await grantConsent(db, userId, 'health_data', 'v1', sha('a'), 'tap', t(3));
    expect(await hasConsent(db, userId, 'health_data', t(3))).toBe(true);
    expect(await hasConsent(db, userId, 'health_data', new Date(t(2).getTime() + 1))).toBe(false);
    const rows = await sql`select ended_reason from consents where user_id = ${userId} order by granted_at`;
    expect(rows.map((r) => r.ended_reason)).toEqual(['withdrawn', null]);
  });

  it('records why a grant ended: withdrawn or superseded', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', new Date('2026-06-01T00:00:00Z'));
    await grantConsent(db, userId, 'voice', 'v2', sha('b'), 'tap', new Date('2026-06-02T00:00:00Z'));
    await withdrawConsent(db, userId, 'voice', new Date('2026-06-03T00:00:00Z'));
    const rows = await sql`select notice_version, ended_reason from consents where user_id = ${userId} order by granted_at`;
    expect(rows.map((r) => [r.notice_version, r.ended_reason])).toEqual([
      ['v1', 'superseded'],
      ['v2', 'withdrawn'],
    ]);
    // The database keeps withdrawn_at and ended_reason together.
    await expect(sql`update consents set ended_reason = null where user_id = ${userId}`).rejects.toThrow();
  });

  it('concurrent first grants record exactly one active grant and one audit event', async () => {
    const userId = await newUser();
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => grantConsent(db, userId, 'pantry_location', 'v1', sha('a'), 'tap', clock)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(5).fill('fulfilled'));
    expect(await sql`select 1 from consents where user_id = ${userId}`).toHaveLength(1);
    expect((await auditFor(userId)).map((r) => r.action)).toEqual(['consent.grant']);
  });

  it('the database allows only one active grant per purpose', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', clock);
    await expect(
      sql`insert into consents (id, user_id, purpose, notice_version, notice_sha256, granted_at, method)
          values (${randomUUID()}, ${userId}, 'voice', 'v9', ${sha('z')}, now(), 'api')`,
    ).rejects.toThrow();
  });

  it('rejects an unknown purpose or method at the database', async () => {
    const userId = await newUser();
    await expect(
      sql`insert into consents (id, user_id, purpose, notice_version, notice_sha256, granted_at, method)
          values (${randomUUID()}, ${userId}, 'marketing', 'v1', ${sha('a')}, now(), 'api')`,
    ).rejects.toThrow();
    await expect(
      sql`insert into consents (id, user_id, purpose, notice_version, notice_sha256, granted_at, method)
          values (${randomUUID()}, ${userId}, 'voice', 'v1', ${sha('a')}, now(), 'implied')`,
    ).rejects.toThrow();
  });

  it('records consent changes in the audit log', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'ai_health', 'v1', sha('a'), 'api', clock);
    await withdrawConsent(db, userId, 'ai_health', clock);
    expect(await auditFor(userId)).toEqual([
      { actor_kind: 'user', actor_id: userId, action: 'consent.grant', target: 'ai_health' },
      { actor_kind: 'user', actor_id: userId, action: 'consent.withdraw', target: 'ai_health' },
    ]);
  });

  it('requireConsent throws 403 consent_required', async () => {
    const userId = await newUser();
    await expect(requireConsent(db, userId, 'health_data', clock)).rejects.toMatchObject({ status: 403, code: 'consent_required' });
    await grantConsent(db, userId, 'health_data', 'v1', sha('a'), 'tap', clock);
    await expect(requireConsent(db, userId, 'health_data', clock)).resolves.toBeUndefined();
  });

  it('cascades with the user', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', clock);
    await sql`delete from users where id = ${userId}`;
    expect(await sql`select 1 from consents where user_id = ${userId}`).toHaveLength(0);
  });
});

describe('health_data notice v1 (N-7)', () => {
  const file = readFileSync(new URL('../../../docs/compliance/notices/health_data-v1.md', import.meta.url), 'utf8');
  const notice = NOTICES.health_data!;

  it('is the text of docs/compliance/notices/health_data-v1.md, version v1, with its sha256 declared there', () => {
    expect(notice.version).toBe('v1');
    const between = /<!-- notice-text:start -->\n\n([\s\S]*?)\n\n<!-- notice-text:end -->/.exec(file);
    expect(between).not.toBeNull();
    expect(notice.text).toBe(between![1]);
    expect(file).toContain('Version: `v1`');
    expect(file).toContain(`SHA-256 of the notice text: \`${sha(notice.text).toString('hex')}\``);
  });

  it('names religious and cultural dietary rules as covered (GDPR Art. 9)', () => {
    expect(notice.text).toMatch(/religious/i);
    expect(notice.text).toMatch(/cultural/i);
    expect(notice.text).toMatch(/allerg/i);
  });

  it('a grant stores the notice version and sha256 in the ledger', async () => {
    const cookie = await signIn(app, mailer, `notice${++seq}@example.com`);
    const res = await app.inject({
      method: 'POST',
      url: '/me/consents',
      cookies: { kq_session: cookie },
      payload: { purpose: 'health_data', noticeVersion: 'v1' },
    });
    expect(res.statusCode).toBe(201);
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies: { kq_session: cookie } })).json().id as string;
    const rows = await sql<{ notice_version: string; notice_sha256: Buffer }[]>`
      select notice_version, notice_sha256 from consents where user_id = ${userId} and purpose = 'health_data'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].notice_version).toBe('v1');
    expect(Buffer.from(rows[0].notice_sha256).equals(sha(notice.text))).toBe(true);
  });
});

describe('a grant under an older notice (health_data before v1)', () => {
  const PEANUT = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };

  it('no longer counts: writes are 403 and GET /me/consents asks again; a v1 grant restores them', async () => {
    const cookie = await signIn(app, mailer, `stale${++seq}@example.com`);
    const cookies = { kq_session: cookie };
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies })).json().id as string;
    const old = 'Kitchen Quest can store your allergies, diet rules ...';
    await grantConsent(db, userId, 'health_data', '2026-11-09', sha(old), 'tap', clock);

    expect(await hasConsent(db, userId, 'health_data', clock)).toBe(false);
    const refused = await app.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: PEANUT, confirmed: true } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('consent_required');
    const stale = (await app.inject({ method: 'GET', url: '/me/consents', cookies })).json();
    expect(stale.needsReconsent).toEqual(['health_data']);
    expect(stale.consents.at(-1)).toMatchObject({ noticeVersion: '2026-11-09', withdrawnAt: null, current: false });

    clock = new Date(clock.getTime() + 60_000);
    const regrant = await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: 'v1' } });
    expect(regrant.statusCode).toBe(201);
    expect(regrant.json().consent).toMatchObject({ noticeVersion: 'v1', current: true });
    const ok = await app.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: PEANUT, confirmed: true } });
    expect(ok.statusCode).toBe(201);
    const fresh = (await app.inject({ method: 'GET', url: '/me/consents', cookies })).json();
    expect(fresh.needsReconsent).toEqual([]);
    // The history keeps the old grant, ended as superseded.
    expect(fresh.consents.map((c: { noticeVersion: string; endedReason: string | null }) => [c.noticeVersion, c.endedReason])).toEqual([
      ['2026-11-09', 'superseded'],
      ['v1', null],
    ]);
  });
});

describe('consent routes (C-1)', () => {
  const current = NOTICES.health_data!;

  it('need a session', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/consents' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/me/consents', payload: { purpose: 'voice', noticeVersion: 'x' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: '/me/consents/voice', payload: {} })).statusCode).toBe(401);
  });

  it('grant, list and withdraw', async () => {
    const cookie = await signIn(app, mailer, `route${++seq}@example.com`);
    const cookies = { kq_session: cookie };

    const empty = await app.inject({ method: 'GET', url: '/me/consents', cookies });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().consents).toEqual([]);
    expect(empty.json().notices.health_data).toEqual({ version: current.version, text: current.text });
    expect(empty.json().notices.research).toBeUndefined();

    const post = await app.inject({
      method: 'POST',
      url: '/me/consents',
      cookies,
      payload: { purpose: 'health_data', noticeVersion: current.version, method: 'tap' },
    });
    expect(post.statusCode).toBe(201);
    expect(post.json().consent).toMatchObject({
      purpose: 'health_data',
      noticeVersion: current.version,
      noticeSha256: sha(current.text).toString('hex'),
      method: 'tap',
      grantedAt: clock.toISOString(),
      withdrawnAt: null,
      endedReason: null,
    });

    clock = new Date(clock.getTime() + 60_000);
    const del = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'keep' } });
    expect(del.statusCode).toBe(204);
    const list = await app.inject({ method: 'GET', url: '/me/consents', cookies });
    expect(list.json().consents).toHaveLength(1);
    expect(list.json().consents[0].withdrawnAt).toBe(clock.toISOString());
    expect(list.json().consents[0].endedReason).toBe('withdrawn');
  });

  it('rejects a stale notice version, an unoffered purpose and an unknown purpose', async () => {
    const cookies = { kq_session: await signIn(app, mailer, `route${++seq}@example.com`) };
    for (const payload of [
      { purpose: 'health_data', noticeVersion: 'v0-old' },
      { purpose: 'research', noticeVersion: 'v1' },
      { purpose: 'marketing', noticeVersion: 'v1' },
      { purpose: 'health_data' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/me/consents', cookies, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect((await app.inject({ method: 'DELETE', url: '/me/consents/marketing', cookies, payload: {} })).statusCode).toBe(400);
  });

  it('withdrawing health_data needs an explicit choice, and "delete" removes health data now', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    const rowId = randomUUID();
    await db.insert(rules).values({ id: rowId, userId, sealed: await sealFor(db, config.keyring, { table: 'rules', userId, rowId }, { t: 1 }) });

    const noChoice = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: {} });
    expect(noChoice.statusCode).toBe(400);
    expect(await hasConsent(db, userId, 'health_data', clock)).toBe(true);

    const res = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
    expect(res.statusCode).toBe(204);
    expect(await hasConsent(db, userId, 'health_data', clock)).toBe(false);
    expect(await sql`select 1 from rules where user_id = ${userId}`).toHaveLength(0);
    expect((await auditFor(userId)).map((r) => r.action)).toEqual([
      'auth.sign_in',
      'consent.grant',
      'consent.withdraw',
      'health_data.delete',
    ]);
  });

  it('withdraw-with-delete is one transaction: a failing delete leaves consent in place', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    await db.insert(rules).values({ userId, sealed: Buffer.from('x') });
    // Make the rules delete fail for this user only.
    await sql.unsafe(`
      create function fail_rules_delete() returns trigger language plpgsql as $$
      begin if old.user_id = '${userId}' then raise exception 'injected failure'; end if; return old; end $$;
      create trigger fail_rules_delete before delete on rules for each row execute function fail_rules_delete();`);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
      expect(res.statusCode).toBe(500);
      expect(await hasConsent(db, userId, 'health_data', clock)).toBe(true);
      expect(await sql`select 1 from rules where user_id = ${userId}`).toHaveLength(1);
      expect((await auditFor(userId)).map((r) => r.action)).toEqual(['auth.sign_in', 'consent.grant']);
    } finally {
      await sql.unsafe('drop trigger fail_rules_delete on rules; drop function fail_rules_delete();');
    }
  });

  it('"keep" leaves health data in place', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    await db.insert(rules).values({ userId, sealed: Buffer.from('x') });
    await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'keep' } });
    expect(await sql`select 1 from rules where user_id = ${userId}`).toHaveLength(1);
  });

  it('withdrawing a purpose that was never granted is a quiet no-op', async () => {
    const cookies = { kq_session: await signIn(app, mailer, `route${++seq}@example.com`) };
    expect((await app.inject({ method: 'DELETE', url: '/me/consents/voice', cookies, payload: {} })).statusCode).toBe(204);
  });
});
