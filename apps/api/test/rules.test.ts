import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IngredientGraph } from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { sealFor } from '../src/crypto/userkeys.js';
import { auditEvents, rules, selfReadCounts } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');

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
  app = await buildApp({ config, db, mailer, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

const grantHealth = async (cookie: string) => {
  const res = await call(cookie, {
    method: 'POST',
    url: '/me/consents',
    payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
  });
  expect(res.statusCode).toBe(201);
};

/** A signed-in user with `health_data` consent. */
const player = async () => {
  const cookie = await signIn(app, mailer, `rules${++seq}@example.com`);
  await grantHealth(cookie);
  return cookie;
};

const PEANUT = { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const DAIRY = { target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance', note: 'lactose' };

const list = (cookie: string) => call(cookie, { method: 'GET', url: '/rules' });
const post = (cookie: string, payload: unknown) => call(cookie, { method: 'POST', url: '/rules', payload: payload as object });
const put = (cookie: string, id: string, payload: unknown) =>
  call(cookie, { method: 'PUT', url: `/rules/${id}`, payload: payload as object });
const del = (cookie: string, id: string) => call(cookie, { method: 'DELETE', url: `/rules/${id}` });

const userIdOf = async (cookie: string) => {
  const res = await call(cookie, { method: 'GET', url: '/me' });
  return res.json().id as string;
};
const storedCount = async (userId?: string) =>
  (userId ? await db.select().from(rules).where(eq(rules.userId, userId)) : await db.select().from(rules)).length;

describe('GET /ingredients/search', () => {
  it('finds ingredients by name or alias without signing in', async () => {
    const res = await app.inject({ method: 'GET', url: '/ingredients/search?q=ground' });
    expect(res.statusCode).toBe(200);
    expect(res.json().results).toContainEqual({ id: 'peanut', name: 'peanut', matched: 'groundnut' });
  });

  it("'scal' finds green onion via its alias", async () => {
    const graph = IngredientGraph.fromData({
      ingredients: [
        { id: 'green_onion', name: 'green onion', aliases: ['scallion', 'spring onion'] },
        { id: 'onion', name: 'onion' },
      ],
    });
    const fixtureApp = await buildApp({ config, db, mailer, now: () => NOW, logger: false, catalog: { graph, substitutions: [] } });
    try {
      const res = await fixtureApp.inject({ method: 'GET', url: '/ingredients/search?q=scal' });
      expect(res.json()).toEqual({ results: [{ id: 'green_onion', name: 'green onion', matched: 'scallion' }] });
    } finally {
      await fixtureApp.close();
    }
  });

  it('an empty or missing query returns no results', async () => {
    for (const url of ['/ingredients/search?q=', '/ingredients/search', '/ingredients/search?q=%20%20']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.json(), url).toEqual({ results: [] });
    }
  });

  it('rejects an over-long or repeated query', async () => {
    for (const url of [`/ingredients/search?q=${'a'.repeat(101)}`, '/ingredients/search?q=a&q=b']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
  });
});

describe('/rules', () => {
  it('requires sign-in', async () => {
    for (const [method, url] of [
      ['GET', '/rules'],
      ['POST', '/rules'],
      ['PUT', '/rules/00000000-0000-4000-8000-000000000000'],
      ['DELETE', '/rules/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      const res = await app.inject({ method, url, ...(method === 'POST' || method === 'PUT' ? { payload: {} } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it('round-trips create, list, update and delete, auditing writes without content', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    expect((await list(c)).json()).toEqual({ rules: [] });

    const created = await post(c, { rule: PEANUT, confirmed: true });
    expect(created.statusCode).toBe(201);
    const rule = created.json().rule;
    expect(rule).toEqual({ ...PEANUT, id: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    const [row] = await db.select().from(rules).where(eq(rules.id, rule.id));
    expect(row.userId).toBe(uid);

    const second = (await post(c, { rule: DAIRY, confirmed: true })).json().rule;
    expect((await list(c)).json()).toEqual({ rules: [rule, second] });

    const changed = { ...PEANUT, severity: 'allergy', phase: { start: '2026-11-01', end: '2026-12-01' } };
    const updated = await put(c, rule.id, { rule: changed, confirmed: true });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ rule: { ...changed, id: rule.id } });
    expect((await list(c)).json()).toEqual({ rules: [{ ...changed, id: rule.id }, second] });

    expect((await del(c, rule.id)).statusCode).toBe(204);
    expect((await list(c)).json()).toEqual({ rules: [second] });
    expect((await del(c, rule.id)).statusCode).toBe(404);

    const events = await db
      .select({ action: auditEvents.action, target: auditEvents.target, actorId: auditEvents.actorId })
      .from(auditEvents)
      .where(and(eq(auditEvents.subjectUserId, uid)));
    const ruleEvents = events.filter((e) => e.action.startsWith('rules.'));
    expect(ruleEvents).toEqual([
      { action: 'rules.create', target: rule.id, actorId: uid },
      { action: 'rules.create', target: second.id, actorId: uid },
      { action: 'rules.update', target: rule.id, actorId: uid },
      { action: 'rules.delete', target: rule.id, actorId: uid },
    ]);
    // Reads are not logged per row (C-5).
    expect(events.some((e) => /read|list/.test(e.action))).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/peanut|milk|lactose/);
  });

  it('missing or false confirmed → 400 confirmation_required, nothing stored', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    for (const payload of [{ rule: PEANUT }, { rule: PEANUT, confirmed: false }, { rule: PEANUT, confirmed: 'true' }]) {
      const res = await post(c, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirmation_required');
    }
    expect(await storedCount(uid)).toBe(0);

    const id = (await post(c, { rule: PEANUT, confirmed: true })).json().rule.id;
    const res = await put(c, id, { rule: DAIRY });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('confirmation_required');
    expect((await list(c)).json().rules).toEqual([{ ...PEANUT, id }]);
  });

  it('core-rejected rules → 400 bad_request with core problems, nothing stored', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const cases: [unknown, RegExp][] = [
      [{ ...PEANUT, target: { kind: 'ingredient', ids: ['unicorn_horn'] } }, /target id "unicorn_horn" is not in the ingredient graph/],
      [{ ...PEANUT, phase: { start: '2026-12-01', end: '2026-11-30' } }, /phase/],
      [{ ...PEANUT, severity: 'Allergy' }, /severity "Allergy"/],
      [{ ...PEANUT, type: 'shun' }, /type "shun"/],
      [{ ...PEANUT, type: 'limit' }, /limit rule has no limit/],
    ];
    for (const [rule, problem] of cases) {
      const res = await post(c, { rule, confirmed: true });
      expect(res.statusCode, JSON.stringify(rule)).toBe(400);
      const err = res.json().error;
      expect(err.code).toBe('bad_request');
      expect(err.details.problems.some((p: string) => problem.test(p)), JSON.stringify(err.details.problems)).toBe(true);
    }
    expect(await storedCount(uid)).toBe(0);

    // The same on update: the stored rule is unchanged.
    const id = (await post(c, { rule: PEANUT, confirmed: true })).json().rule.id;
    const res = await put(c, id, { rule: { ...PEANUT, severity: 'Allergy' }, confirmed: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.problems[0]).toMatch(/severity/);
    expect((await list(c)).json().rules).toEqual([{ ...PEANUT, id }]);
  });

  it('rejects a body that is not a rule shape', async () => {
    const c = await player();
    for (const payload of [{ confirmed: true }, { rule: 'peanut', confirmed: true }, { rule: { ...PEANUT, id: 'mine' }, confirmed: true }]) {
      const res = await post(c, payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
    }
    expect(await storedCount(await userIdOf(c))).toBe(0);
  });

  it('stores no plaintext: the sealed column and the row hold no ingredient id', async () => {
    const c = await player();
    const id = (await post(c, { rule: { ...PEANUT, note: 'peanut butter too' }, confirmed: true })).json().rule.id;
    const [row] = await sql<{ sealed: Buffer }[]>`select sealed from rules where id = ${id}`;
    expect(row.sealed.includes(Buffer.from('peanut'))).toBe(false);
    expect(row.sealed.toString('latin1')).not.toMatch(/peanut|anaphylactic|avoid/i);
  });

  it("another user's rule id → 404 on PUT and DELETE and absent from their list", async () => {
    const a = await player();
    const b = await player();
    const id = (await post(a, { rule: PEANUT, confirmed: true })).json().rule.id;

    expect((await list(b)).json()).toEqual({ rules: [] });
    const p = await put(b, id, { rule: DAIRY, confirmed: true });
    expect(p.statusCode).toBe(404);
    expect(p.json().error.code).toBe('not_found');
    const d = await del(b, id);
    expect(d.statusCode).toBe(404);
    expect(d.json().error.code).toBe('not_found');

    expect((await list(a)).json().rules).toEqual([{ ...PEANUT, id }]);
    // Not-a-uuid ids are 404s too, never a database error.
    expect((await put(a, 'peanut', { rule: DAIRY, confirmed: true })).statusCode).toBe(404);
    expect((await del(a, 'peanut')).statusCode).toBe(404);
  });

  it("validates against the caller's own rules only: problems name only their rule ids", async () => {
    const a = await player();
    const b = await player();
    const aId = await userIdOf(a);
    const bRule = (await post(b, { rule: PEANUT, confirmed: true })).json().rule.id;
    // A stored rule of A's that core now rejects (as if its ingredient left the data).
    const badId = randomUUID();
    const bad = { ...PEANUT, target: { kind: 'ingredient', ids: ['retired_ingredient'] } };
    await db.insert(rules).values({ id: badId, userId: aId, sealed: await sealFor(db, config.keyring, { table: 'rules', userId: aId, rowId: badId }, bad) });

    const res = await post(a, { rule: DAIRY, confirmed: true });
    expect(res.statusCode).toBe(400);
    const problems: string[] = res.json().error.details.problems;
    expect(problems).toEqual([`Rule "${badId}": target id "retired_ingredient" is not in the ingredient graph`]);
    expect(JSON.stringify(problems)).not.toContain(bRule);

    // B's rules never see A's bad rule.
    expect((await post(b, { rule: DAIRY, confirmed: true })).statusCode).toBe(201);
  });

  it('rejects unknown keys inside target, limit and phase; values stay core\'s', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    for (const rule of [
      { ...PEANUT, target: { kind: 'ingredient', ids: ['peanut'], diagnosis: 'x' } },
      { ...PEANUT, type: 'limit', limit: { amount: 1, unit: 'g', per: 'day', extra: 'x' } },
      { ...PEANUT, phase: { start: '2026-11-01', clinic: 'x' } },
    ]) {
      const res = await post(c, { rule, confirmed: true });
      expect(res.statusCode, JSON.stringify(rule)).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
      expect(res.json().error.details).not.toHaveProperty('problems');
    }
    // A non-object target is not a shape error: core reports it.
    const core = await post(c, { rule: { ...PEANUT, target: 'peanut' }, confirmed: true });
    expect(core.statusCode).toBe(400);
    expect(core.json().error.details.problems[0]).toMatch(/target must be an object/);
    expect(await storedCount(uid)).toBe(0);
    // The known keys still pass.
    const ok = { ...PEANUT, type: 'limit', limit: { amount: 1, unit: 'g', per: 'serving' }, phase: { start: '2026-11-01', end: '2026-12-01', journeyId: 'j1' } };
    expect((await post(c, { rule: ok, confirmed: true })).statusCode).toBe(201);
  });

  // N-7: every free-text field is capped at its documented max (data-inventory.md §3.13).
  it('caps the free-text fields note (500), limit.unit (32) and phase.journeyId (64)', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const limited = (unit: string) => ({ ...PEANUT, type: 'limit', limit: { amount: 1, unit, per: 'day' } });
    const phased = (journeyId: string) => ({ ...PEANUT, phase: { start: '2026-11-01', journeyId } });
    for (const [rule, path] of [
      [{ ...PEANUT, note: 'x'.repeat(501) }, 'rule.note'],
      [limited('g'.repeat(33)), 'rule.limit.unit'],
      [phased('j'.repeat(65)), 'rule.phase.journeyId'],
    ] as const) {
      const res = await post(c, { rule, confirmed: true });
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error.code).toBe('bad_request');
      expect(res.json().error.details.map((d: { path: string }) => d.path)).toContain(path);
    }
    expect(await storedCount(uid)).toBe(0);
    for (const rule of [{ ...PEANUT, note: 'x'.repeat(500) }, limited('g'.repeat(32)), phased('j'.repeat(64))]) {
      expect((await post(c, { rule, confirmed: true })).statusCode).toBe(201);
    }
  });

  it('counts GET /rules per user and day, content-free, without audit events (C-5)', async () => {
    const a = await player();
    const b = await player();
    const aId = await userIdOf(a);
    await post(a, { rule: PEANUT, confirmed: true });
    for (let i = 0; i < 3; i++) expect((await list(a)).statusCode).toBe(200);
    await list(b);
    const rows = await db.select().from(selfReadCounts).where(eq(selfReadCounts.userId, aId));
    expect(rows).toEqual([{ userId: aId, resource: 'rules', day: '2026-11-09', count: 3 }]);
    const reads = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, aId));
    expect(reads.filter((e) => !e.action.startsWith('rules.') && !e.action.startsWith('consent.') && !e.action.startsWith('auth.'))).toEqual([]);
    expect(reads.some((e) => e.action.startsWith('rules.read'))).toBe(false);
  });
});

describe('/rules consent gate (C-11)', () => {
  it('POST and PUT without health_data consent → 403 consent_required, nothing stored', async () => {
    const c = await signIn(app, mailer, `noconsent${++seq}@example.com`);
    const uid = await userIdOf(c);
    const res = await post(c, { rule: PEANUT, confirmed: true });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('consent_required');
    const p = await put(c, '00000000-0000-4000-8000-000000000000', { rule: PEANUT, confirmed: true });
    expect(p.statusCode).toBe(403);
    expect(await storedCount(uid)).toBe(0);
    // Reading needs no consent: an empty list.
    expect((await list(c)).json()).toEqual({ rules: [] });
  });

  it('a withdraw-with-delete racing an in-flight POST leaves no rule stored', async () => {
    const c = await player();
    const uid = await userIdOf(c);
    const lockWaiters = async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)[0].n;
    const until = async (n: number) => {
      for (let i = 0; i < 500; i++) {
        if ((await lockWaiters()) >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`never saw ${n} lock waiters`);
    };
    // Hold the POST at its INSERT, after it has passed the consent checks.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const blocker = sql.begin(async (tx) => {
      await tx`lock table rules in share mode`;
      await gate;
    });
    const posting = post(c, { rule: PEANUT, confirmed: true });
    await until(1);
    const withdrawing = call(c, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } });
    await until(2);
    release();
    await blocker;
    const [p, w] = await Promise.all([posting, withdrawing]);
    expect(p.statusCode).toBe(201);
    expect(w.statusCode).toBe(204);
    expect(await storedCount(uid)).toBe(0);
    expect((await post(c, { rule: PEANUT, confirmed: true })).statusCode).toBe(403);
  });

  it('withdrawing consent (keep) stops writes; the rules stay readable and deletable', async () => {
    const c = await player();
    const id = (await post(c, { rule: PEANUT, confirmed: true })).json().rule.id;
    const w = await call(c, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } });
    expect(w.statusCode).toBe(204);

    expect((await post(c, { rule: DAIRY, confirmed: true })).statusCode).toBe(403);
    expect((await put(c, id, { rule: DAIRY, confirmed: true })).statusCode).toBe(403);
    expect((await list(c)).json().rules).toEqual([{ ...PEANUT, id }]);
    expect((await del(c, id)).statusCode).toBe(204);
    expect((await list(c)).json().rules).toEqual([]);
  });
});

describe('log redaction (C-9)', () => {
  it('a "peanut" search and a peanut rule POST leave no "peanut" in the log', async () => {
    const logs = captureLogs();
    const logged = await buildApp({ config, db, mailer, now: () => NOW, logger: logs.logger });
    try {
      const cookie = await signIn(logged, mailer, `logs${++seq}@example.com`);
      const cookies = { kq_session: cookie };
      const consent = await logged.inject({
        method: 'POST',
        url: '/me/consents',
        cookies,
        payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version },
      });
      expect(consent.statusCode).toBe(201);
      const res = await Promise.all([
        logged.inject({ method: 'GET', url: '/ingredients/search?q=peanut' }),
        logged.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: { ...PEANUT, note: 'peanut' }, confirmed: true } }),
        logged.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: { ...PEANUT, severity: 'peanut' }, confirmed: true } }),
        logged.inject({ method: 'POST', url: '/rules', cookies, payload: { rule: PEANUT } }),
      ]);
      expect(res.map((r) => r.statusCode)).toEqual([200, 201, 400, 400]);
      expect(res[0].json().results).toContainEqual({ id: 'peanut', name: 'peanut', matched: 'peanut' });
      const id = res[1].json().rule.id;
      expect((await logged.inject({ method: 'GET', url: '/rules', cookies })).statusCode).toBe(200);
      expect((await logged.inject({ method: 'PUT', url: `/rules/${id}`, cookies, payload: { rule: PEANUT, confirmed: true } })).statusCode).toBe(200);
      expect((await logged.inject({ method: 'DELETE', url: `/rules/${id}`, cookies })).statusCode).toBe(204);

      expect(logs.lines().length).toBeGreaterThan(10);
      expect(logs.text()).not.toMatch(/peanut/i);
      expect(logs.text()).toContain('/ingredients/search');
    } finally {
      await logged.close();
    }
  });
});

describe('catalog (boot data)', () => {
  const dirWith = (ingredients: unknown, substitutions: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'kq-catalog-'));
    writeFileSync(join(dir, 'ingredients.json'), typeof ingredients === 'string' ? ingredients : JSON.stringify(ingredients));
    writeFileSync(join(dir, 'substitutions.json'), JSON.stringify(substitutions));
    return dir;
  };

  it('loads the repository data', () => {
    const { graph, substitutions } = loadCatalog();
    expect(graph.has('peanut')).toBe(true);
    expect(substitutions.length).toBeGreaterThan(0);
  });

  it('fails loudly on bad data, naming the file', () => {
    const ok = { ingredients: [{ id: 'garlic', name: 'garlic' }] };
    expect(() => loadCatalog(dirWith('{not json', []))).toThrow(/ingredients\.json is not valid JSON/);
    expect(() => loadCatalog(dirWith({ items: [] }, []))).toThrow(/ingredients\.json must be an object/);
    expect(() => loadCatalog(dirWith({ ingredients: [{ id: 'a', name: 'a', isA: ['ghost'] }] }, []))).toThrow(
      /ingredients\.json.*ghost/,
    );
    expect(() => loadCatalog(dirWith(ok, [{ from: 'garlic', to: 'ghost_oil' }]))).toThrow(/substitutions\.json.*ghost_oil/);
    expect(() => loadCatalog(dirWith(ok, {}))).toThrow(/substitutions\.json must be an array/);
    expect(() => loadCatalog(dirWith(ok, [null]))).toThrow(/substitutions\.json must hold only objects/);
    expect(() => loadCatalog(join(tmpdir(), 'kq-no-such-dir'))).toThrow(/cannot read .*ingredients\.json/);
  });
});
