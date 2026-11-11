import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { lockSignInEmail } from '../src/auth/email-lock.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { sealFor } from '../src/crypto/userkeys.js';
import { auditEvents, rules } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { createRuleIn, deleteRuleIn, lockUserRules, MAX_RULES_PER_USER, updateRuleIn } from '../src/rules/service.js';
import { MAX_RULES_PER_USER as ROUTES_MAX } from '../src/rules/routes.js';
import { loadRules, ruleSealContext, type StoredRule } from '../src/rules/store.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const deps = { keyring: config.keyring, catalog: defaultCatalog() };

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const PEANUT: StoredRule = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const DAIRY: StoredRule = { target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' };

/** A signed-in user; with `consent`, also granted `health_data`. Returns the cookie and user id. */
const user = async (consent = true) => {
  const cookie = await signIn(app, mailer, `svc${++seq}@example.com`);
  const cookies = { kq_session: cookie };
  if (consent) {
    const res = await app.inject({
      method: 'POST',
      url: '/me/consents',
      cookies,
      payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
    });
    expect(res.statusCode).toBe(201);
  }
  const id = (await app.inject({ method: 'GET', url: '/me', cookies })).json().id as string;
  return { cookie, id };
};

const countRules = async (userId: string) => (await db.select().from(rules).where(eq(rules.userId, userId))).length;

describe('rules service', () => {
  it('re-exports the cap from the routes', () => {
    expect(MAX_RULES_PER_USER).toBe(200);
    expect(ROUTES_MAX).toBe(MAX_RULES_PER_USER);
  });

  it('createRuleIn stores, audits and returns the rule with its row id', async () => {
    const u = await user();
    const rule = await db.transaction((tx) => createRuleIn(tx, deps, u.id, PEANUT, NOW, 'req-1'));
    expect(rule).toEqual({ ...PEANUT, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await loadRules(db, config.keyring, u.id)).toEqual([rule]);
    const events = await db.select().from(auditEvents).where(eq(auditEvents.target, rule.id));
    expect(events.map((e) => [e.action, e.requestId])).toEqual([['rules.create', 'req-1']]);
  });

  it('createRuleIn for a user that no longer exists → 401, never 403', async () => {
    const u = await user(false);
    const del = await app.inject({ method: 'DELETE', url: '/me', cookies: { kq_session: u.cookie }, payload: { confirm: 'delete my account' } });
    expect(del.statusCode).toBe(204);
    for (const id of [u.id, randomUUID()]) {
      await expect(db.transaction((tx) => createRuleIn(tx, deps, id, PEANUT, NOW))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
      await expect(db.transaction((tx) => updateRuleIn(tx, deps, id, randomUUID(), PEANUT, NOW))).rejects.toMatchObject({
        status: 401,
        code: 'unauthorized',
      });
      await expect(db.transaction((tx) => deleteRuleIn(tx, id, randomUUID(), NOW))).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    }
  });

  it('createRuleIn without consent → 403 and nothing stored', async () => {
    const u = await user(false);
    await expect(db.transaction((tx) => createRuleIn(tx, deps, u.id, PEANUT, NOW))).rejects.toMatchObject({ status: 403, code: 'consent_required' });
    await expect(db.transaction((tx) => updateRuleIn(tx, deps, u.id, randomUUID(), PEANUT, NOW))).rejects.toMatchObject({
      status: 403,
      code: 'consent_required',
    });
    expect(await countRules(u.id)).toBe(0);
  });

  it('createRuleIn rejects a core-invalid rule → 400 bad_request with problems, nothing stored', async () => {
    const u = await user();
    const bad = { ...PEANUT, severity: 'Allergy' } as unknown as StoredRule;
    await expect(db.transaction((tx) => createRuleIn(tx, deps, u.id, bad, NOW))).rejects.toMatchObject({
      status: 400,
      code: 'bad_request',
      details: { problems: [expect.stringMatching(/severity "Allergy"/)] },
    });
    expect(await countRules(u.id)).toBe(0);
  });

  it('updateRuleIn changes only the caller\'s rule; another user\'s id → 404', async () => {
    const a = await user();
    const b = await user();
    const rule = await db.transaction((tx) => createRuleIn(tx, deps, a.id, PEANUT, NOW));
    await expect(db.transaction((tx) => updateRuleIn(tx, deps, b.id, rule.id, DAIRY, NOW))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const { rule: updated, version } = await db.transaction((tx) => updateRuleIn(tx, deps, a.id, rule.id, DAIRY, NOW));
    expect(updated).toEqual({ ...DAIRY, id: rule.id });
    expect(version).toBe(2);
    expect(await loadRules(db, config.keyring, a.id)).toEqual([updated]);
  });

  it('deleteRuleIn needs no consent; another user\'s id → 404', async () => {
    const a = await user();
    const b = await user(false);
    const rule = await db.transaction((tx) => createRuleIn(tx, deps, a.id, PEANUT, NOW));
    await expect(db.transaction((tx) => deleteRuleIn(tx, b.id, rule.id, NOW))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    const w = await app.inject({ method: 'DELETE', url: '/me/consents/health_data', cookies: { kq_session: a.cookie }, payload: { healthData: 'keep' } });
    expect(w.statusCode).toBe(204);
    await db.transaction((tx) => deleteRuleIn(tx, a.id, rule.id, NOW));
    expect(await countRules(a.id)).toBe(0);
  });

  it('accepts locks its caller already holds (re-entrant within one transaction)', async () => {
    const u = await user();
    const rule = await db.transaction(async (tx) => {
      await lockUserRules(tx, u.id);
      await lockUserRules(tx, u.id);
      return createRuleIn(tx, deps, u.id, PEANUT, NOW);
    });
    expect(await countRules(u.id)).toBe(1);
    expect(rule.id).toBeTruthy();
  });

  it('lockUserRules holds other writers of the same user until commit, not other users', async () => {
    const a = await user();
    const b = await user();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const held = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      await lockUserRules(tx, a.id);
      locked();
      await gate;
    });
    await held;
    // Another user's write is not held.
    await db.transaction((tx) => createRuleIn(tx, deps, b.id, PEANUT, NOW));
    let done = false;
    const writing = db.transaction((tx) => createRuleIn(tx, deps, a.id, PEANUT, NOW)).then(() => (done = true));
    let waiting = false;
    for (let i = 0; i < 500 && !waiting; i++) {
      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted
          and database = (select oid from pg_database where datname = current_database())`;
      waiting = n >= 1;
      if (!waiting) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBe(true);
    expect(done).toBe(false);
    release();
    await holder;
    await writing;
    expect(await countRules(a.id)).toBe(1);
  });

  it('lockUserRules takes the two-key advisory lock in the rules namespace, apart from the sign-in-email lock', async () => {
    const u = await user();
    const held = await db.transaction(async (tx) => {
      await lockUserRules(tx, u.id);
      await lockSignInEmail(tx, u.id);
      return sql<{ classid: number; objsubid: number }[]>`
        select classid::int as classid, objsubid::int as objsubid from pg_locks
        where locktype = 'advisory' and granted
          and database = (select oid from pg_database where datname = current_database())
        order by classid`;
    });
    // objsubid 2 is the two-int4-key form; classid is the namespace.
    expect(held).toEqual([
      { classid: ADVISORY_LOCK.signInEmail, objsubid: 2 },
      { classid: ADVISORY_LOCK.rules, objsubid: 2 },
    ]);
    expect(ADVISORY_LOCK.rules).not.toBe(ADVISORY_LOCK.signInEmail);
  });

  it('the service parses the rule shape itself: an extra key is rejected, nothing stored', async () => {
    const u = await user();
    const rule = await db.transaction((tx) => createRuleIn(tx, deps, u.id, PEANUT, NOW));
    const extras = [
      { ...PEANUT, diagnosis: 'x' },
      { ...PEANUT, target: { kind: 'ingredient', ids: ['peanut'], clinic: 'x' } },
      { ...PEANUT, note: 'x'.repeat(501) },
    ] as unknown as StoredRule[];
    for (const value of extras) {
      await expect(db.transaction((tx) => createRuleIn(tx, deps, u.id, value, NOW))).rejects.toBeInstanceOf(ZodError);
      await expect(db.transaction((tx) => updateRuleIn(tx, deps, u.id, rule.id, value, NOW))).rejects.toBeInstanceOf(ZodError);
    }
    expect(await loadRules(db, config.keyring, u.id)).toEqual([rule]);
  });

  it(`two concurrent createRuleIn at ${MAX_RULES_PER_USER - 1} rules: exactly one succeeds`, async () => {
    const u = await user();
    const values = [];
    for (let i = 0; i < MAX_RULES_PER_USER - 1; i++) {
      const rowId = randomUUID();
      values.push({ id: rowId, userId: u.id, sealed: await sealFor(db, config.keyring, ruleSealContext(u.id, rowId), PEANUT) });
    }
    await db.insert(rules).values(values);
    const results = await Promise.allSettled([
      db.transaction((tx) => createRuleIn(tx, deps, u.id, DAIRY, NOW)),
      db.transaction((tx) => createRuleIn(tx, deps, u.id, DAIRY, NOW)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 400, code: 'too_many_rules' });
    expect(await countRules(u.id)).toBe(MAX_RULES_PER_USER);
  });
});
