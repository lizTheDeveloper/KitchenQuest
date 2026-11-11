// M5 Step 6: sealed weekly plans and market runs (H-11, Ruling 18), dated pantry ticks (Ruling 16), C20 recompute.
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
import { loadRunById } from '../src/week/store.js';
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
const build = async (logger: Parameters<typeof buildApp>[0]['logger'] = false) => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger });
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
    // The player tells the Pan they have ghee after the list was made: same name, told, no date.
    const [told] = await pantryAdd(p.cookie, [{ name: 'ghee', ingredientId: ghee.ingredientId }]);
    await tick(p.cookie, run.id, ghee.key, true);
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
