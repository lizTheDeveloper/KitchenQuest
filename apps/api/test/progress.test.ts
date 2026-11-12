// M5 Step 5: progress events and append-only reward grants, computed by core, entitlement-blind (Ruling 7, spec §6).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveProgress, grantsForBatch, type ProgressEvent, type ProgressView, type RewardGrant } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent, loadLoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { ADVISORY_LOCK } from '../src/db/advisory-locks.js';
import { progressEvents, rewardGrants } from '../src/db/schema.js';
import { grant as grantEntitlement } from '../src/entitlements/entitlements.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { catalogueFor } from '../src/progress/catalogue.js';
import { PROGRESS_REQUESTS_PER_MINUTE } from '../src/progress/routes.js';
import { MAX_EVENTS_PER_REQUEST } from '../src/progress/service.js';
import { WRITES_PER_DAY } from '../src/usage/write-cap.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { captureLogs } from './helpers/logs.js';

const config = testConfig();
const catalog = defaultCatalog();
const loop = defaultLoopContent();
const NOW = new Date('2026-11-10T12:00:00Z');
const TODAY = '2026-11-10';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const DAY_MS = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

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
beforeEach(async () => {
  mailer = new CaptureMailer();
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
});
afterEach(async () => {
  await app?.close();
});

const call = (cookie: string | null, opts: InjectOptions) => app.inject({ ...opts, ...(cookie ? { cookies: { kq_session: cookie } } : {}) });

interface Posted {
  accepted: { clientId: string; grants: RewardGrant[] }[];
  duplicate: string[];
  rejected: { clientId: string; problems: string[] }[];
  warnings: { clientId: string; warnings: string[] }[];
  view: ProgressView;
}

async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `progress${++seq}@example.com`);
  const id = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  return { cookie, id };
}

async function post(cookie: string, events: unknown[], upload?: true): Promise<Posted> {
  const res = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events, ...(upload ? { upload } : {}) } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json<Posted>();
}

const view = async (cookie: string) => (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
const rows = async (userId: string) => ({
  events: await db.select().from(progressEvents).where(eq(progressEvents.userId, userId)),
  grants: await db.select().from(rewardGrants).where(eq(rewardGrants.userId, userId)),
});

const eid = (): string => randomUUID();
const cooked = (recipe: string, at = TODAY, id = eid()): ProgressEvent => ({ id, kind: 'cooked', at, recipe, planned: false });
/** A meal-log event; `mealLogId` must be the player's own log of `at` for it to be accepted (I1). */
const meal = (minute: number, mealLogId: string = eid(), at = TODAY, id = eid()): ProgressEvent => ({ id, kind: 'meal_logged', at, minute, mealLogId });
const lesson = (recipe: string, at = TODAY, id = eid()): ProgressEvent => ({ id, kind: 'lesson', at, recipe });

async function consent(cookie: string) {
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
  expect(res.statusCode).toBe(201);
}
/** Logs a meal through POST /meals (needs health_data) and returns its id. */
async function logMeal(cookie: string, eatenOn = TODAY): Promise<string> {
  const res = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn, slot: 'lunch', item: { kind: 'free', description: 'soup' } }, confirmed: true } });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ meal: { id: string } }>().meal.id;
}
/** Leela's quest, steps 1–6 and done (her quest has no `requires`). */
const leelaQuest = (at = TODAY): ProgressEvent[] => [
  ...Array.from({ length: 6 }, (_, i): ProgressEvent => ({ id: eid(), kind: 'quest_step', at, quest: 'leela-tempering', step: i + 1 })),
  { id: eid(), kind: 'quest_done', at, quest: 'leela-tempering' },
];

const RANK = { seen: 0, tried: 1, yours: 2 } as const;
function expectNoLower(lower: ProgressView, higher: ProgressView) {
  expect(higher.xp).toBeGreaterThanOrEqual(lower.xp);
  expect(higher.level).toBeGreaterThanOrEqual(lower.level);
  expect(higher.stamps).toBeGreaterThanOrEqual(lower.stamps);
  for (const [cook, t] of Object.entries(lower.trust)) expect(higher.trust[cook] ?? 0).toBeGreaterThanOrEqual(t);
  for (const [id, r] of Object.entries(lower.toolkit.techniques)) {
    expect(higher.toolkit.techniques[id], id).toBeDefined();
    expect(RANK[higher.toolkit.techniques[id].tier]).toBeGreaterThanOrEqual(RANK[r.tier]);
  }
  for (const q of lower.questsDone) expect(higher.questsDone).toContain(q);
  for (const [q, s] of Object.entries(lower.questSteps)) expect(higher.questSteps[q] ?? 0).toBeGreaterThanOrEqual(s);
  for (const [r, ds] of Object.entries(lower.cookedOn)) expect(higher.cookedOn[r]).toEqual(expect.arrayContaining(ds));
}

describe('POST /progress/events and GET /progress', () => {
  it('needs a session', async () => {
    expect((await call(null, { method: 'GET', url: '/progress' })).statusCode).toBe(401);
    expect((await call(null, { method: 'POST', url: '/progress/events', payload: { events: [] } })).statusCode).toBe(401);
  });

  it('a cooked event returns cook XP, Tried, and stores event + grants; GET /progress shows the view', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    const r = await post(p.cookie, [e]);
    expect(r.rejected).toEqual([]);
    expect(r.accepted).toEqual([{ clientId: e.id, grants: [{ id: `${e.id}#0`, eventId: e.id, isoDay: TODAY, kind: 'xp', amount: loop.rewards.xp.cook, reason: 'cook' }] }]);
    expect(r.view.xp).toBe(loop.rewards.xp.cook);
    for (const t of ['legumes', 'heat-control', 'tempering']) expect(r.view.toolkit.techniques[t].tier).toBe('tried');
    expect(r.view.cookedOn).toEqual({ [PARIPPU]: [TODAY] });

    const stored = await rows(p.id);
    expect(stored.events).toEqual([
      expect.objectContaining({ clientId: e.id, kind: 'cooked', at: TODAY, body: { recipe: PARIPPU, planned: false }, createdAt: NOW }),
    ]);
    expect(stored.grants).toEqual([
      expect.objectContaining({ eventId: stored.events[0].id, kind: 'xp', body: { id: `${e.id}#0`, eventId: e.id, isoDay: TODAY, amount: 30, reason: 'cook' } }),
    ]);

    expect(await view(p.cookie)).toEqual(r.view);
    // GET /progress is a self-read of 'progress' (C-5).
    const reads = await sql`select resource, count from self_read_counts where user_id = ${p.id}`;
    expect(reads).toEqual([{ resource: 'progress', count: 1 }]);
  });

  it('replaying the same client_id is a duplicate: no second grant (offline replay, sign-in upload)', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    await post(p.cookie, [e]);
    const again = await post(p.cookie, [e, { ...e }]);
    expect(again).toMatchObject({ accepted: [], duplicate: [e.id, e.id], rejected: [] });
    const up = await post(p.cookie, [e], true);
    expect(up).toMatchObject({ accepted: [], duplicate: [e.id] });
    expect((await rows(p.id)).grants).toHaveLength(1);
    // The same id twice in one new batch: the first is recorded, the second is a duplicate.
    const f = cooked(ONIGIRI);
    expect(await post(p.cookie, [f, f])).toMatchObject({ accepted: [{ clientId: f.id }], duplicate: [f.id] });
    const stored = await rows(p.id);
    expect(stored.events).toHaveLength(2);
    // Each grant belongs to the one event that earned it, once.
    expect(new Set(stored.grants.map((g) => (g.body as { id: string }).id)).size).toBe(stored.grants.length);
  });

  it('a forged quest_done without its steps, an unknown recipe, a future date → rejected, nothing stored', async () => {
    const p = await player();
    const forged = { id: eid(), kind: 'quest_done', at: TODAY, quest: 'leela-tempering' };
    const unknown = cooked('france/paris/croissant');
    const future = cooked(PARIPPU, addDays(TODAY, 2));
    const notADate = cooked(PARIPPU, '2026-02-30');
    const r = await post(p.cookie, [forged, unknown, future, notADate]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        { clientId: forged.id, problems: ['quest_not_finished'] },
        { clientId: unknown.id, problems: ['unknown_recipe'] },
        { clientId: future.id, problems: ['bad_date'] },
        { clientId: notADate.id, problems: ['bad_date'] },
      ]),
    );
    expect(r.rejected).toHaveLength(4);
    expect(await rows(p.id)).toEqual({ events: [], grants: [] });
    expect(r.view.xp).toBe(0);
  });

  it('a body with { xp: 999 } or an unknown key → 400; an event outside its shape is rejected; no client-chosen amount is ever stored', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    for (const payload of [
      { events: [e], xp: 999 },
      { events: [e], grants: [{ kind: 'xp', amount: 999 }] },
      { events: [e], upload: false },
      { events: 'nope' },
      { events: Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => meal(0)) },
      {},
    ]) {
      const res = await call(p.cookie, { method: 'POST', url: '/progress/events', payload });
      expect(res.statusCode, JSON.stringify(payload).slice(0, 60)).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('bad_request');
    }
    expect(await rows(p.id)).toEqual({ events: [], grants: [] });

    // Inside an event, any key outside core's shape rejects that event only (never the batch, C14).
    const withXp = { ...cooked(PARIPPU), xp: 999 };
    const withLevel = { ...meal(600), level: 9 };
    const withTrust = { id: eid(), kind: 'quest_step', at: TODAY, quest: 'leela-tempering', step: 1, trust: 5 };
    const ruleFiled = { id: eid(), kind: 'rule_filed', at: TODAY };
    const good = cooked(ONIGIRI);
    const r = await post(p.cookie, [withXp, withLevel, withTrust, ruleFiled, good, 'nope', null]);
    expect(r.rejected).toEqual([
      { clientId: withXp.id, problems: ['bad_event'] },
      { clientId: withLevel.id, problems: ['bad_event'] },
      { clientId: withTrust.id, problems: ['bad_event'] },
      // No event kind exists for rules, consents or profile edits (spec §6).
      { clientId: ruleFiled.id, problems: ['unknown_kind'] },
      { clientId: '', problems: ['bad_event'] },
      { clientId: '', problems: ['bad_event'] },
    ]);
    expect(r.accepted.map((a) => a.clientId)).toEqual([good.id]);
    const stored = await rows(p.id);
    expect(stored.events.map((ev) => ev.clientId)).toEqual([good.id]);
    // M6 Step 6: stall_round is a stored kind now (the Step 3 exclusion is gone), with its own strict shape.
    const roundShape = { id: eid(), kind: 'stall_round', at: TODAY, stall: 'wen', answers: [{ q: 'wen-avocado-ripe', pick: 0 }] };
    const roundForged = { ...roundShape, id: eid(), correct: 1 };
    const rr = await post(p.cookie, [roundShape, roundForged]);
    expect(rr.accepted.map((a) => a.clientId)).toEqual([roundShape.id]);
    expect(rr.rejected).toEqual([{ clientId: roundForged.id, problems: ['bad_event'] }]);
    expect([...stored.events, ...stored.grants].flatMap((r) => Object.values(r.body as Record<string, unknown>))).not.toContain(999);
    expect(stored.grants.map((g) => g.body)).toEqual([expect.objectContaining({ amount: loop.rewards.xp.cook })]);
  });

  it('201 events for one day → the 201st rejected with too_many_events; the other 200 and other dates stored (per event, C14)', async () => {
    const p = await player();
    const day = addDays(TODAY, -1);
    const many = Array.from({ length: 201 }, (_, i) => lesson([PARIPPU, ONIGIRI, FRIJOLES][i % 3], day));
    const other = lesson(PARIPPU, TODAY);
    await post(p.cookie, many.slice(0, 100));
    await post(p.cookie, many.slice(100, 200));
    const r = await post(p.cookie, [many[200], other]);
    expect(r.rejected).toEqual([{ clientId: many[200].id, problems: ['too_many_events'] }]);
    expect(r.accepted.map((a) => a.clientId)).toEqual([other.id]);
    const stored = await rows(p.id);
    expect(stored.events.filter((e) => e.at === day)).toHaveLength(200);
    expect(stored.events.filter((e) => e.at === TODAY)).toHaveLength(1);
  });

  it('a live post with at 40 days ago → rejected; the same event with upload: true → accepted and idempotent; imported without upload → rejected', async () => {
    const p = await player();
    const old = cooked(PARIPPU, addDays(TODAY, -40));
    const edge = cooked(ONIGIRI, addDays(TODAY, -30));
    expect(await post(p.cookie, [old, edge])).toMatchObject({ rejected: [{ clientId: old.id, problems: ['bad_date'] }], accepted: [{ clientId: edge.id }] });
    expect(await post(p.cookie, [old], true)).toMatchObject({ accepted: [{ clientId: old.id }], rejected: [] });
    expect(await post(p.cookie, [old], true)).toMatchObject({ accepted: [], duplicate: [old.id] });
    // An upload still refuses a date past tomorrow, and still checks the catalogue.
    const future = cooked(PARIPPU, addDays(TODAY, 2));
    const unknown = cooked('nowhere/dish', addDays(TODAY, -200));
    expect((await post(p.cookie, [future, unknown], true)).rejected).toEqual([
      { clientId: future.id, problems: ['bad_date'] },
      { clientId: unknown.id, problems: ['unknown_recipe'] },
    ]);
    const imported = { id: eid(), kind: 'imported', at: TODAY, technique: 'grains', tier: 'seen', firstAt: TODAY, lastUsedAt: TODAY, recipes: [] };
    expect((await post(p.cookie, [imported])).rejected).toEqual([{ clientId: imported.id, problems: ['upload_only'] }]);
  });

  it('a sign-in upload of a 2000-event device log spanning months → nothing lower than the device view (C14)', async () => {
    const p = await player();
    const start = addDays(TODAY, -200);
    const log: ProgressEvent[] = [...leelaQuest(start)];
    const recipes = [PARIPPU, ONIGIRI, FRIJOLES];
    for (let i = 0; log.length < 2000; i++) {
      const at = addDays(start, Math.floor(i / 10));
      const k = i % 10;
      if (k === 0) log.push({ id: eid(), kind: 'lesson', at, recipe: recipes[i % 3] });
      else if (k <= 2) log.push(cooked(recipes[(i + k) % 3], at));
      else if (k === 3) log.push({ id: eid(), kind: 'market_run', at, weekStart: at });
      else log.push(lesson(recipes[k % 3], at));
    }
    // The device's own view: core over the same log, as the game folds it (Step 9).
    const cat = catalogueFor(await createRecipeIndexSource().current(db), loop);
    const results = grantsForBatch(log, { events: [], grants: [], base: null }, cat, loop.rewards, loop.thresholds);
    const device = deriveProgress(
      { events: results.filter((r) => r.problems.length === 0).map((r) => r.event), grants: results.flatMap((r) => r.grants), base: null },
      cat,
    );
    expect(device.xp).toBeGreaterThan(1000);
    expect(device.trust.leela).toBeGreaterThanOrEqual(2);

    for (let i = 0; i < log.length; i += 100) {
      const r = await post(p.cookie, log.slice(i, i + 100), true);
      expect(r.rejected).toEqual([]);
    }
    const account = await view(p.cookie);
    expectNoLower(device, account);
    // And the upload again is a no-op.
    const again = await post(p.cookie, log.slice(0, 100), true);
    expect(again.accepted).toEqual([]);
    expect(again.duplicate).toHaveLength(100);
    expectNoLower(account, await view(p.cookie));
  });

  it('two concurrent posts of the same new event → exactly one grant (advisory lock + unique)', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    const [a, b] = await Promise.all([post(p.cookie, [e]), post(p.cookie, [e])]);
    expect([a.accepted.length, b.accepted.length].sort()).toEqual([0, 1]);
    expect([...a.duplicate, ...b.duplicate]).toEqual([e.id]);
    const stored = await rows(p.id);
    expect(stored.events).toHaveLength(1);
    expect(stored.grants).toHaveLength(1);
  });

  it('Guild entitlement vs free: identical events → identical grants and view (never rule 3)', async () => {
    const free = await player();
    const guild = await player();
    await grantEntitlement(db, guild.id, 'guild', 'manual', new Date('2026-01-01T00:00:00Z'));
    await grantEntitlement(db, guild.id, 'founding', 'manual', new Date('2026-01-01T00:00:00Z'));
    const events = [...leelaQuest(addDays(TODAY, -8)), cooked(PARIPPU, addDays(TODAY, -8)), cooked(PARIPPU, TODAY), { id: eid(), kind: 'market_run', at: TODAY, weekStart: TODAY }];
    const a = await post(free.cookie, events);
    const b = await post(guild.cookie, events);
    expect(b).toEqual(a);
    expect(a.view.trust.leela).toBe(2);
    expect(await view(guild.cookie)).toEqual(await view(free.cookie));
  });

  it('a quest_step of a quest whose unlock.requires is not done → rejected (C4)', async () => {
    const p = await player();
    const step = { id: eid(), kind: 'quest_step', at: TODAY, quest: 'marisol-salt-question', step: 1 };
    expect((await post(p.cookie, [step])).rejected).toEqual([{ clientId: step.id, problems: ['quest_waiting'] }]);
    // Once Leela's quest (the one it requires) is done, the same step is accepted.
    await post(p.cookie, leelaQuest());
    expect((await post(p.cookie, [{ ...step, id: eid() }])).rejected).toEqual([]);
  });

  it('a standsInFor claim that does not hold for the player is dropped, never the event, with a warning', async () => {
    const p = await player();
    const e = { ...cooked(ONIGIRI), standsInFor: ['leela'] };
    const r = await post(p.cookie, [e]);
    expect(r.accepted).toEqual([{ clientId: e.id, grants: [expect.objectContaining({ kind: 'xp', reason: 'cook' })] }]);
    expect(r.warnings).toEqual([{ clientId: e.id, warnings: ['stand_in_dropped'] }]);
    const [stored] = (await rows(p.id)).events;
    expect(stored.body).toEqual({ recipe: ONIGIRI, planned: false });
  });

  it('imported M3 toolkit events rebuild tiers and grant nothing; a second import of the same technique is a duplicate', async () => {
    const p = await player();
    const legumes = { id: eid(), kind: 'imported', at: TODAY, technique: 'legumes', tier: 'yours', firstAt: '2026-03-01', lastUsedAt: '2026-10-01', recipes: [PARIPPU, FRIJOLES] };
    const shaping = { id: eid(), kind: 'imported', at: TODAY, technique: 'shaping', tier: 'tried', firstAt: '2026-03-01', lastUsedAt: '2026-10-01', recipes: [ONIGIRI] };
    const r = await post(p.cookie, [legumes, shaping], true);
    expect(r.accepted).toEqual([
      { clientId: legumes.id, grants: [] },
      { clientId: shaping.id, grants: [] },
    ]);
    expect(r.view.toolkit.techniques.legumes.tier).toBe('yours');
    expect(r.view.toolkit.techniques.shaping.tier).toBe('tried');
    expect(r.view).toMatchObject({ xp: 0, stamps: 0, level: 1 });
    expect((await rows(p.id)).grants).toEqual([]);
    const again = { ...legumes, id: eid(), tier: 'seen', recipes: [] };
    expect(await post(p.cookie, [again], true)).toMatchObject({ accepted: [], duplicate: [again.id], rejected: [] });
    // A laundered record (a tier the recipes don't earn) is rejected.
    const forged = { id: eid(), kind: 'imported', at: TODAY, technique: 'grains', tier: 'yours', firstAt: TODAY, lastUsedAt: TODAY, recipes: [] };
    expect((await post(p.cookie, [forged], true)).rejected).toEqual([{ clientId: forged.id, problems: ['bad_field'] }]);
  });
});

describe('nothing earned is taken back (spec §6)', () => {
  it('deleting a meal log, withdrawing health_data with delete, and rule edits leave reward_grants untouched', async () => {
    const p = await player();
    await consent(p.cookie);
    const lunchLog = await logMeal(p.cookie);
    const dinnerLog = await logMeal(p.cookie);
    const lunch = meal(720, lunchLog);
    const dinner = meal(1140, dinnerLog);
    const cook = cooked(PARIPPU);
    expect((await post(p.cookie, [lunch, dinner, cook, ...leelaQuest()])).rejected).toEqual([]);
    const before = await rows(p.id);
    const viewBefore = await view(p.cookie);
    expect(viewBefore.xp).toBeGreaterThan(0);

    // Rule writes and edits earn nothing and change nothing.
    const rule = await call(p.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'allergy' }, confirmed: true } });
    expect(rule.statusCode).toBe(201);
    const ruleId = rule.json<{ rule: { id: string } }>().rule.id;
    expect((await call(p.cookie, { method: 'PUT', url: `/rules/${ruleId}`, payload: { rule: { target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' }, confirmed: true } })).statusCode).toBe(200);
    expect((await call(p.cookie, { method: 'DELETE', url: `/rules/${ruleId}` })).statusCode).toBe(204);
    expect((await rows(p.id)).grants).toEqual(before.grants);

    // A meal-log undo is DELETE /meals/:id alone (I1): the log's meal_logged event goes with it, server-side; the grants stay.
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${lunchLog}` })).statusCode).toBe(204);
    let now = await rows(p.id);
    expect(now.events.map((e) => e.clientId)).not.toContain(lunch.id);
    expect(now.events.map((e) => e.clientId)).toContain(dinner.id);
    expect(now.grants).toEqual(before.grants);
    // Nothing of the erased event is kept: no row holds its minute.
    expect(now.events.filter((e) => (e.body as { minute?: number }).minute === 720)).toEqual([]);
    // There is no route that erases a progress event by id.
    expect((await call(p.cookie, { method: 'DELETE', url: `/progress/events/${dinner.id}` })).statusCode).toBe(404);
    // An erased event's id stays seen through its grant: a replay is a duplicate, and earns nothing again.
    expect(await post(p.cookie, [lunch])).toMatchObject({ accepted: [], duplicate: [lunch.id] });
    // A new event for the deleted log is refused: the log is gone.
    expect((await post(p.cookie, [meal(800, lunchLog)])).rejected).toEqual([expect.objectContaining({ problems: ['unknown_meal_log'] })]);

    // A health_data withdraw-with-delete erases the meal_logged events (when they ate), never another kind or a grant.
    const withdraw = await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } });
    expect(withdraw.statusCode).toBe(204);
    now = await rows(p.id);
    expect(now.events.filter((e) => e.kind === 'meal_logged')).toEqual([]);
    expect(now.events.map((e) => e.clientId).sort()).toEqual(before.events.filter((e) => e.kind !== 'meal_logged').map((e) => e.clientId).sort());
    expect(now.grants).toEqual(before.grants);
    const viewAfter = await view(p.cookie);
    expect(viewAfter).toMatchObject({ xp: viewBefore.xp, level: viewBefore.level, stamps: viewBefore.stamps, trust: viewBefore.trust });

    // After the withdrawal, a queued meal-log event (the old dinner log, or any) stores nothing (I1 c).
    expect((await post(p.cookie, [meal(1200, dinnerLog)])).rejected).toEqual([expect.objectContaining({ problems: ['consent_required'] })]);
    expect((await rows(p.id)).events.filter((e) => e.kind === 'meal_logged')).toEqual([]);

    // With consent again, the day's nourishment cap still counts the erased logs' grants.
    await consent(p.cookie);
    const later = await post(p.cookie, [meal(0, await logMeal(p.cookie)), meal(400, await logMeal(p.cookie))]);
    const nourished = later.accepted.flatMap((a) => a.grants).filter((g) => g.kind === 'xp' && g.reason === 'nourishment');
    expect(nourished).toHaveLength(loop.rewards.xp.nourishment.max_per_day - 2);
  });
});

describe('meal-log events (I1)', () => {
  it('are accepted only with health_data, for the player\'s own log of that day, once per log; grants never copy the log id', async () => {
    const p = await player();
    // No consent: rejected per event, the rest of the batch recorded.
    const noConsent = meal(600);
    const other = cooked(PARIPPU);
    expect(await post(p.cookie, [noConsent, other])).toMatchObject({ rejected: [{ clientId: noConsent.id, problems: ['consent_required'] }], accepted: [{ clientId: other.id }] });

    await consent(p.cookie);
    const own = await logMeal(p.cookie);
    const yesterday = await logMeal(p.cookie, addDays(TODAY, -1));
    const someone = await player();
    await consent(someone.cookie);
    const theirs = await logMeal(someone.cookie);
    const forged = meal(600, randomUUID());
    const notMine = meal(600, theirs);
    const wrongDay = meal(600, yesterday);
    const ok = meal(600, own);
    const second = meal(900, own);
    const r = await post(p.cookie, [forged, notMine, wrongDay, ok, second]);
    expect(r.rejected).toEqual([
      { clientId: forged.id, problems: ['unknown_meal_log'] },
      { clientId: notMine.id, problems: ['unknown_meal_log'] },
      { clientId: wrongDay.id, problems: ['unknown_meal_log'] },
    ]);
    expect(r.accepted.map((a) => a.clientId)).toEqual([ok.id]);
    // One event per log: a second event for the same log is covered by the first.
    expect(r.duplicate).toEqual([second.id]);
    expect(await post(p.cookie, [meal(1000, own)])).toMatchObject({ accepted: [], duplicate: [expect.any(String)] });

    const stored = await rows(p.id);
    const event = stored.events.find((e) => e.clientId === ok.id)!;
    expect(event.mealLogId).toBe(own);
    expect(event.body).toEqual({ minute: 600 });
    expect(JSON.stringify(stored.grants)).not.toContain(own);
    // A missing mealLogId is outside the shape.
    const bare = { id: eid(), kind: 'meal_logged', at: TODAY, minute: 10 };
    expect((await post(p.cookie, [bare])).rejected).toEqual([{ clientId: bare.id, problems: ['bad_event'] }]);
  });
});

describe('grants hold no time finer than the day (I2)', () => {
  it('after a meal-log undo, no stored or exported field of its grant is finer than the day', async () => {
    const p = await player();
    await consent(p.cookie);
    const log = await logMeal(p.cookie);
    const e = meal(745, log);
    const [granted] = (await post(p.cookie, [e])).accepted[0].grants;
    expect(granted).toEqual({ id: `${e.id}#0`, eventId: e.id, isoDay: TODAY, kind: 'xp', amount: loop.rewards.xp.nourishment.per_log, reason: 'nourishment' });
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${log}` })).statusCode).toBe(204);
    const cols = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns where table_name = 'reward_grants'`;
    expect(cols.filter((c) => /time|date/.test(c.data_type))).toEqual([]);
    const [row] = await sql<{ body: Record<string, unknown> }[]>`select body from reward_grants where user_id = ${p.id}`;
    expect(Object.keys(row.body).sort()).toEqual(['amount', 'eventId', 'id', 'isoDay', 'reason']);
    const x = (await call(p.cookie, { method: 'GET', url: '/me/export' })).json<{ progress: { events: unknown[]; grants: Record<string, unknown>[] } }>();
    expect(x.progress.events).toEqual([]);
    expect(x.progress.grants).toEqual([granted]);
  });
});

describe('client ids are UUIDs (I3)', () => {
  it('an id that is not a UUID rejects the event and is not echoed', async () => {
    const p = await player();
    const named = { ...cooked(PARIPPU), id: 'meal-2026-11-10-1230-parippu' };
    const upper = cooked(ONIGIRI, TODAY, randomUUID().toUpperCase());
    const r = await post(p.cookie, [named, upper]);
    expect(r.rejected).toEqual([{ clientId: '', problems: ['bad_event'] }]);
    // One UUID is one event however it is spelled.
    expect(r.accepted.map((a) => a.clientId)).toEqual([upper.id.toLowerCase()]);
    expect(await post(p.cookie, [{ ...upper, id: upper.id.toLowerCase() }])).toMatchObject({ accepted: [], duplicate: [upper.id.toLowerCase()] });
    expect(JSON.stringify(await rows(p.id))).not.toContain('meal-2026');
  });
});

describe('abuse limits (I4)', () => {
  it('no event date before 2026-01-01, upload or not', async () => {
    const p = await player();
    const early = cooked(PARIPPU, '2025-12-31');
    const ancient = { id: eid(), kind: 'market_run', at: '0001-01-01', weekStart: '0001-01-01' };
    const first = cooked(ONIGIRI, '2026-01-01');
    const oldImport = { id: eid(), kind: 'imported', at: TODAY, technique: 'grains', tier: 'seen', firstAt: '2025-06-01', lastUsedAt: TODAY, recipes: [] };
    const r = await post(p.cookie, [early, ancient, first, oldImport], true);
    expect(r.rejected).toEqual([
      { clientId: early.id, problems: ['bad_date'] },
      { clientId: ancient.id, problems: ['bad_date'] },
      { clientId: oldImport.id, problems: ['bad_date'] },
    ]);
    expect(r.accepted.map((a) => a.clientId)).toEqual([first.id]);
  });

  it('limits progress requests per player per minute (429 rate_limited with retry-after)', async () => {
    const p = await player();
    for (let i = 0; i < PROGRESS_REQUESTS_PER_MINUTE; i++) expect((await call(p.cookie, { method: 'GET', url: '/progress' })).statusCode).toBe(200);
    const refused = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [cooked(PARIPPU)] } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: 'rate_limited', details: { retryAfterSeconds: expect.any(Number) } } });
    expect(refused.json().error.details.scope).toBeUndefined(); // M5 final m2: per-minute, not the daily cap
    expect(refused.headers['retry-after']).toBeDefined();
    expect((await rows(p.id)).events).toEqual([]);
    // Another player is not limited.
    expect((await call((await player()).cookie, { method: 'GET', url: '/progress' })).statusCode).toBe(200);
  });

  it('a daily write cap (the same for everyone, Guild or not) refuses the post with a 429, and drops nothing already earned', async () => {
    const p = await player();
    await grantEntitlement(db, p.id, 'guild', 'manual', new Date('2026-01-01T00:00:00Z'));
    const earned = await post(p.cookie, [cooked(PARIPPU)]);
    // Stand in for a day of posts: WRITES_PER_DAY recorded posts in the last day.
    await sql`insert into audit_events (at, actor_kind, actor_id, subject_user_id, action)
      select ${NOW.toISOString()}::timestamptz, 'user', ${p.id}, ${p.id}, 'progress.record' from generate_series(1, ${WRITES_PER_DAY - 1})`;
    const refused = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [cooked(ONIGIRI)] } });
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: { code: 'rate_limited', details: { retryAfterSeconds: expect.any(Number) } } });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(await view(p.cookie)).toEqual(earned.view);
    expect((await rows(p.id)).events).toHaveLength(1);
  });
});

describe('lock order (M2)', () => {
  /** Holds `progress:` for `userId` on another connection, runs `request`, and checks it waited on that lock. */
  async function waitsOnProgressLock(userId: string, request: () => Promise<{ statusCode: number }>): Promise<number> {
    const blocker = await sql.reserve();
    try {
      await blocker`begin`;
      await blocker`select pg_advisory_xact_lock(${ADVISORY_LOCK.progress}, hashtext(${userId}))`;
      const pending = request();
      for (let i = 0; ; i++) {
        const [w] = await sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`;
        if (w.n >= 1) break;
        if (i > 300) throw new Error('the request never waited on the progress: lock');
        await new Promise((r) => setTimeout(r, 10));
      }
      await blocker`commit`;
      return (await pending).statusCode;
    } finally {
      await blocker`rollback`.catch(() => {});
      blocker.release();
    }
  }

  it('a health_data withdraw-with-delete takes progress: before the consent row', async () => {
    const p = await player();
    await consent(p.cookie);
    await post(p.cookie, [meal(600, await logMeal(p.cookie))]);
    const status = await waitsOnProgressLock(p.id, () => call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } }));
    expect(status).toBe(204);
    expect((await rows(p.id)).events).toEqual([]);
  });

  it('a meal-log delete takes progress: before the meal log', async () => {
    const p = await player();
    await consent(p.cookie);
    const log = await logMeal(p.cookie);
    await post(p.cookie, [meal(600, log)]);
    expect(await waitsOnProgressLock(p.id, () => call(p.cookie, { method: 'DELETE', url: `/meals/${log}` }))).toBe(204);
    expect((await rows(p.id)).events).toEqual([]);
  });
});

describe('batch duplicates (M3)', () => {
  it('only an id or claim that was stored or accepted makes a duplicate', async () => {
    const p = await player();
    const id = eid();
    const bad = cooked('nowhere/dish', TODAY, id);
    const good = cooked(PARIPPU, TODAY, id);
    // The first is rejected by core, so the second with the same id is tried, and accepted.
    expect(await post(p.cookie, [bad, good])).toMatchObject({ rejected: [{ clientId: id, problems: ['unknown_recipe'] }], accepted: [{ clientId: id }], duplicate: [] });
    const forgedImport = { id: eid(), kind: 'imported', at: TODAY, technique: 'legumes', tier: 'yours', firstAt: TODAY, lastUsedAt: TODAY, recipes: [] };
    const realImport = { id: eid(), kind: 'imported', at: TODAY, technique: 'legumes', tier: 'tried', firstAt: TODAY, lastUsedAt: TODAY, recipes: [PARIPPU] };
    const thirdImport = { ...realImport, id: eid() };
    const r = await post(p.cookie, [forgedImport, realImport, thirdImport], true);
    expect(r.rejected).toEqual([{ clientId: forgedImport.id, problems: ['bad_field'] }]);
    expect(r.accepted.map((a) => a.clientId)).toEqual([realImport.id]);
    expect(r.duplicate).toEqual([thirdImport.id]);
  });
});

describe('export and account delete', () => {
  it('export has progress.events, progress.grants and view; DELETE /me leaves no progress_events or reward_grants row', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    const r = await post(p.cookie, [e]);
    const x = (await call(p.cookie, { method: 'GET', url: '/me/export' })).json<{ progress: { events: unknown[]; grants: unknown[]; view: ProgressView } }>();
    expect(x.progress.events).toEqual([{ ...e, createdAt: NOW.toISOString() }]);
    expect(x.progress.grants).toEqual(r.accepted[0].grants);
    expect(x.progress.view).toEqual(r.view);
    expect((await call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);
    expect(await sql`select 1 from progress_events where user_id = ${p.id}`).toHaveLength(0);
    expect(await sql`select 1 from reward_grants where user_id = ${p.id}`).toHaveLength(0);
  });
});

describe('logs (C-9)', () => {
  it('a progress post leaves no recipe slug or quest id in the captured logs', async () => {
    const logs = captureLogs();
    await app.close();
    app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: logs.logger });
    const p = await player();
    await post(p.cookie, [cooked(PARIPPU), ...leelaQuest(), { id: eid(), kind: 'quest_step', at: TODAY, quest: 'haruka-gluey-rice', step: 1 }]);
    await post(p.cookie, [{ ...cooked(FRIJOLES), extra: 'x' }]);
    await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [cooked(ONIGIRI)], xp: 999 } });
    await call(p.cookie, { method: 'GET', url: '/progress' });
    const text = logs.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/parippu|onigiri|frijoles|india\/kerala|leela-tempering|haruka-gluey-rice/i);
  });
});

describe('boot validation (C10)', () => {
  const REPO = fileURLToPath(new URL('../../../', import.meta.url));
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kq-loop-'));
    cpSync(join(REPO, 'data'), join(dir, 'data'), { recursive: true });
    cpSync(join(REPO, 'content'), join(dir, 'content'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const load = () => loadLoopContent(catalog, join(dir, 'data'), join(dir, 'content'));
  const edit = (rel: string, from: string | RegExp, to: string) => {
    const path = join(dir, rel);
    const text = readFileSync(path, 'utf8');
    const next = text.replace(from, to);
    expect(next, `${rel} edit`).not.toBe(text);
    writeFileSync(path, next);
  };

  it('loads the repository content', () => {
    const c = load();
    expect(c.cooks).toEqual(new Set(['haruka', 'leela', 'marisol']));
    expect(c.quests.map((q) => q.id)).toEqual(['haruka-gluey-rice', 'leela-tempering', 'marisol-salt-question']);
    expect(c.frames.map((f) => f.id)).toEqual(['fried-rice', 'green-sauce', 'quick-tomato-sauce']);
    expect(c.stalls).toEqual(new Set(['bram', 'okafor-sato', 'spice', 'wen']));
    // M6 Step 6: the stall files whole and the Season's Table, boot-checked.
    expect([...c.market.stalls.keys()]).toEqual(['bram', 'okafor-sato', 'spice', 'wen']);
    expect(Object.keys(c.market.seasonality)).toContain('pnw-usa');
    expect(c.thresholds).toEqual({ warmAfterDays: 42, rustyAfterDays: 120 });
  });

  it.each([
    ['rewards.yaml', 'data/rewards.yaml', 'levels: [100, 250', 'levels: [300, 250'],
    ['techniques.yaml', 'data/techniques.yaml', 'adjacent: [tempering], prereqs: []', 'adjacent: [juggling], prereqs: []'],
    ['techniques.yaml thresholds', 'data/techniques.yaml', 'rusty_after_days: 120', 'rusty_after_days: 10'],
    ['an invalid quest (a drill of an unknown technique)', 'content/cooks/leela.yaml', 'skill: knife', 'skill: juggling'],
    ['a frame', 'content/frames/fried-rice.yaml', 'technique: stir-fry', 'technique: juggling'],
    ['stalls.json', 'data/stalls.json', '"meat": "bram"', '"meat": "dairy"'],
    ['keeps.json', 'data/keeps.json', '"spinach": 3', '"spinach": 0'],
    ['food-groups.json', 'data/food-groups.json', '"egg": "protein"', '"egg": "dessert"'],
  ])('refuses bad %s, naming the file', (_label, rel, from, to) => {
    edit(rel, from, to);
    expect(load).toThrow(join(dir, rel));
  });

  it('refuses a stall id over 40 or a question id over 80 characters, the event caps (M6 Step 7, Task 6 review M2)', () => {
    const long = `wen-${'x'.repeat(77)}`; // 81
    edit('content/market/wen.yaml', /^ {2}- id: wen-avocado-ripe$/m, `  - id: ${long}`);
    expect(load).toThrow(new RegExp(`content/market/wen\\.yaml: .*question id "${long}" is longer than 80 characters`));
    // 80 is still fine.
    edit('content/market/wen.yaml', `  - id: ${long}`, `  - id: ${long.slice(0, 80)}`);
    expect(load).not.toThrow();
    const stall = 's'.repeat(41);
    const text = readFileSync(join(dir, 'content/market/spice.yaml'), 'utf8');
    rmSync(join(dir, 'content/market/spice.yaml'));
    writeFileSync(join(dir, `content/market/${stall}.yaml`), text.replace(/^id: spice$/m, `id: ${stall}`));
    expect(load).toThrow(new RegExp(`${stall}\\.yaml: stall id "${stall}" is longer than 40 characters`));
  });

  it('refuses YAML that does not parse, naming the file', () => {
    writeFileSync(join(dir, 'content/frames/green-sauce.yaml'), 'id: [unclosed');
    expect(load).toThrow(join(dir, 'content/frames/green-sauce.yaml'));
  });

  it('buildApp loads it at boot (deps.loop omitted) and starts', async () => {
    const own = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false });
    await own.close();
  });
});

describe('recipe index (C7)', () => {
  it("a recipe synced after boot is in the next request's Catalogue", async () => {
    const p = await player();
    const extra = 'india/kerala/parippu-again';
    const before = cooked(extra);
    expect((await post(p.cookie, [before])).rejected).toEqual([{ clientId: before.id, problems: ['unknown_recipe'] }]);

    const recipesDir = mkdtempSync(join(tmpdir(), 'kq-recipes-'));
    try {
      cpSync(RECIPES_DIR, recipesDir, { recursive: true });
      writeFileSync(join(recipesDir, `${extra}.cook`), readFileSync(join(RECIPES_DIR, `${PARIPPU}.cook`), 'utf8'));
      await syncCanon(db, recipesDir, catalog.graph, new Date(NOW.getTime() + 60_000));
      const after = cooked(extra);
      expect(await post(p.cookie, [after])).toMatchObject({ rejected: [], accepted: [{ clientId: after.id }] });
    } finally {
      rmSync(recipesDir, { recursive: true, force: true });
      // Back to the canon, so the rest of the file sees it unchanged; the removal is picked up too.
      await syncCanon(db, RECIPES_DIR, catalog.graph, new Date(NOW.getTime() + 120_000));
    }
    expect((await post(p.cookie, [cooked(extra)])).rejected).toEqual([expect.objectContaining({ problems: ['unknown_recipe'] })]);
  });

  it('a sync that drops a dish a quest names makes progress requests fail loudly, naming the quest (M5)', async () => {
    const p = await player();
    const recipesDir = mkdtempSync(join(tmpdir(), 'kq-recipes-'));
    try {
      cpSync(RECIPES_DIR, recipesDir, { recursive: true });
      rmSync(join(recipesDir, `${ONIGIRI}.cook`));
      await syncCanon(db, recipesDir, catalog.graph, new Date(NOW.getTime() + 180_000));
      const res = await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [cooked(PARIPPU)] } });
      expect(res.statusCode).toBe(500);
      expect((await call(p.cookie, { method: 'GET', url: '/progress' })).statusCode).toBe(500);
      expect((await rows(p.id)).events).toEqual([]);
      // The export never fails on content.
      expect((await call(p.cookie, { method: 'GET', url: '/me/export' })).statusCode).toBe(200);
    } finally {
      rmSync(recipesDir, { recursive: true, force: true });
      await syncCanon(db, RECIPES_DIR, catalog.graph, new Date(NOW.getTime() + 240_000));
    }
    expect((await call(p.cookie, { method: 'POST', url: '/progress/events', payload: { events: [cooked(PARIPPU)] } })).statusCode).toBe(200);
  });
});
