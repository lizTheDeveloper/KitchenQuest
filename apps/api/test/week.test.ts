// M5 Step 6: sealed weekly plans and market runs (H-11, Ruling 18), dated pantry ticks (Ruling 16), C20 recompute.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MarketRunView, Plan, PlanItemCheck } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { auditEvents, marketRuns, mealPlans } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { loadPantry } from '../src/pantry/store.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { restorePlanIn } from '../src/week/plan-service.js';
import { WEEK_REQUESTS_PER_MINUTE } from '../src/week/routes.js';
import { loadPlan, loadRunById } from '../src/week/store.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { defaultLoopContent } from '../src/catalog.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z'); // a Tuesday
const TODAY = '2026-11-10';
const MONDAY = '2026-11-09'; // the plan week with no market days set (Ruling 11)
const SATURDAY = '2026-11-07'; // the plan week for a Saturday market
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const COCONUT = { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' };

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
const build = async (logger: Parameters<typeof buildApp>[0]['logger'] = false, at: Date = NOW) => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => at, logger });
};
/** Rebuilds the app on another clock (the database and the players stay). */
const rebuildAt = async (at: Date) => {
  await app.close();
  await build(false, at);
};
beforeEach(async () => {
  await build();
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) => app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

async function player(opts: { consent?: boolean } = {}): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `week${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  if (opts.consent !== false) {
    const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
    expect(res.statusCode).toBe(201);
  }
  return { cookie, id };
}
const addRule = async (cookie: string, rule: unknown = COCONUT) => {
  const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
};
const planOf = (weekStart: string, items: Plan['items']): Plan => ({ weekStart, items, hard: false, slot: 'unanswered' });
const dish = (slug: string, day = 0) => ({ day, kind: 'dish' as const, slug, servings: 2 });
const OMIT = Symbol('omit confirmed');
const put = (cookie: string, plan: Plan, confirmed: unknown = true, url = `/plans/${plan.weekStart}`) =>
  call(cookie, { method: 'PUT', url, payload: { plan, ...(confirmed === OMIT ? {} : { confirmed }) } });
const current = async (cookie: string) => {
  const res = await call(cookie, { method: 'GET', url: '/plans/current' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ plan: (Plan & { id: string }) | null; weekStart: string; checks: PlanItemCheck[] }>();
};
const open = async (cookie: string, weekStart = MONDAY) => {
  const res = await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<MarketRunView>();
};
const tick = (cookie: string, runId: string, key: string, ticked: boolean) =>
  call(cookie, { method: 'POST', url: `/market-runs/${runId}/ticks`, payload: { key, ticked } });
const finish = (cookie: string, runId: string, confirmed: unknown = true) =>
  call(cookie, { method: 'POST', url: `/market-runs/${runId}/finish`, payload: confirmed === OMIT ? {} : { confirmed } });
const row = (run: MarketRunView, name: string) => {
  const r = run.items.find((i) => i.name === name);
  if (!r) throw new Error(`no row "${name}" in ${run.items.map((i) => i.name).join(', ')}`);
  return r;
};
const pantryAdd = async (cookie: string, items: { name: string; ingredientId: string | null }[]) => {
  const res = await call(cookie, { method: 'POST', url: '/pantry/changes', payload: { add: items, removeNames: [], removeIds: [], confirmed: true } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ addedIds: string[] }>().addedIds;
};

describe('plans', () => {
  it('a plan round-trips sealed: meal_plans.sealed holds no slug in plaintext', async () => {
    const p = await player();
    const plan = planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 3)]);
    const res = await put(p.cookie, plan);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ plan: Plan & { id: string }; checks: PlanItemCheck[] }>();
    expect(body.plan).toEqual({ ...plan, id: expect.any(String) });
    expect(body.checks.map((c) => c.status)).toEqual(['ok', 'ok']);
    const got = await current(p.cookie);
    expect(got).toEqual({ plan: { ...plan, id: body.plan.id }, weekStart: MONDAY, checks: body.checks });

    const [stored] = await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id));
    expect(stored.weekStart).toBe(MONDAY);
    for (const word of ['parippu', 'onigiri', 'india', 'servings', 'dish']) {
      expect(stored.sealed.toString('latin1')).not.toContain(word);
      const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from meal_plans r where position(${word} in r::text) > 0`;
      expect(n, word).toBe(0);
    }
    // A second save replaces the week's plan in place (one row per week, the id kept).
    const again = await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI, 1)]));
    expect(again.json<{ plan: { id: string } }>().plan.id).toBe(body.plan.id);
    expect(await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id))).toHaveLength(1);
    // GET counts a self-read 'plans' (C-5).
    const [{ n }] = await sql<{ n: number }[]>`select coalesce(sum(count), 0)::int as n from self_read_counts where user_id = ${p.id} and resource = 'plans'`;
    expect(n).toBe(1);
  });

  it('M5 final m1: an offered week keeps its pinned offer (sealed, round-tripped); a pin on any other week is plan_invalid', async () => {
    const p = await player();
    const offered: Plan = { ...planOf(MONDAY, [dish(PARIPPU, 0)]), slot: 'offered', offer: { technique: 'tempering', recipe: PARIPPU } };
    const res = await put(p.cookie, offered);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ plan: Plan }>().plan).toEqual({ ...offered, id: expect.any(String) });
    expect((await current(p.cookie)).plan).toEqual({ ...offered, id: expect.any(String) });
    const [stored] = await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id));
    expect(stored.sealed.toString('latin1')).not.toContain('tempering');
    const bad = await put(p.cookie, { ...planOf(MONDAY, []), offer: { technique: 'tempering', recipe: PARIPPU } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string; details: { problems: string[] } } }>().error.details.problems).toContain('plan: offer is only kept on an offered week');
  });

  it('PUT /plans needs confirmed: true; a blocked dish → 400 plan_invalid naming it; a ❓ dish saves and reads back as unverified', async () => {
    const p = await player();
    for (const confirmed of [OMIT, false, 'yes']) {
      const res = await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]), confirmed);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('confirmation_required');
    }
    await addRule(p.cookie);
    const blocked = await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 2), dish(ONIGIRI, 3)]));
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().error).toMatchObject({ code: 'plan_invalid', details: { problems: [`blocked: ${PARIPPU}`] } });
    expect(await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id))).toEqual([]);

    // Onigiri is ❓ for a coconut rule (soy sauce, nori: check the label): it saves, and is never shown as ✅.
    const ok = await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI, 3)]));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json<{ checks: PlanItemCheck[] }>().checks.map((c) => c.status)).toEqual(['unverified']);
    expect((await current(p.cookie)).checks.map((c) => c.status)).toEqual(['unverified']);
  });

  it('rejects, as plan_invalid, a sacred or unknown slug, too many items and a URL that is not the plan week', async () => {
    const p = await player();
    const bad = async (plan: Plan, url?: string) => {
      const res = await put(p.cookie, plan, true, url);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error.code).toBe('plan_invalid');
      return res.json<{ error: { details: { problems: string[] } } }>().error.details.problems;
    };
    expect(await bad(planOf(MONDAY, [dish('nowhere/never/stone-soup')]))).toEqual(['plan: item 0: unknown recipe']);
    expect(await bad(planOf(MONDAY, Array.from({ length: 22 }, (_, i) => dish(ONIGIRI, i % 7))))).toContain('plan: more than 21 items');
    expect(await bad(planOf(MONDAY, [dish(ONIGIRI)]), `/plans/${TODAY}`)).toEqual(['plan: weekStart does not match the URL']);
    expect(await bad({ ...planOf(MONDAY, [dish(ONIGIRI)]), note: 'my gran' } as Plan)).toEqual(['plan: unknown field "note"']);
  });

  it('needs health_data to save (Step 6 ruling: plans are health data); reading and deleting do not', async () => {
    const p = await player({ consent: false });
    const res = await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatchObject({ code: 'consent_required', details: { purpose: 'health_data' } });
    expect(await current(p.cookie)).toEqual({ plan: null, weekStart: MONDAY, checks: [] });
    expect((await call(p.cookie, { method: 'DELETE', url: `/plans/${MONDAY}` })).statusCode).toBe(204);
    expect((await call(p.cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: MONDAY } })).statusCode).toBe(403);
  });

  it("a rule added after saving shows the item as blocked in GET /plans/current; the stored plan is unchanged", async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 1)]));
    const [before] = await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id));
    await addRule(p.cookie);
    const got = await current(p.cookie);
    expect(got.plan?.items).toEqual([dish(PARIPPU, 1)]);
    expect(got.checks).toHaveLength(1);
    expect(got.checks[0].status).toBe('blocked');
    const [after] = await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id));
    expect(after.sealed.equals(before.sealed)).toBe(true);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("weekStart must match the player's market day (Sat market → a Saturday)", async () => {
    const p = await player();
    expect((await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [6] } })).statusCode).toBe(200);
    expect((await current(p.cookie)).weekStart).toBe(SATURDAY);
    const monday = await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    expect(monday.statusCode).toBe(400);
    expect(monday.json().error).toMatchObject({ code: 'plan_invalid', details: { problems: ['plan: weekStart is not the first day of your plan week'] } });
    expect((await put(p.cookie, planOf(SATURDAY, [dish(ONIGIRI, 2)]))).statusCode).toBe(200);
    expect((await current(p.cookie)).plan?.weekStart).toBe(SATURDAY);
  });

  it('restorePlanIn (Step 8 undo) puts the previous plan back, or deletes the week\'s plan when there was none', async () => {
    const p = await player();
    const first = planOf(MONDAY, [dish(ONIGIRI, 1)]);
    await put(p.cookie, first);
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 4)]));
    const deps = { keyring: config.keyring, catalog, loop: defaultLoopContent(), recipes: await createRecipeIndexSource().current(db) };
    await db.transaction((tx) => restorePlanIn(tx, deps, p.id, MONDAY, first, NOW));
    expect(await loadPlan(db, config.keyring, p.id, MONDAY)).toEqual({ ...first, id: expect.any(String) });
    await db.transaction((tx) => restorePlanIn(tx, deps, p.id, MONDAY, null, NOW));
    expect(await loadPlan(db, config.keyring, p.id, MONDAY)).toBeNull();
    const actions = (await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id))).map((e) => e.action);
    expect(actions.filter((a) => a.startsWith('plan.'))).toEqual(['plan.save', 'plan.save', 'plan.restore', 'plan.restore']);
  });

  it('limits week requests per player per minute (429 rate_limited with retry-after)', async () => {
    const p = await player();
    for (let i = 0; i < WEEK_REQUESTS_PER_MINUTE; i++) {
      expect((await call(p.cookie, { method: 'DELETE', url: `/plans/${MONDAY}` })).statusCode).toBe(204);
    }
    const res = await call(p.cookie, { method: 'GET', url: '/plans/current' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json().error.details?.scope).toBeUndefined(); // M5 final m2: per-minute, not the daily cap
    // Another player is not limited.
    expect((await call((await player()).cookie, { method: 'GET', url: '/plans/current' })).statusCode).toBe(200);
  });

  it('DELETE /plans/:weekStart removes the plan and its run, and keeps the pantry rows its ticks added', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(p.cookie);
    expect((await tick(p.cookie, run.id, row(run, 'umeboshi').key, true)).statusCode).toBe(200);
    expect((await call(p.cookie, { method: 'DELETE', url: `/plans/${MONDAY}` })).statusCode).toBe(204);
    expect(await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id))).toEqual([]);
    expect(await db.select().from(marketRuns).where(eq(marketRuns.userId, p.id))).toEqual([]);
    expect((await loadPantry(db, config.keyring, p.id)).map((i) => i.name)).toEqual(['umeboshi']);
  });
});

describe('market runs', () => {
  it('market run: list = plan ingredients − pantry, by stall; ticking adds a dated market pantry item; unticking removes that id only', async () => {
    const p = await player();
    await pantryAdd(p.cookie, [{ name: 'salt', ingredientId: null }]);
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const run = await open(p.cookie);
    expect(run).toMatchObject({ weekStart: MONDAY, doneAt: null });
    const names = run.items.map((i) => i.name);
    expect(names).toContain('split moong dal');
    expect(names).toContain('nori sheets');
    expect(names).not.toContain('salt');
    expect(names).not.toContain('water');
    expect(run.items.every((i) => i.ticked === false)).toBe(true);
    // Grouped by stall, in the stall order.
    const ORDER = ['wen', 'bram', 'okafor-sato', 'spice', 'general'];
    const stalls = run.items.map((i) => ORDER.indexOf(i.stall));
    expect(stalls).toEqual([...stalls].sort((a, b) => a - b));
    expect(row(run, 'split moong dal').forDishes).toEqual([PARIPPU]);

    const dal = row(run, 'split moong dal');
    const ticked = await tick(p.cookie, run.id, dal.key, true);
    expect(ticked.statusCode, ticked.body).toBe(200);
    expect(row(ticked.json<MarketRunView>(), 'split moong dal').ticked).toBe(true);
    const pantry = await loadPantry(db, config.keyring, p.id);
    const bought = pantry.find((i) => i.name === 'split moong dal');
    expect(bought).toEqual({ id: expect.any(String), name: 'split moong dal', ingredientId: dal.ingredientId, addedOn: TODAY, source: 'market' });
    // Ticking again changes nothing.
    await tick(p.cookie, run.id, dal.key, true);
    expect((await loadPantry(db, config.keyring, p.id)).filter((i) => i.name === 'split moong dal')).toHaveLength(1);

    const unticked = await tick(p.cookie, run.id, dal.key, false);
    expect(row(unticked.json<MarketRunView>(), 'split moong dal').ticked).toBe(false);
    expect((await loadPantry(db, config.keyring, p.id)).map((i) => i.name)).toEqual(['salt']);
    // A key the run doesn't hold is 404; another player's run is 404.
    expect((await tick(p.cookie, run.id, 'no-such-key', true)).statusCode).toBe(404);
    const other = await player();
    expect((await tick(other.cookie, run.id, dal.key, true)).statusCode).toBe(404);
    expect((await finish(other.cookie, run.id)).statusCode).toBe(404);
  });

  it('a pantry "milk" already there survives tick → untick of a listed milk', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const run = await open(p.cookie);
    const ghee = row(run, 'ghee');
    expect((await tick(p.cookie, run.id, ghee.key, true)).statusCode).toBe(200);
    // Then the player tells the Pan they have ghee: same name, told, no date.
    const [told] = await pantryAdd(p.cookie, [{ name: 'ghee', ingredientId: ghee.ingredientId }]);
    expect((await loadPantry(db, config.keyring, p.id)).filter((i) => i.name === 'ghee')).toHaveLength(2);
    await tick(p.cookie, run.id, ghee.key, false);
    expect(await loadPantry(db, config.keyring, p.id)).toEqual([{ id: told, name: 'ghee', ingredientId: ghee.ingredientId }]);
  });

  it('finish twice → one done_at; tick after finish → 409 run_closed', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(p.cookie);
    expect((await finish(p.cookie, run.id, OMIT)).json().error.code).toBe('confirmation_required');
    const first = await finish(p.cookie, run.id);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<MarketRunView>().doneAt).toBe(NOW.toISOString());
    // A later clock: the second finish keeps the first done_at.
    await app.close();
    mailer = new CaptureMailer();
    app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(NOW.getTime() + 3_600_000), logger: false });
    const second = await finish(p.cookie, run.id);
    expect(second.json<MarketRunView>().doneAt).toBe(NOW.toISOString());
    const [stored] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    expect(stored.doneAt).toEqual(NOW);
    const late = await tick(p.cookie, run.id, run.items[0].key, true);
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('run_closed');
    // A finished run is not recomputed on open.
    expect(await open(p.cookie)).toEqual({ ...run, doneAt: NOW.toISOString() });
    const finishes = await db.select().from(auditEvents).where(eq(auditEvents.action, 'market_run.finish'));
    expect(finishes.filter((e) => e.subjectUserId === p.id)).toHaveLength(1);
  });

  it('openRunIn twice → the same run id; a rule added in between drops the blocked dish\'s unticked rows and keeps ticked rows and pantryIds (C20)', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const first = await open(p.cookie);
    const again = await open(p.cookie);
    expect(again).toEqual(first);
    const dal = row(first, 'split moong dal');
    await tick(p.cookie, first.id, dal.key, true);
    const [pantryId] = (await loadPantry(db, config.keyring, p.id)).map((i) => i.id);

    await addRule(p.cookie);
    const after = await open(p.cookie);
    expect(after.id).toBe(first.id);
    const names = after.items.map((i) => i.name);
    // Parippu is ⛔ now: its unticked rows are gone; the ticked dal stays ticked, with its pantry row.
    for (const gone of ['grated coconut', 'turmeric', 'ghee', 'mustard seeds']) expect(names).not.toContain(gone);
    expect(row(after, 'split moong dal')).toEqual({ ...dal, ticked: true });
    expect(names).toContain('nori sheets');
    expect(after.items.filter((i) => i.forDishes.includes(PARIPPU) && !i.ticked)).toEqual([]);
    const stored = await loadRunById(db, config.keyring, p.id, first.id);
    expect(stored?.pantryIds).toEqual({ [dal.key]: pantryId });
    // A key the recompute dropped → 404.
    expect((await tick(p.cookie, first.id, row(first, 'turmeric').key, true)).statusCode).toBe(404);
    // Unticking the kept row still removes exactly its pantry row.
    await tick(p.cookie, first.id, dal.key, false);
    expect(await loadPantry(db, config.keyring, p.id)).toEqual([]);
    expect(await db.select().from(marketRuns).where(eq(marketRuns.userId, p.id))).toHaveLength(1);
  });

  it('every row is rules-checked: a ❓ line is marked unverified, never shown as plain', async () => {
    const p = await player();
    await addRule(p.cookie);
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI, 0)]));
    const run = await open(p.cookie);
    for (const name of ['soy sauce', 'umeboshi', 'nori sheets']) expect(row(run, name).unverified, name).toBe(true);
    expect(run.items.map((i) => i.name)).not.toContain('grated coconut');
  });

  it('a market run for a week with no plan is 404', async () => {
    const p = await player();
    const res = await call(p.cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: MONDAY } });
    expect(res.statusCode).toBe(404);
  });
});

describe('erasure and logs', () => {
  it('a health_data withdraw-with-delete erases plans and market runs (Step 6 ruling); keep leaves them readable', async () => {
    const keep = await player();
    await put(keep.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    await open(keep.cookie);
    expect((await call(keep.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    expect((await current(keep.cookie)).plan?.items).toEqual([dish(ONIGIRI)]);
    expect((await put(keep.cookie, planOf(MONDAY, [dish(ONIGIRI, 1)]))).statusCode).toBe(403);

    const del = await player();
    await put(del.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(del.cookie);
    await tick(del.cookie, run.id, row(run, 'umeboshi').key, true);
    expect((await call(del.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect(await db.select().from(mealPlans).where(eq(mealPlans.userId, del.id))).toEqual([]);
    expect(await db.select().from(marketRuns).where(eq(marketRuns.userId, del.id))).toEqual([]);
    // The pantry is contract basis (H-11): what was bought stays.
    expect((await loadPantry(db, config.keyring, del.id)).map((i) => i.name)).toEqual(['umeboshi']);
  });

  it('lock order: a tick waits on pantry: and then plan:, a withdraw-with-delete on plan:', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(p.cookie);
    const waitsOn = async (ns: number, request: () => Promise<{ statusCode: number }>) => {
      const blocker = await sql.reserve();
      try {
        await blocker`begin`;
        await blocker`select pg_advisory_xact_lock(${ns}, hashtext(${p.id}))`;
        const pending = request();
        for (let i = 0; ; i++) {
          const [w] = await sql<{ n: number }[]>`
            select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
          if (w.n >= 1) break;
          if (i > 300) throw new Error(`the request never waited on lock ${ns}`);
          await new Promise((r) => setTimeout(r, 10));
        }
        await blocker`commit`;
        return (await pending).statusCode;
      } finally {
        await blocker`rollback`.catch(() => {});
        blocker.release();
      }
    };
    expect(await waitsOn(ADVISORY_LOCK.pantry, () => tick(p.cookie, run.id, row(run, 'umeboshi').key, true))).toBe(200);
    expect(await waitsOn(ADVISORY_LOCK.plan, () => tick(p.cookie, run.id, row(run, 'umeboshi').key, false))).toBe(200);
    expect(await waitsOn(ADVISORY_LOCK.plan, () => call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } }))).toBe(204);
    expect(await db.select().from(mealPlans).where(eq(mealPlans.userId, p.id))).toEqual([]);
  });

  it('C-9: plan and tick requests leave no ingredient or slug in captured logs', async () => {
    await app.close();
    const logs = captureLogs();
    await build(logs.logger);
    const p = await player();
    await addRule(p.cookie);
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU)]));
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI, 1)]));
    const run = await open(p.cookie);
    await tick(p.cookie, run.id, row(run, 'umeboshi').key, true);
    await tick(p.cookie, run.id, row(run, 'nori sheets').key, true);
    await finish(p.cookie, run.id);
    await current(p.cookie);
    expect(logs.lines().length).toBeGreaterThan(0);
    expect(logs.text()).not.toMatch(/parippu|onigiri|umeboshi|nori|coconut|kerala|osaka/i);
  });
});

describe('fix round 1', () => {
  it('I1: a tick recomputes against the current rules: a row of a dish blocked mid-run is 404 and never reaches the pantry', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const run = await open(p.cookie);
    await addRule(p.cookie); // coconut: parippu is ⛔ now
    const res = await tick(p.cookie, run.id, row(run, 'turmeric').key, true);
    expect(res.statusCode).toBe(404);
    expect(await loadPantry(db, config.keyring, p.id)).toEqual([]);
    // A row still on the list ticks, and the response carries no row of the blocked dish.
    const ok = await tick(p.cookie, run.id, row(run, 'nori sheets').key, true);
    expect(ok.statusCode, ok.body).toBe(200);
    const view = ok.json<MarketRunView>();
    expect(view.items.filter((i) => i.forDishes.includes(PARIPPU) && !i.ticked)).toEqual([]);
    expect(view.items.map((i) => i.name)).not.toContain('grated coconut');
    // Onigiri's ❓ lines are flagged in the tick response (computed now).
    expect(row(view, 'umeboshi').unverified).toBe(true);
  });

  it('I2 Auckland (UTC+13, Saturday market): at 09:00 Saturday local the current week is that Saturday', async () => {
    await rebuildAt(new Date('2026-11-13T20:00:00Z')); // Friday 20:00 UTC = Saturday 09:00 in Auckland
    const p = await player();
    await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [6] } });
    const local = await call(p.cookie, { method: 'GET', url: '/plans/current?today=2026-11-14' });
    expect(local.statusCode, local.body).toBe(200);
    expect(local.json().weekStart).toBe('2026-11-14');
    // Without the local date, the UTC date is used (the fallback).
    expect((await current(p.cookie)).weekStart).toBe('2026-11-07');
    // A tick dates the purchase with the local day.
    const saved = await call(p.cookie, { method: 'PUT', url: '/plans/2026-11-14', payload: { plan: planOf('2026-11-14', [dish(ONIGIRI)]), confirmed: true, today: '2026-11-14' } });
    expect(saved.statusCode, saved.body).toBe(200);
    const run = await open(p.cookie, '2026-11-14');
    const t = await call(p.cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: row(run, 'umeboshi').key, ticked: true, today: '2026-11-14' } });
    expect(t.statusCode, t.body).toBe(200);
    expect((await loadPantry(db, config.keyring, p.id))[0].addedOn).toBe('2026-11-14');
  });

  it('I2 Los Angeles (UTC−8): at 19:00 Friday local the week is still the current one, and a tick is dated Friday', async () => {
    await rebuildAt(new Date('2026-11-14T03:00:00Z')); // Friday 19:00 in Los Angeles
    const p = await player();
    await call(p.cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [6] } });
    const local = await call(p.cookie, { method: 'GET', url: '/plans/current?today=2026-11-13' });
    expect(local.json().weekStart).toBe('2026-11-07');
    expect((await current(p.cookie)).weekStart).toBe('2026-11-14');
    await call(p.cookie, { method: 'PUT', url: '/plans/2026-11-07', payload: { plan: planOf('2026-11-07', [dish(ONIGIRI)]), confirmed: true, today: '2026-11-13' } });
    const run = await open(p.cookie, '2026-11-07');
    const t = await call(p.cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: row(run, 'umeboshi').key, ticked: true, today: '2026-11-13' } });
    expect(t.statusCode, t.body).toBe(200);
    expect((await loadPantry(db, config.keyring, p.id))[0].addedOn).toBe('2026-11-13');
  });

  it('I2: a local date outside [UTC−1, UTC+1], or not a date, is 400', async () => {
    const p = await player();
    for (const bad of ['2026-11-08', '2026-11-12', '2026-13-01', 'today']) {
      const res = await call(p.cookie, { method: 'GET', url: `/plans/current?today=${bad}` });
      expect(res.statusCode, bad).toBe(400);
    }
    for (const ok of ['2026-11-09', '2026-11-10', '2026-11-11']) {
      expect((await call(p.cookie, { method: 'GET', url: `/plans/current?today=${ok}` })).statusCode, ok).toBe(200);
    }
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(p.cookie);
    const t = await call(p.cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: row(run, 'umeboshi').key, ticked: true, today: '2026-11-12' } });
    expect(t.statusCode).toBe(400);
    expect(await loadPantry(db, config.keyring, p.id)).toEqual([]);
  });

  it('I3: plans only for weeks from the current week − 1 to + 4', async () => {
    const p = await player();
    const at = async (weekStart: string) => (await put(p.cookie, planOf(weekStart, [dish(ONIGIRI)]))).statusCode;
    // Current plan week (no market days): Monday 2026-11-09.
    expect(await at('2026-11-02')).toBe(200);
    expect(await at('2026-12-07')).toBe(200);
    for (const out of ['2026-10-26', '2026-12-14', '2099-01-05', '2020-01-06']) {
      const res = await put(p.cookie, planOf(out, [dish(ONIGIRI)]));
      expect(res.statusCode, out).toBe(400);
      expect(res.json().error).toMatchObject({ code: 'plan_invalid', details: { problems: ['plan: weekStart is outside the weeks you can plan'] } });
    }
  });

  it('M1: a tick takes pantry: before plan: (plan: is still free while it waits on pantry:)', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI)]));
    const run = await open(p.cookie);
    const blocker = await sql.reserve();
    const probe = await sql.reserve();
    try {
      await blocker`begin`;
      await blocker`select pg_advisory_xact_lock(${ADVISORY_LOCK.pantry}, hashtext(${p.id}))`;
      const pending = tick(p.cookie, run.id, row(run, 'umeboshi').key, true);
      for (let i = 0; ; i++) {
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        if (w.n >= 1) break;
        if (i > 300) throw new Error('the tick never waited on pantry:');
        await new Promise((r) => setTimeout(r, 10));
      }
      await probe`begin`;
      const [got] = await probe<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(${ADVISORY_LOCK.plan}, hashtext(${p.id})) as ok`;
      expect(got.ok).toBe(true);
      await probe`rollback`;
      await blocker`commit`;
      expect((await pending).statusCode).toBe(200);
    } finally {
      await blocker`rollback`.catch(() => {});
      await probe`rollback`.catch(() => {});
      blocker.release();
      probe.release();
    }
  });

  it('M2: after a "keep" withdrawal the run can still be read (no write, current rules); ticks and finish still need consent', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const run = await open(p.cookie);
    await tick(p.cookie, run.id, row(run, 'nori sheets').key, true);
    await addRule(p.cookie);
    const [before] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    const read = await open(p.cookie);
    expect(read.id).toBe(run.id);
    expect(row(read, 'nori sheets').ticked).toBe(true);
    // Read with the current rules: the ⛔ dish's unticked rows are not shown as a list to buy.
    expect(read.items.filter((i) => i.forDishes.includes(PARIPPU) && !i.ticked)).toEqual([]);
    const [after] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    expect(after.sealed.equals(before.sealed)).toBe(true);
    expect((await tick(p.cookie, run.id, row(read, 'umeboshi').key, true)).statusCode).toBe(403);
    expect((await finish(p.cookie, run.id)).statusCode).toBe(403);
    // No run yet and no consent: opening would be a write.
    const q = await player({ consent: false });
    expect((await call(q.cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: MONDAY } })).statusCode).toBe(403);
  });

  it('M3: PUT accepts the plan exactly as GET returned it (its id is ignored)', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(ONIGIRI, 1)]));
    const got = (await current(p.cookie)).plan!;
    const res = await put(p.cookie, { ...got, items: [...got.items, dish(ONIGIRI, 3)] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ plan: { id: string } }>().plan.id).toBe(got.id);
    const forged = await put(p.cookie, { ...got, id: '00000000-0000-4000-8000-000000000000' } as Plan);
    expect(forged.statusCode).toBe(200);
    expect(forged.json<{ plan: { id: string } }>().plan.id).toBe(got.id);
  });
});

// M6 Step 6: list amounts (Ruling 12) and stall swaps (Ruling 11), re-derived by core on the server.
describe('M6 Step 6: amounts and stall swaps', () => {
  type StockBody = { key: string; action: 'out' | 'take' | 'undo'; toId?: string };
  const stock = (cookie: string, runId: string, body: StockBody) => call(cookie, { method: 'POST', url: `/market-runs/${runId}/stock`, payload: body });
  const stockOk = async (cookie: string, runId: string, body: StockBody) => {
    const res = await stock(cookie, runId, body);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<MarketRunView>();
  };
  const byKey = (run: MarketRunView, key: string) => run.items.find((i) => i.key === key);
  const pantryOf = (userId: string) => loadPantry(db, config.keyring, userId);

  it('open run rows carry amounts scaled by plan servings; a null-quantity line shows no amounts', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const two = await open(p.cookie);
    // Parippu serves 3 with 100 g of dal: 2 servings → 66.67 g.
    expect(byKey(two, 'moong_dal')?.amounts).toEqual([{ quantity: 66.67, unit: 'g', text: '66.67 g' }]);
    const q = await player();
    await put(q.cookie, planOf(MONDAY, [{ ...dish(PARIPPU, 0), servings: 6 }]));
    const six = await open(q.cookie);
    expect(byKey(six, 'moong_dal')?.amounts).toEqual([{ quantity: 200, unit: 'g', text: '200 g' }]);
    // A ticked row keeps its amounts (kept exactly by the recompute).
    const ticked = await tick(q.cookie, six.id, 'moong_dal', true);
    expect(byKey(ticked.json<MarketRunView>(), 'moong_dal')?.amounts).toEqual([{ quantity: 200, unit: 'g', text: '200 g' }]);

    // A canon dish whose shallots have no quantity: that row shows no amount (never "0", never a guess).
    const dir = mkdtempSync(join(tmpdir(), 'kq-recipes-'));
    try {
      cpSync(RECIPES_DIR, dir, { recursive: true });
      const text = readFileSync(join(RECIPES_DIR, `${PARIPPU}.cook`), 'utf8');
      writeFileSync(join(dir, `${PARIPPU}-plain.cook`), text.replace('title: Parippu Curry', 'title: Plain Parippu Curry').replace('@shallots{3}', '@shallots{}'));
      await syncCanon(db, dir, catalog.graph, NOW);
      const r = await player();
      await put(r.cookie, planOf(MONDAY, [dish(`${PARIPPU}-plain`, 0)]));
      const plain = await open(r.cookie);
      const shallot = byKey(plain, 'shallot');
      expect(shallot).toBeDefined();
      expect(shallot).not.toHaveProperty('amounts');
      expect(byKey(plain, 'moong_dal')?.amounts).toEqual([{ quantity: 66.67, unit: 'g', text: '66.67 g' }]);
    } finally {
      await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stock out → row outOfStock and unticked (pantry id removed); take an offered swap → a ticked stock row + a dated market pantry item', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const run = await open(p.cookie);
    await tick(p.cookie, run.id, 'garlic', true);
    expect((await pantryOf(p.id)).map((i) => i.name)).toEqual(['garlic clove']);
    const out = await stockOk(p.cookie, run.id, { key: 'garlic', action: 'out' });
    expect(byKey(out, 'garlic')).toMatchObject({ outOfStock: true, ticked: false });
    expect(await pantryOf(p.id)).toEqual([]);
    // An out-of-stock row can't be ticked (undo the mark first); marking it again changes nothing.
    expect((await tick(p.cookie, run.id, 'garlic', true)).statusCode).toBe(400);
    expect((await tick(p.cookie, run.id, 'garlic', true)).json<{ error: { code: string } }>().error.code).toBe('stock_invalid');
    expect(byKey(await stockOk(p.cookie, run.id, { key: 'garlic', action: 'out' }), 'garlic')).toMatchObject({ outOfStock: true, ticked: false });

    const taken = await stockOk(p.cookie, run.id, { key: 'moong_dal', action: 'take', toId: 'red_lentil' });
    expect(byKey(taken, 'moong_dal')).toMatchObject({ outOfStock: true, ticked: false });
    const added = byKey(taken, 'stock:red_lentil');
    expect(added).toMatchObject({ ingredientId: 'red_lentil', stall: byKey(taken, 'moong_dal')!.stall, forDishes: [PARIPPU], stockSwap: { from: 'moong_dal' }, ticked: true });
    const pantry = await pantryOf(p.id);
    expect(pantry).toEqual([{ id: expect.any(String), name: added!.name, ingredientId: 'red_lentil', addedOn: TODAY, source: 'market' }]);
    // The stall-swap row isn't unticked by the tick route: `undo` is its undo.
    expect((await tick(p.cookie, run.id, 'stock:red_lentil', false)).statusCode).toBe(400);
    // The run as read back is the run as returned, and the state is sealed.
    expect(await open(p.cookie)).toEqual(taken);
    const [stored] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    for (const word of ['red_lentil', 'outOfStock', 'stock:', 'lentil']) expect(stored.sealed.toString('latin1')).not.toContain(word);
    // Audited content-free.
    const audits = await db.select().from(auditEvents).where(eq(auditEvents.subjectUserId, p.id));
    const stockAudits = audits.filter((a) => a.action === 'market_run.stock');
    expect(stockAudits.map((a) => a.target).sort()).toEqual(['stock_rows:0', 'stock_rows:0', 'stock_rows:1']);
  });

  it('take a swap core does not offer now (e.g. a rule added since) → 400 stock_invalid, nothing changed', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const run = await open(p.cookie);
    // Never offered: a substitute the curated table doesn't hold for this row, an unknown key.
    for (const body of [
      { key: 'moong_dal', action: 'take' as const, toId: 'tofu' },
      { key: 'no-such-row', action: 'take' as const, toId: 'red_lentil' },
      { key: 'no-such-row', action: 'out' as const },
    ]) {
      const res = await stock(p.cookie, run.id, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('stock_invalid');
    }
    // Offered when the run opened, but a rule added since makes the swap unsafe for the dish: core no longer offers it.
    await addRule(p.cookie, { target: { kind: 'ingredient', ids: ['red_lentil'] }, type: 'avoid', severity: 'allergy' });
    const [before] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    const res = await stock(p.cookie, run.id, { key: 'moong_dal', action: 'take', toId: 'red_lentil' });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('stock_invalid');
    const [after] = await db.select().from(marketRuns).where(eq(marketRuns.id, run.id));
    expect(after.sealed.equals(before.sealed)).toBe(true);
    expect(await pantryOf(p.id)).toEqual([]);
    // A shape outside the body's (an unknown action, `take` without a toId, a key beside them, a toId on `out`) is a
    // 400 bad_request.
    for (const payload of [{ key: 'moong_dal', action: 'swap' }, { key: 'moong_dal', action: 'take' }, { key: 'moong_dal', action: 'out', toId: 'onion' }, { key: 'moong_dal', action: 'out', name: 'x' }]) {
      const bad = await call(p.cookie, { method: 'POST', url: `/market-runs/${run.id}/stock`, payload });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ error: { code: string } }>().error.code).toBe('bad_request');
    }
  });

  it('undo removes exactly the swap\'s pantry id; a same-name pantry item survives', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const run = await open(p.cookie);
    const taken = await stockOk(p.cookie, run.id, { key: 'moong_dal', action: 'take', toId: 'red_lentil' });
    const name = byKey(taken, 'stock:red_lentil')!.name;
    const [told] = await pantryAdd(p.cookie, [{ name, ingredientId: 'red_lentil' }]);
    expect((await pantryOf(p.id)).filter((i) => i.name === name)).toHaveLength(2);
    // Undo by the swap row's key or the original's: both undo the pair.
    const undone = await stockOk(p.cookie, run.id, { key: 'stock:red_lentil', action: 'undo' });
    expect(byKey(undone, 'stock:red_lentil')).toBeUndefined();
    expect(byKey(undone, 'moong_dal')).toEqual(byKey(run, 'moong_dal'));
    expect((await pantryOf(p.id)).map((i) => i.id)).toEqual([told]);
    // Undo again changes nothing; out → undo by the row clears the mark.
    expect(await stockOk(p.cookie, run.id, { key: 'moong_dal', action: 'undo' })).toEqual(undone);
    await stockOk(p.cookie, run.id, { key: 'shallot', action: 'out' });
    const cleared = await stockOk(p.cookie, run.id, { key: 'shallot', action: 'undo' });
    expect(byKey(cleared, 'shallot')).toEqual(byKey(run, 'shallot'));
    // Take, then take another swap for the same row: refused (one swap a row).
    await stockOk(p.cookie, run.id, { key: 'coconut_oil', action: 'take', toId: 'neutral_oil' });
    expect((await stock(p.cookie, run.id, { key: 'ghee', action: 'take', toId: 'neutral_oil' })).statusCode).toBe(400);
  });

  it('recompute after a rule change keeps stock rows and outOfStock on kept rows; a now-⛔ dish drops its out-of-stock row (C20); stock after finish → 409 run_closed', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const run = await open(p.cookie);
    await stockOk(p.cookie, run.id, { key: 'shallot', action: 'out' });
    await stockOk(p.cookie, run.id, { key: 'bonito_flakes', action: 'take', toId: 'shio_kombu' });
    await stockOk(p.cookie, run.id, { key: 'soy_sauce', action: 'out' });
    // Umeboshi under an allergy rule: onigiri is ⛔ now (no swap for it), parippu is untouched.
    await addRule(p.cookie, { target: { kind: 'ingredient', ids: ['umeboshi'] }, type: 'avoid', severity: 'allergy' });
    const again = await open(p.cookie);
    expect(again.id).toBe(run.id);
    expect(byKey(again, 'shallot')).toMatchObject({ outOfStock: true, ticked: false });
    expect(byKey(again, 'soy_sauce')).toBeUndefined();
    expect(byKey(again, 'bonito_flakes')).toBeUndefined();
    expect(byKey(again, 'stock:shio_kombu')).toMatchObject({ ticked: true, stockSwap: { from: 'bonito_flakes' } });
    expect(again.items.filter((i) => i.forDishes.includes(ONIGIRI) && i.stockSwap === undefined)).toEqual([]);
    // The swap row stays, and the tick route can't untick it; undo still removes it and its pantry row.
    expect((await tick(p.cookie, run.id, 'stock:shio_kombu', false)).statusCode).toBe(400);
    expect((await pantryOf(p.id)).map((i) => i.ingredientId)).toEqual(['shio_kombu']);
    const undone = await stockOk(p.cookie, run.id, { key: 'stock:shio_kombu', action: 'undo' });
    expect(byKey(undone, 'stock:shio_kombu')).toBeUndefined();
    expect(await pantryOf(p.id)).toEqual([]);
    // Ticks and stock both stop at finish.
    expect((await finish(p.cookie, run.id)).statusCode).toBe(200);
    const late = await stock(p.cookie, run.id, { key: 'shallot', action: 'undo' });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('run_closed');
    // Another player's run is 404.
    const other = await player();
    expect((await stock(other.cookie, run.id, { key: 'shallot', action: 'out' })).statusCode).toBe(404);
  });

  it('stock without health_data → 403 consent_required; C-9: no item or question id in captured logs', async () => {
    await app.close();
    const logs = captureLogs();
    await build(logs.logger);
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0), dish(ONIGIRI, 2)]));
    const run = await open(p.cookie);
    await stockOk(p.cookie, run.id, { key: 'moong_dal', action: 'take', toId: 'red_lentil' });
    await stockOk(p.cookie, run.id, { key: 'soy_sauce', action: 'out' });
    await stockOk(p.cookie, run.id, { key: 'stock:red_lentil', action: 'undo' });
    // A stall round goes through the logs too: no stall, question or pick in them.
    const round = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [{ id: randomUUID(), kind: 'stall_round', at: TODAY, stall: 'wen', answers: [{ q: 'wen-avocado-ripe', pick: 0 }] }] } });
    expect(round.statusCode, round.body).toBe(200);
    expect(round.json<{ accepted: unknown[] }>().accepted).toHaveLength(1);
    const bad = await stock(p.cookie, run.id, { key: 'moong_dal', action: 'take', toId: 'tofu' });
    expect(bad.statusCode).toBe(400);
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    const denied = await stock(p.cookie, run.id, { key: 'shallot', action: 'out' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json<{ error: { code: string } }>().error.code).toBe('consent_required');
    expect(logs.lines().length).toBeGreaterThan(0);
    expect(logs.text()).not.toMatch(/parippu|onigiri|moong|lentil|soy|shallot|tofu|kerala|osaka|wen-|avocado|stall_round|"pick"/i);
  });
});

// M6 Step 10 (coordinator ruling 3): the current run, read only, for the scripted check-off and cook's swap label.
describe('M6 Step 10: GET /market-runs/current', () => {
  const currentRun = async (cookie: string) => {
    const res = await call(cookie, { method: 'GET', url: `/market-runs/current?today=${TODAY}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ run: MarketRunView | null }>().run;
  };
  const runRows = (userId: string) => db.select().from(marketRuns).where(eq(marketRuns.userId, userId));

  it('no run → null and nothing opened; an open run → its rows (stall swaps included); done → null; signed out → 401', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    expect(await currentRun(p.cookie)).toBeNull();
    expect(await runRows(p.id)).toEqual([]); // a read never opens one
    const run = await open(p.cookie);
    const swapped = await call(p.cookie, { method: 'POST', url: `/market-runs/${run.id}/stock`, payload: { key: 'shallot', action: 'take', toId: 'onion', today: TODAY } });
    expect(swapped.statusCode, swapped.body).toBe(200);
    const read = await currentRun(p.cookie);
    expect(read?.id).toBe(run.id);
    expect(read?.items.find((i) => i.key === 'shallot')).toMatchObject({ outOfStock: true });
    expect(read?.items.find((i) => i.key === 'stock:onion')).toMatchObject({ ticked: true, stockSwap: { from: 'shallot' } });
    const sealedBefore = (await runRows(p.id))[0].sealed;
    await currentRun(p.cookie);
    expect((await runRows(p.id))[0].sealed).toEqual(sealedBefore); // read only: the stored run is untouched
    expect((await finish(p.cookie, run.id)).statusCode).toBe(200);
    expect(await currentRun(p.cookie)).toBeNull();
    expect((await call(null, { method: 'GET', url: `/market-runs/current?today=${TODAY}` })).statusCode).toBe(401);
  });

  it('a read needs no health_data consent (M5 M2): after a withdraw-and-keep the run still reads', async () => {
    const p = await player();
    await put(p.cookie, planOf(MONDAY, [dish(PARIPPU, 0)]));
    const run = await open(p.cookie);
    const w = await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } });
    expect(w.statusCode, w.body).toBeLessThan(300);
    expect((await currentRun(p.cookie))?.id).toBe(run.id);
  });
});
