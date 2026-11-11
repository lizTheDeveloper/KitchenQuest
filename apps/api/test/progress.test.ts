// M5 Step 5: progress events and append-only reward grants, computed by core, entitlement-blind (Ruling 7, spec §6).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { progressEvents, rewardGrants } from '../src/db/schema.js';
import { grant as grantEntitlement } from '../src/entitlements/entitlements.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { catalogueFor } from '../src/progress/catalogue.js';
import { MAX_EVENTS_PER_REQUEST } from '../src/progress/service.js';
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

let n = 0;
const eid = () => `ev-${++n}`;
const cooked = (recipe: string, at = TODAY, id = eid()): ProgressEvent => ({ id, kind: 'cooked', at, recipe, planned: false });
const meal = (minute: number, at = TODAY, id = eid()): ProgressEvent => ({ id, kind: 'meal_logged', at, minute });
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
    expect(JSON.stringify(stored)).not.toContain('999');
    expect(stored.grants.map((g) => g.body)).toEqual([expect.objectContaining({ amount: loop.rewards.xp.cook })]);
  });

  it('201 events for one day → the 201st rejected with too_many_events; the other 200 and other dates stored (per event, C14)', async () => {
    const p = await player();
    const day = addDays(TODAY, -1);
    const many = Array.from({ length: 201 }, (_, i) => meal(i, day));
    const other = meal(0, TODAY);
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
    const unknown = cooked('nowhere/dish', addDays(TODAY, -400));
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
      else log.push(meal(k * 140, at));
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
    const events = [...leelaQuest(addDays(TODAY, -8)), cooked(PARIPPU, addDays(TODAY, -8)), cooked(PARIPPU, TODAY), meal(600), { id: eid(), kind: 'market_run', at: TODAY, weekStart: TODAY }];
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
    const consent = await call(p.cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'health_data', noticeVersion: NOTICES.health_data!.version } });
    expect(consent.statusCode).toBe(201);
    const logged = await call(p.cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn: TODAY, slot: 'lunch', item: { kind: 'free', description: 'soup' } }, confirmed: true } });
    expect(logged.statusCode).toBe(201);
    const lunch = meal(720);
    const dinner = meal(1140);
    const cook = cooked(PARIPPU);
    await post(p.cookie, [lunch, dinner, cook, ...leelaQuest()]);
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

    // A meal-log undo: the log goes, and its meal_logged event; the grants stay.
    const mealId = logged.json<{ meal: { id: string } }>().meal.id;
    expect((await call(p.cookie, { method: 'DELETE', url: `/meals/${mealId}` })).statusCode).toBe(204);
    expect((await call(p.cookie, { method: 'DELETE', url: `/progress/events/${lunch.id}` })).statusCode).toBe(204);
    // Only meal_logged events are ever erased, and only the player's own.
    expect((await call(p.cookie, { method: 'DELETE', url: `/progress/events/${cook.id}` })).statusCode).toBe(404);
    expect((await call(p.cookie, { method: 'DELETE', url: `/progress/events/${lunch.id}` })).statusCode).toBe(404);
    const other = await player();
    expect((await call(other.cookie, { method: 'DELETE', url: `/progress/events/${dinner.id}` })).statusCode).toBe(404);
    let now = await rows(p.id);
    expect(now.events.map((e) => e.clientId)).not.toContain(lunch.id);
    expect(now.events.map((e) => e.clientId)).toContain(dinner.id);
    expect(now.grants).toEqual(before.grants);
    expect(JSON.stringify(now.events)).not.toContain('720');
    // An erased event's id stays seen through its grant: a replay is a duplicate, and earns nothing again.
    expect(await post(p.cookie, [lunch])).toMatchObject({ accepted: [], duplicate: [lunch.id] });

    // A health_data withdraw-with-delete erases the meal_logged events (when they ate), never another kind or a grant.
    const withdraw = await call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'delete' } });
    expect(withdraw.statusCode).toBe(204);
    now = await rows(p.id);
    expect(now.events.filter((e) => e.kind === 'meal_logged')).toEqual([]);
    expect(now.events.map((e) => e.clientId).sort()).toEqual(before.events.filter((e) => e.kind !== 'meal_logged').map((e) => e.clientId).sort());
    expect(now.grants).toEqual(before.grants);
    const viewAfter = await view(p.cookie);
    expect(viewAfter).toMatchObject({ xp: viewBefore.xp, level: viewBefore.level, stamps: viewBefore.stamps, trust: viewBefore.trust });
    // The day's nourishment cap still counts the erased logs' grants.
    const later = await post(p.cookie, [meal(0), meal(400)]);
    const nourished = later.accepted.flatMap((a) => a.grants).filter((g) => g.kind === 'xp' && g.reason === 'nourishment');
    expect(nourished).toHaveLength(loop.rewards.xp.nourishment.max_per_day - 2);
  });
});

describe('export and account delete', () => {
  it('export has progress.events, progress.grants and view; DELETE /me leaves no progress_events or reward_grants row', async () => {
    const p = await player();
    const e = cooked(PARIPPU);
    const r = await post(p.cookie, [e]);
    const x = (await call(p.cookie, { method: 'GET', url: '/me/export' })).json<{ progress: { events: unknown[]; grants: unknown[]; view: ProgressView } }>();
    expect(x.progress.events).toEqual([{ ...e, createdAt: NOW.toISOString() }]);
    expect(x.progress.grants).toEqual(r.accepted[0].grants.map((g) => ({ ...g, createdAt: NOW.toISOString() })));
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
});
