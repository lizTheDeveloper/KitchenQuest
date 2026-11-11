import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { grantConsent, hasConsent, requireConsent, withdrawConsent } from '../src/consent/ledger.js';
import { NOTICES } from '../src/consent/notices.js';
import { sealFor } from '../src/crypto/userkeys.js';
import { rules, users } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { appendMessages, openConversation } from '../src/mentor/conversations.js';
import { MemoryHistory } from '../src/mentor/memory.js';
import { createProposal } from '../src/mentor/proposals.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
/** The current health_data notice version (v3 since M5 Step 7); grants under it count. */
const HD = NOTICES.health_data!.version;
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
  app = await buildApp({ config, db, mailer, ai: null, now: () => clock, logger: false });
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

async function waitForLockWaiters(n: number, kind?: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and (${kind ?? null}::text is null or wait_event = ${kind ?? null})`;
    if (row.n >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${n} lock waiter(s)`);
}

const auditFor = (userId: string) =>
  sql`select actor_kind, actor_id, action, target from audit_events where subject_user_id = ${userId} order by id`;

describe('consent ledger (C-1)', () => {
  it('grants, checks against the clock, and withdraws', async () => {
    const userId = await newUser();
    const t0 = new Date('2026-06-01T00:00:00Z');
    const t1 = new Date('2026-06-02T00:00:00Z');
    expect(await hasConsent(db, userId, 'health_data', t0)).toBe(false);
    await grantConsent(db, userId, 'health_data', HD, sha('notice'), 'tap', t0);
    expect(await hasConsent(db, userId, 'health_data', t0)).toBe(true);
    expect(await hasConsent(db, userId, 'health_data', new Date(t0.getTime() - 1))).toBe(false);
    expect(await hasConsent(db, userId, 'ai_health', t0)).toBe(false);

    await withdrawConsent(db, userId, 'health_data', t1);
    expect(await hasConsent(db, userId, 'health_data', t1)).toBe(false);
    // History is kept: it was given at t0 and still reads as given just before t1.
    expect(await hasConsent(db, userId, 'health_data', new Date(t1.getTime() - 1))).toBe(true);
    const rows = await sql`select purpose, notice_version, notice_sha256, method, granted_at, withdrawn_at from consents where user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purpose: 'health_data', notice_version: HD, method: 'tap' });
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
    await grantConsent(db, userId, 'health_data', HD, sha('a'), 'tap', t(1));
    await withdrawConsent(db, userId, 'health_data', t(2));
    expect(await hasConsent(db, userId, 'health_data', t(2))).toBe(false);
    await grantConsent(db, userId, 'health_data', HD, sha('a'), 'tap', t(3));
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

  it('consents.subject_kind defaults to user; inserting child_profile fails the check (C-45 reserve, Ruling 19)', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', clock);
    const rows = await sql<{ subject_kind: string; subject_id: string | null }[]>`select subject_kind, subject_id from consents where user_id = ${userId}`;
    expect(rows).toEqual([{ subject_kind: 'user', subject_id: null }]);
    await expect(
      sql`insert into consents (id, user_id, purpose, notice_version, notice_sha256, granted_at, method, subject_kind, subject_id)
          values (${randomUUID()}, ${userId}, 'pantry_location', 'v1', ${sha('a')}, now(), 'api', 'child_profile', ${randomUUID()})`,
    ).rejects.toThrow(/consents_subject_kind_check/);
    await expect(sql`update consents set subject_kind = 'household' where user_id = ${userId}`).rejects.toThrow(/consents_subject_kind_check/);
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
    await grantConsent(db, userId, 'health_data', HD, sha('a'), 'tap', clock);
    await expect(requireConsent(db, userId, 'health_data', clock)).resolves.toBeUndefined();
  });

  it('cascades with the user', async () => {
    const userId = await newUser();
    await grantConsent(db, userId, 'voice', 'v1', sha('a'), 'tap', clock);
    await sql`delete from users where id = ${userId}`;
    expect(await sql`select 1 from consents where user_id = ${userId}`).toHaveLength(0);
  });
});

const NOTICE_DIR = new URL('../../../docs/compliance/notices/', import.meta.url);
const NOTICE_TEXT = /<!-- notice-text:start -->\n\n([\s\S]*?)\n\n<!-- notice-text:end -->/;

describe('notice files', () => {
  it('every file in docs/compliance/notices declares the SHA-256 of its text, and is marked a draft (C-30)', () => {
    const files = readdirSync(NOTICE_DIR).filter((f) => f.endsWith('.md'));
    expect(files).toEqual(expect.arrayContaining(['health_data-v1.md', 'health_data-v2.md', 'health_data-v3.md', 'ai_health-v1.md']));
    for (const f of files) {
      const doc = readFileSync(new URL(f, NOTICE_DIR), 'utf8');
      const text = NOTICE_TEXT.exec(doc)?.[1];
      expect(text, f).toBeTruthy();
      expect(doc, f).toContain(`SHA-256 of the notice text: \`${sha(text!).toString('hex')}\``);
      expect(doc, f).toContain('Status: DRAFT wording, pending lawyer review (C-30)');
      expect(doc, f).not.toContain('\r');
    }
  });

  it.each([
    ['health_data', 'v3'],
    ['ai_health', 'v1'],
  ] as const)('%s is served from its %s file, with the hash declared there', (purpose, version) => {
    const doc = readFileSync(new URL(`${purpose}-${version}.md`, NOTICE_DIR), 'utf8');
    const notice = NOTICES[purpose]!;
    expect(notice.version).toBe(version);
    expect(notice.text).toBe(NOTICE_TEXT.exec(doc)![1]);
    expect(doc).toContain(`Version: \`${version}\``);
    expect(doc).toContain(`SHA-256 of the notice text: \`${sha(notice.text).toString('hex')}\``);
  });
});

describe('health_data notice v3 (N-7, C-12, M5 Step 7)', () => {
  const notice = NOTICES.health_data!;

  it('names religious and cultural dietary rules as covered (GDPR Art. 9)', () => {
    expect(notice.text).toMatch(/religious/i);
    expect(notice.text).toMatch(/cultural/i);
    expect(notice.text).toMatch(/allerg/i);
  });

  it('names the meals it keeps, plans and market lists, margin notes and the 30-day Pan conversations', () => {
    expect(notice.text).toContain(
      "It also keeps the meals you log, your weekly meal plans and market lists, your own notes on recipes (margin notes), which can show what you can't or won't eat, and your conversations with the Pan for 30 days unless you clear them sooner.",
    );
  });

  it('never claims HIPAA or medical-grade', () => {
    expect(notice.text).not.toMatch(/HIPAA|medical-grade/i);
  });

  it('a grant stores the notice version and sha256 in the ledger', async () => {
    const cookie = await signIn(app, mailer, `notice${++seq}@example.com`);
    const res = await app.inject({
      method: 'POST',
      url: '/me/consents',
      cookies: { kq_session: cookie },
      payload: { purpose: 'health_data', noticeVersion: notice.version },
    });
    expect(res.statusCode).toBe(201);
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies: { kq_session: cookie } })).json().id as string;
    const rows = await sql<{ notice_version: string; notice_sha256: Buffer }[]>`
      select notice_version, notice_sha256 from consents where user_id = ${userId} and purpose = 'health_data'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].notice_version).toBe('v3');
    expect(Buffer.from(rows[0].notice_sha256).equals(sha(notice.text))).toBe(true);
  });
});

describe('ai_health notice v1', () => {
  const notice = NOTICES.ai_health!;

  it('names the AI characters, meals and the scripted fallback', () => {
    expect(notice.text).toMatch(/AI characters/);
    expect(notice.text).toMatch(/meals/);
    expect(notice.text).toMatch(/written script/);
  });
});

describe('a grant under an older notice', () => {
  const PEANUT = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };

  it.each([
    ['the inline 2026-11-09 notice', '2026-11-09'],
    ['notice v1', 'v1'],
    ['notice v2', 'v2'],
  ])('health_data under %s no longer counts: writes are 403 and GET /me/consents asks again; a v3 grant restores them', async (_label, version) => {
    const cookie = await signIn(app, mailer, `stale${++seq}@example.com`);
    const cookies = { kq_session: cookie };
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies })).json().id as string;
    const old = 'Kitchen Quest can store your allergies, diet rules ...';
    await grantConsent(db, userId, 'health_data', version, sha(old), 'tap', clock);

    expect(await hasConsent(db, userId, 'health_data', clock)).toBe(false);
    const refused = await app.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: PEANUT, confirmed: true } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('consent_required');
    const stale = (await app.inject({ method: 'GET', url: '/me/consents', cookies })).json();
    expect(stale.needsReconsent).toEqual(['health_data']);
    expect(stale.consents.at(-1)).toMatchObject({ noticeVersion: version, withdrawnAt: null, current: false });

    clock = new Date(clock.getTime() + 60_000);
    const regrant = await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: HD } });
    expect(regrant.statusCode).toBe(201);
    expect(regrant.json().consent).toMatchObject({ noticeVersion: 'v3', current: true });
    const ok = await app.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: PEANUT, confirmed: true } });
    expect(ok.statusCode).toBe(201);
    const fresh = (await app.inject({ method: 'GET', url: '/me/consents', cookies })).json();
    expect(fresh.needsReconsent).toEqual([]);
    // The history keeps the old grant, ended as superseded.
    expect(fresh.consents.map((c: { noticeVersion: string; endedReason: string | null }) => [c.noticeVersion, c.endedReason])).toEqual([
      [version, 'superseded'],
      ['v3', null],
    ]);
  });

  it('an ai_health grant under the old inline version 2026-11-09 no longer counts', async () => {
    const cookie = await signIn(app, mailer, `stale${++seq}@example.com`);
    const cookies = { kq_session: cookie };
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies })).json().id as string;
    await grantConsent(db, userId, 'ai_health', '2026-11-09', sha('Let the AI characters see ...'), 'tap', clock);
    expect(await hasConsent(db, userId, 'ai_health', clock)).toBe(false);
    const stale = (await app.inject({ method: 'GET', url: '/me/consents', cookies })).json();
    expect(stale.needsReconsent).toEqual(['ai_health']);
    expect(stale.notices.ai_health.version).toBe('v1');

    clock = new Date(clock.getTime() + 60_000);
    const regrant = await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'ai_health', noticeVersion: 'v1' } });
    expect(regrant.statusCode).toBe(201);
    expect(await hasConsent(db, userId, 'ai_health', clock)).toBe(true);
    expect((await app.inject({ method: 'GET', url: '/me/consents', cookies })).json().needsReconsent).toEqual([]);
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

  it('withdraw health_data with delete removes messages and proposals', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    const memory = new MemoryHistory({ ttlMs: 60_000, max: 8 });
    const card = {
      kind: 'meal' as const,
      meal: { eatenOn: '2026-06-01', slot: 'lunch' as const, item: { kind: 'free' as const, description: 'peanut soup' } },
      summary: 'lunch: peanut soup',
      estimate: false,
      readback: [],
    };
    await db.transaction(async (tx) => {
      const c = await openConversation(tx, userId, null, clock);
      await appendMessages(tx, config.keyring, memory, userId, c.id, [{ role: 'player', text: 'peanut soup for lunch' }], true, clock);
      await createProposal(tx, config.keyring, { userId, conversationId: c.id, turnSeq: 1, card }, clock);
    });
    expect(await sql`select 1 from messages where user_id = ${userId}`).toHaveLength(1);

    const res = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
    expect(res.statusCode).toBe(204);
    expect(await sql`select 1 from messages where user_id = ${userId}`).toHaveLength(0);
    expect(await sql`select 1 from mentor_proposals where user_id = ${userId}`).toHaveLength(0);
    // The content-free conversation row is not health data (P-14) and stays.
    expect(await sql`select 1 from conversations where user_id = ${userId}`).toHaveLength(1);
  });

  it('after a keep, a later delete still erases the health data (Step 11 fix round 2: the Settings erase button)', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    const rowId = randomUUID();
    await db.insert(rules).values({ id: rowId, userId, sealed: await sealFor(db, config.keyring, { table: 'rules', userId, rowId }, { t: 1 }) });
    const keep = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'keep' } });
    expect(keep.statusCode).toBe(204);
    expect(await sql`select 1 from rules where user_id = ${userId}`).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
    expect(del.statusCode).toBe(204);
    expect(await sql`select 1 from rules where user_id = ${userId}`).toHaveLength(0);
    expect((await auditFor(userId)).map((r) => r.action)).toEqual(['auth.sign_in', 'consent.grant', 'consent.withdraw', 'health_data.delete']);
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

  it('withdraw-with-delete with nothing granted and nothing stored writes no health_data.delete event', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const res = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
    expect(res.statusCode).toBe(204);
    expect((await auditFor(u.id as string)).map((r) => r.action)).toEqual(['auth.sign_in']);
  });

  it('withdraw-with-delete racing an account delete: 401, and no audit row with the raw user id (I-1)', async () => {
    const email = `route${++seq}@example.com`;
    const cookies = { kq_session: await signIn(app, mailer, email) };
    const [u] = await sql`select id from users where email = ${email}`;
    const userId = u.id as string;
    await app.inject({ method: 'POST', url: '/me/consents', cookies, payload: { purpose: 'health_data', noticeVersion: current.version } });
    const blocker = await sql.reserve();
    try {
      // An account delete in flight: the user row (and its cascade) is gone but not yet committed.
      await blocker`begin`;
      await blocker`delete from users where id = ${userId}`;
      const withdrawing = app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies, payload: { healthData: 'delete' } });
      await waitForLockWaiters(1);
      await blocker`select audit_pseudonymize(${userId}::uuid, decode(${config.pseudonymKey.bytes.toString('hex')}, 'hex'))`;
      await blocker`commit`;
      const res = await withdrawing;
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
    expect(await auditFor(userId)).toEqual([]);
  });

  it('withdrawing a purpose that was never granted is a quiet no-op', async () => {
    const cookies = { kq_session: await signIn(app, mailer, `route${++seq}@example.com`) };
    expect((await app.inject({ method: 'DELETE', url: '/me/consents/voice', cookies, payload: {} })).statusCode).toBe(204);
  });
});
