// M5 Step 12: nothing earned is taken back (spec §6, never rule 6, Rulings 6 and 7, Review Focus 2). Grants survive a
// meal undo, a margin-note delete, a Shared Table delete, a health_data withdrawal with "delete", a rule that blocks a
// cooked dish, a rewards.yaml with higher thresholds loaded at a second boot, and a re-upload of a device log. Every
// derived value (XP, level, stamps, trust, technique tier, quests) stays ≥ what it was, and the grant rows themselves
// are unchanged. No code path updates a grant (a database trigger refuses it) or deletes one (a grep over
// apps/api/src; only the account-delete cascade removes grants).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compactHistory,
  deriveProgress,
  grantsForBatch,
  type ProgressEvent,
  type ProgressHistory,
  type ProgressSnapshot,
  type ProgressView,
  type RewardGrant,
  type RewardsData,
  type RulesContext,
  SNAPSHOT_EVERY,
} from '@kitchenquest/core';
import fc from 'fast-check';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent, type LoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { progressSnapshots, rewardGrants } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { catalogueFor } from '../src/progress/catalogue.js';
import { catalogueHash } from '../src/progress/snapshot.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T12:00:00Z');
const TODAY = '2026-11-10';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | null = null;
const mailer = new CaptureMailer();
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  await app?.close();
  app = null;
});

async function boot(loop?: LoopContent): Promise<FastifyInstance> {
  await app?.close();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false, ...(loop ? { loop } : {}) });
  return app;
}
const call = (cookie: string, opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });

async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app!, mailer, `keep${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode).toBe(201);
  return { cookie, id };
}
async function post(cookie: string, events: ProgressEvent[], upload?: true) {
  const res = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events, ...(upload ? { upload } : {}) } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ accepted: { clientId: string }[]; duplicate: string[]; rejected: { clientId: string; problems: string[] }[] }>();
}
const view = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
const grantRows = async (userId: string) =>
  (await db.select().from(rewardGrants).where(eq(rewardGrants.userId, userId))).map((g) => JSON.stringify(g)).sort();
async function logMeal(cookie: string, eatenOn = TODAY): Promise<string> {
  const res = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn, slot: 'lunch', item: { kind: 'dish', slug: PARIPPU, servings: 1 } }, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ meal: { id: string } }>().meal.id;
}

const eid = (): string => randomUUID();
const cooked = (recipe: string, at: string): ProgressEvent => ({ id: eid(), kind: 'cooked', at, recipe, planned: true });
/** A rich past: Leela's quest, cooks across six weeks (trust 2+, level 2+), a market run and two meal logs today. */
async function playAWhile(cookie: string): Promise<ProgressEvent[]> {
  const start = addDays(TODAY, -42);
  const events: ProgressEvent[] = [
    ...Array.from({ length: 6 }, (_, i): ProgressEvent => ({ id: eid(), kind: 'quest_step', at: start, quest: 'leela-tempering', step: i + 1 })),
    { id: eid(), kind: 'quest_done', at: start, quest: 'leela-tempering' },
  ];
  for (let w = 0; w < 6; w++) {
    const at = addDays(start, w * 7);
    events.push(cooked(PARIPPU, at), cooked(ONIGIRI, at), cooked(FRIJOLES, at), { id: eid(), kind: 'lesson', at, recipe: FRIJOLES });
  }
  events.push({ id: eid(), kind: 'market_run', at: addDays(TODAY, -1), weekStart: addDays(TODAY, -1) });
  const lunch = await logMeal(cookie);
  const dinner = await logMeal(cookie);
  events.push({ id: eid(), kind: 'meal_logged', at: TODAY, minute: 720, mealLogId: lunch }, { id: eid(), kind: 'meal_logged', at: TODAY, minute: 1140, mealLogId: dinner });
  // Older events go up as the sign-in upload would send them (C14); the live window takes today's.
  const r = await post(cookie, events, true);
  expect(r.rejected).toEqual([]);
  return events;
}

const RANK = { seen: 0, tried: 1, yours: 2 } as const;
/** `after` shows nothing lower than `before`, on every value the player sees. */
function expectNoLower(before: ProgressView, after: ProgressView, label: string) {
  expect(after.xp, `${label}: xp`).toBeGreaterThanOrEqual(before.xp);
  expect(after.level, `${label}: level`).toBeGreaterThanOrEqual(before.level);
  expect(after.stamps, `${label}: stamps`).toBeGreaterThanOrEqual(before.stamps);
  for (const [cook, t] of Object.entries(before.trust)) expect(after.trust[cook] ?? 0, `${label}: trust ${cook}`).toBeGreaterThanOrEqual(t);
  for (const [id, r] of Object.entries(before.toolkit.techniques)) {
    expect(after.toolkit.techniques[id], `${label}: technique ${id}`).toBeDefined();
    expect(RANK[after.toolkit.techniques[id].tier], `${label}: tier ${id}`).toBeGreaterThanOrEqual(RANK[r.tier]);
  }
  for (const q of before.questsDone) expect(after.questsDone, `${label}: quest ${q}`).toContain(q);
}

describe('grants survive (spec §6)', () => {
  it('meal undo, note delete, Shared Table delete, health_data delete, a blocking rule, retuned thresholds at a second boot and a device re-upload', async () => {
    await boot();
    const p = await player();
    const events = await playAWhile(p.cookie);
    const first = await view(p.cookie);
    expect(first.level, 'the past earned a level').toBeGreaterThanOrEqual(2);
    expect(first.trust.leela, 'and trust').toBeGreaterThanOrEqual(2);
    expect(first.stamps).toBeGreaterThanOrEqual(2);
    expect(first.toolkit.techniques.tempering?.tier).toBeDefined();
    const grants = await grantRows(p.id);
    let last = first;
    const step = async (label: string) => {
      const now = await view(p.cookie);
      expectNoLower(first, now, label);
      expectNoLower(last, now, label);
      expect(await grantRows(p.id), `${label}: grant rows`).toEqual(grants);
      last = now;
    };

    // A meal undo: DELETE /meals/:id.
    const meals = events.filter((e): e is Extract<ProgressEvent, { kind: 'meal_logged' }> => e.kind === 'meal_logged');
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${meals[0].mealLogId}` })).statusCode).toBe(204);
    await step('meal undo');

    // A margin note written, then deleted.
    const note = await call(p.cookie, { method: 'POST', url: '/notes', payload: { note: { recipe: PARIPPU, ops: [{ op: 'add', name: 'lime' }], text: null, at: TODAY }, confirmed: true, today: TODAY } });
    expect(note.statusCode, note.body).toBe(201);
    expect((await call(p.cookie, { method: 'DELETE', url: `/notes/${note.json<{ note: { id: string } }>().note.id}` })).statusCode).toBe(204);
    await step('note delete');

    // Cooked for Someone, recorded then deleted.
    const shared = await call(p.cookie, { method: 'POST', url: '/shared-table', payload: { entry: { cookedOn: TODAY, recipe: PARIPPU, frame: null, cookedFor: { count: 'two_to_three', who: 'family' } }, confirmed: true, today: TODAY } });
    expect(shared.statusCode, shared.body).toBe(201);
    expect((await call(p.cookie, { method: 'DELETE', url: `/shared-table/${shared.json<{ id: string }>().id}` })).statusCode).toBe(204);
    await step('shared table delete');

    // A rule that blocks a cooked dish: coconut blocks parippu, which was cooked six times.
    const rule = await call(p.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }, confirmed: true } });
    expect(rule.statusCode).toBe(201);
    const card = await call(p.cookie, { method: 'GET', url: `/recipes/${PARIPPU}?date=${TODAY}` });
    expect(card.json<{ check: { status: string } }>().check.status).toBe('blocked');
    await step('blocking rule');

    // health_data withdrawn with "delete": meal-log events and notes go; grants stay (Ruling I2, [lawyer]).
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    await step('health_data delete');

    // A second boot with a rewards.yaml whose thresholds are all higher: levels and trust once granted are kept.
    const base = defaultLoopContent();
    const harder: RewardsData = {
      ...base.rewards,
      levels: base.rewards.levels.map((l) => l * 10),
      trust: { ...base.rewards.trust, weeks_for_level: base.rewards.trust.weeks_for_level.map((w) => w * 10) },
    };
    await boot({ ...base, rewards: harder });
    await step('higher thresholds at a second boot');

    // A re-upload of the whole device log: every event is a duplicate; nothing earned twice, nothing lowered.
    const again = await post(p.cookie, events, true);
    expect(again.accepted).toEqual([]);
    await step('device re-upload');
  });
});

// M6 Step 11 (spec §6, Ruling 1, Ruling 17, Ruling 18): a stall round's grants are fixed when made. A rules change that
// hides questions already answered (a vegetarian rule over Bram's beef; a soy rule over Okafor-Sato's tofu), a snapshot
// rebuild, a health_data withdraw-with-delete that erases every stall round (Protein Counter rounds included), and a
// rewards.yaml retune of market_game to lower amounts at a second boot lower nothing.
describe('stall-round grants survive (M6 Step 11)', () => {
  type Q = { id: string; contains?: string[]; options: { correct?: boolean }[] };
  const loopC = defaultLoopContent();
  const right = (q: Q) => q.options.findIndex((o) => o.correct === true);
  const qs = (stall: string): Q[] => loopC.market.stalls.get(stall)!.questions;
  const roundOf = (stall: string, list: Q[], at = TODAY): ProgressEvent => ({ id: eid(), kind: 'stall_round', at, stall, answers: list.map((q) => ({ q: q.id, pick: right(q) })) });
  const VEGETARIAN = { target: { kind: 'category', ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid', severity: 'preference' };
  const SOY = { target: { kind: 'ingredient', ids: ['soy'] }, type: 'avoid', severity: 'allergy' };
  const addRule = async (cookie: string, rule: unknown) => {
    const res = await call(cookie, { method: 'POST', url: '/rules', payload: { rule, confirmed: true } });
    expect(res.statusCode, res.body).toBe(201);
  };
  const snapshotOf = async (userId: string) => (await db.select().from(progressSnapshots).where(eq(progressSnapshots.userId, userId)))[0];
  const kinds = async (userId: string) => (await sql<{ kind: string }[]>`select kind from progress_events where user_id = ${userId}`).map((r) => r.kind);

  it('a rules change hiding answered questions, a snapshot rebuild, a health_data delete of every round and a lower market_game retune keep every grant', async () => {
    await boot();
    const p = await player();
    // Rounds at every base stall, the right answer each time: Bram's beef, Okafor-Sato's tofu among them.
    const beef = qs('bram').filter((q) => (q.contains ?? []).some((c) => /beef|chuck/.test(c))).slice(0, 2);
    const tofu = qs('okafor-sato').filter((q) => (q.contains ?? []).includes('tofu')).slice(0, 2);
    expect(beef.length, 'Bram has beef questions').toBeGreaterThan(0);
    expect(tofu.length, 'Okafor-Sato has tofu questions').toBeGreaterThan(0);
    const first = await post(p.cookie, [roundOf('wen', qs('wen').slice(0, 3)), roundOf('bram', beef), roundOf('okafor-sato', tofu), roundOf('spice', qs('spice').slice(0, 2))]);
    expect(first.rejected).toEqual([]);
    const start = await view(p.cookie);
    expect(start.xp).toBe(5 * (3 + beef.length + tofu.length + 2));
    expect(start.stamps).toBe(4);
    const grants = await grantRows(p.id);
    let last = start;
    const step = async (label: string) => {
      const now = await view(p.cookie);
      expectNoLower(start, now, label);
      expectNoLower(last, now, label);
      expect(await grantRows(p.id), `${label}: grant rows`).toEqual(grants);
      last = now;
    };

    // A vegetarian rule hides Bram's beef (the Protein Counter now); a soy rule hides every tofu question.
    await addRule(p.cookie, VEGETARIAN);
    await step('vegetarian rule over answered beef questions');
    // The Protein Counter, a full stall: its round earns as any other.
    const pc = (loopC.market.stalls.get('bram')!.variants!.protein_counter!.questions as Q[]).slice(0, 3);
    expect((await post(p.cookie, [roundOf('bram', pc)])).rejected).toEqual([]);
    const withPc = await grantRows(p.id);
    expect(withPc.length).toBeGreaterThan(grants.length);
    grants.splice(0, grants.length, ...withPc);
    last = await view(p.cookie);
    await addRule(p.cookie, SOY);
    await step('soy rule over answered tofu questions');
    // The hidden questions are refused now (bad_event), and their earlier grants stay.
    const hidden = await post(p.cookie, [roundOf('okafor-sato', tofu.slice(0, 1))]);
    expect(hidden.rejected.map((r) => r.problems)).toEqual([['bad_event']]);
    await step('a hidden question refused');
    const peak = last;

    // A snapshot (past SNAPSHOT_EVERY events), then dropped and rebuilt from the ledgers: the same view.
    const filler = Array.from({ length: SNAPSHOT_EVERY + 1 }, (_, i): ProgressEvent => ({ id: eid(), kind: 'lesson', at: addDays(TODAY, -Math.floor(i / 150)), recipe: [PARIPPU, ONIGIRI, FRIJOLES][i % 3] }));
    for (let i = 0; i < filler.length; i += 100) await post(p.cookie, filler.slice(i, i + 100));
    expect(await snapshotOf(p.id), 'a snapshot was written').toBeDefined();
    grants.splice(0, grants.length, ...(await grantRows(p.id)));
    const cached = await view(p.cookie);
    await sql`delete from progress_snapshots where user_id = ${p.id}`;
    const rebuilt = await view(p.cookie);
    expect(rebuilt).toEqual(cached);
    last = cached;
    await step('snapshot rebuild');

    // health_data withdrawn with "delete": every stall round goes (the Protein Counter one too), the snapshot with them; grants stay.
    expect((await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } })).statusCode).toBe(204);
    expect((await kinds(p.id)).filter((k) => k === 'stall_round')).toEqual([]);
    expect(await snapshotOf(p.id)).toBeUndefined();
    await step('health_data delete erasing every stall round');
    expectNoLower(peak, await view(p.cookie), 'against the peak');

    // A second boot with market_game retuned lower: grants fixed when made, nothing lowered.
    const base = defaultLoopContent();
    const lower: RewardsData = { ...base.rewards, xp: { ...base.rewards.xp, market_game: 1 }, stamps: { ...base.rewards.stamps, market_game: 0 } };
    await boot({ ...base, rewards: lower });
    await step('market_game retuned lower at a second boot');
  });
});

/** Every source file under apps/api/src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = join(dir, n);
    return statSync(f).isDirectory() ? sourceFiles(f) : f.endsWith('.ts') ? [f] : [];
  });
}
/** A write that changes or removes a grant: drizzle's update/delete on rewardGrants, or SQL on reward_grants. */
const MUTATES_GRANTS = /\.(update|delete)\(\s*(?:[\w$]+\.)*rewardGrants\b|\b(update|delete\s+from|truncate)\s+(?:only\s+)?(?:"?public"?\.)?"?reward_grants\b/i;

describe('reward_grants is append-only', () => {
  it('the grep bites on a planted update or delete', () => {
    for (const t of ['await tx.update(rewardGrants).set({ amount: 0 })', 'db.delete( rewardGrants ).where(x)', "sql`UPDATE reward_grants SET amount = 0`", 'sql`delete from "reward_grants"`', 'truncate reward_grants',
      // Fix round 1, Minor 2: through a namespace or a table alias, and with a schema-qualified name.
      'tx.delete(schema.rewardGrants).where(x)', 'db.update(t.rewardGrants).set({})', 'sql`delete from public.reward_grants`', 'sql`UPDATE ONLY "public"."reward_grants" SET body = 1`']) {
      expect(MUTATES_GRANTS.test(t), t).toBe(true);
    }
    for (const t of ['tx.insert(rewardGrants).values(g)', 'db.select().from(rewardGrants)', '-- reward_grants is append-only']) expect(MUTATES_GRANTS.test(t), t).toBe(false);
  });

  it('no code path in apps/api/src updates or deletes a grant', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => /rewardGrants/.test(readFileSync(f, 'utf8'))).length, 'the grep reads the files that use the table').toBeGreaterThan(0);
    expect(files.filter((f) => MUTATES_GRANTS.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f))).toEqual([]);
  });

  it('the database refuses an UPDATE of a grant; the account-delete cascade still removes them', async () => {
    await boot();
    const p = await player();
    await post(p.cookie, [cooked(PARIPPU, TODAY)]);
    const before = await grantRows(p.id);
    expect(before.length).toBeGreaterThan(0);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_trigger where tgname = 'reward_grants_append_only' and not tgisinternal`;
    expect(n).toBe(1);
    await expect(sql`update reward_grants set body = '{}'::jsonb where user_id = ${p.id}`).rejects.toThrow(/reward_grants is append-only: UPDATE/);
    await expect(sql`update reward_grants set kind = kind where user_id = ${p.id}`).rejects.toThrow(/append-only/);
    expect(await grantRows(p.id)).toEqual(before);
    expect((await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);
    expect(await grantRows(p.id)).toEqual([]);
  });
});

// M6 Step 7 (Ruling 18, §6): the snapshot is a cache. For any history (random events, erasures of meal-log and
// stall-round events, rewards retunes), what the snapshot plus its tail gives equals what the whole ledgers give:
// the grants each next event earns (grantsForBatch) and the view (deriveProgress). The model is the API's: a
// snapshot is written once the tail passes a threshold (small here; SNAPSHOT_EVERY in the API), any erase drops it
// (the trigger), a different catalogue hash ignores it, and the tail's grants are those of the tail's events.
/** The property's fixed seed, and what it covers with that seed (measured once; a change to the arbitraries re-measures). */
const SNAPSHOT_PROPERTY_SEED = 20261112;
const SNAPSHOT_PROPERTY_COVERAGE = { accepted: 1718, fromSnapshot: 247, checked: 469 };

describe('snapshot equivalence (M6 Step 7)', () => {
  it('property: view(snapshot + tail) == view(full) over random histories with erasures (fast-check)', async () => {
    const loop = defaultLoopContent();
    const index = await createRecipeIndexSource().current(db);
    const cat = catalogueFor(index, loop);
    const rules: RulesContext = { rules: [], graph: catalog.graph, subs: [...catalog.substitutions], recipes: index };
    const recipes = [PARIPPU, ONIGIRI, FRIJOLES];
    const wen = [...loop.market.stalls.get('wen')!.questions].filter((q) => q.countries === undefined).slice(0, 6);
    const day = fc.integer({ min: 0, max: 20 }).map((n) => addDays(TODAY, -n));
    const event: fc.Arbitrary<ProgressEvent> = fc.oneof(
      fc.record({ kind: fc.constant('lesson' as const), at: day, recipe: fc.constantFrom(...recipes) }),
      fc.record({ kind: fc.constant('cooked' as const), at: day, recipe: fc.constantFrom(...recipes), planned: fc.boolean() }),
      fc.record({ kind: fc.constant('quest_step' as const), at: day, quest: fc.constant('leela-tempering'), step: fc.integer({ min: 1, max: 6 }) }),
      fc.record({ kind: fc.constant('quest_done' as const), at: day, quest: fc.constant('leela-tempering') }),
      fc.record({ kind: fc.constant('market_run' as const), at: day, weekStart: fc.constant('2026-11-09') }),
      fc.record({ kind: fc.constant('meal_logged' as const), at: day, minute: fc.integer({ min: 0, max: 1439 }), mealLogId: fc.uuid() }),
      fc.record({
        kind: fc.constant('stall_round' as const),
        at: day,
        stall: fc.constant('wen'),
        answers: fc.uniqueArray(fc.constantFrom(...wen), { minLength: 1, maxLength: 3, selector: (q) => q.id }).chain((qs) =>
          fc.tuple(...qs.map((q) => fc.integer({ min: 0, max: q.options.length - 1 }).map((pick) => ({ q: q.id, pick })))),
        ),
      }),
    ).chain((e) => fc.uuid().map((id) => ({ ...e, id })));
    const op = fc.oneof(
      { weight: 6, arbitrary: fc.record({ post: fc.array(event, { minLength: 1, maxLength: 6 }) }) },
      { weight: 2, arbitrary: fc.record({ erase: fc.nat() }) },
      { weight: 1, arbitrary: fc.record({ retune: fc.integer({ min: 1, max: 30 }) }) },
    );
    let accepted = 0;
    let fromSnapshot = 0;
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), fc.integer({ min: 1, max: 8 }), async (ops, every) => {
        let rewards: RewardsData = loop.rewards;
        let hash = catalogueHash(cat, rewards, loop.thresholds);
        const events: ProgressEvent[] = [];
        const grants: RewardGrant[] = [];
        let snap: { base: ProgressSnapshot; upto: number; hash: string } | null = null;
        const full = (): ProgressHistory => ({ events, grants, base: null });
        const cached = (): ProgressHistory => {
          if (snap === null || snap.hash !== hash) return full();
          const tail = events.slice(snap.upto);
          const ids = new Set(tail.map((e) => e.id));
          return { events: tail, grants: grants.filter((g) => ids.has(g.eventId)), base: snap.base };
        };
        // Fix round 1 (Task 9 review, flakes): with no usable snapshot, cached() IS the full history, so comparing it with
        // itself proves nothing and only costs time; the equivalence is checked on every op that reads a snapshot.
        const usable = () => snap !== null && snap.hash === hash;
        for (const o of ops) {
          if ('post' in o) {
            const a = grantsForBatch(o.post, full(), cat, rewards, loop.thresholds, rules);
            if (usable()) {
              const b = grantsForBatch(o.post, cached(), cat, rewards, loop.thresholds, rules);
              expect(b).toEqual(a);
              fromSnapshot += 1;
            }
            for (const r of a.filter((x) => x.problems.length === 0)) {
              events.push(r.event);
              grants.push(...r.grants);
              accepted += 1;
            }
            // maybeWriteSnapshot: past the threshold since the usable snapshot (or the start), fold and upsert.
            const since = snap !== null && snap.hash === hash ? snap.upto : 0;
            if (events.length - since > every) {
              const base = compactHistory(cached(), 0, cat).base;
              if (base !== null) snap = { base: JSON.parse(JSON.stringify(base)) as ProgressSnapshot, upto: events.length, hash };
            }
          } else if ('erase' in o) {
            // A meal-log undo or a health_data delete: only those kinds are ever erased; grants stay; the trigger drops the snapshot.
            const erasable = events.map((e, i) => [e, i] as const).filter(([e]) => e.kind === 'meal_logged' || e.kind === 'stall_round');
            if (erasable.length === 0) continue;
            events.splice(erasable[o.erase % erasable.length][1], 1);
            snap = null;
          } else {
            rewards = { ...rewards, xp: { ...rewards.xp, lesson: o.retune, cook: o.retune + 1, market_game: o.retune } };
            hash = catalogueHash(cat, rewards, loop.thresholds);
          }
          if (usable()) {
            checked += 1;
            expect(deriveProgress(cached(), cat)).toEqual(deriveProgress(full(), cat));
          }
        }
      }),
      // A fixed seed (fix round 1): the same histories every run, so a failure replays and the coverage is a fixed
      // number. FAST_CHECK_SEED=random fuzzes locally with a fresh seed (printed by fast-check on failure).
      { numRuns: 150, endOnFailure: true, ...(process.env.FAST_CHECK_SEED === 'random' ? {} : { seed: SNAPSHOT_PROPERTY_SEED }) },
    );
    // The property ran on real histories: events were accepted, posts were judged from a snapshot, and views compared.
    if (process.env.FAST_CHECK_SEED !== 'random') {
      expect({ accepted, fromSnapshot, checked }).toEqual(SNAPSHOT_PROPERTY_COVERAGE);
    } else {
      expect(accepted).toBeGreaterThan(500);
      expect(fromSnapshot).toBeGreaterThan(50);
    }
  });
});
