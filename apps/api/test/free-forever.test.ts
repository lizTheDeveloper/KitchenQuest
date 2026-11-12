// M4 Step 12: the free-forever promise (§16, never rule 1, pre-flight C6, C30). A player with no
// entitlements, at the daily AI cap, without ai_health, with the global AI budget spent or the AI
// off, keeps every safety and logging feature, and the mentor never answers with 402 or 403.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { MarketRunView, Plan, ProgressEvent, ProgressView, RewardGrant, TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AiProvider } from '../src/ai/provider.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { NOTICES } from '../src/consent/notices.js';
import { aiCostHours, auditEvents, usageEvents } from '../src/db/schema.js';
import { grant as grantEntitlement } from '../src/entitlements/entitlements.js';
import { WRITES_PER_DAY } from '../src/usage/write-cap.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { FREE_AI_TURNS_PER_DAY } from '../src/mentor/constants.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testAiEnv, testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { fakeAi, toolCall } from './helpers/fake-ai.js';

const catalog = defaultCatalog();
const NOW = new Date('2026-11-10T18:00:00Z');
const TODAY = '2026-11-10';
const HOUR = 3_600_000;
/** step-12.md: no response sells. */
const SELLS = /\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i;
const FREE_NOTICES = ['needs_ai_health', 'rate_limited', 'ai_off'];

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;
/** Every mentor turn's response body in this file. */
const turnBodies: string[] = [];

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`delete from canon_recipes`;
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(async () => {
  mailer = new CaptureMailer();
  await sql`delete from ai_cost_hours`; // the global budget is spent only where a test says so
});
afterEach(async () => {
  await app?.close();
});

async function makeApp(ai: AiProvider | null) {
  const config = ai === null ? testConfig() : loadConfig(testAiEnv);
  app = await buildApp({ config, db, mailer, ai, now: () => NOW, logger: false });
}

/** Every response body in this file (fix round 1, M9: not only the mentor's). */
const allBodies: { url: string; body: string }[] = [];
async function call(cookie: string, opts: InjectOptions) {
  const res = await app.inject({ ...opts, cookies: { kq_session: cookie } });
  allBodies.push({ url: typeof opts.url === 'string' ? opts.url : '', body: res.body });
  return res;
}

/** No entitlements, the free cap used up in the last day. */
async function cappedFreePlayer() {
  const cookie = await signIn(app, mailer, `free${++seq}@example.com`);
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  for (let i = 0; i < FREE_AI_TURNS_PER_DAY; i++) {
    await db.insert(usageEvents).values({ userId, feature: 'mentor_text', units: 1, costMicroUsd: 0, createdAt: new Date(NOW.getTime() - HOUR) });
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from entitlements where user_id = ${userId}`;
  expect(n).toBe(0);
  return { cookie, userId };
}

const grant = (cookie: string, purpose: 'health_data' | 'ai_health') =>
  call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });

async function turn(cookie: string, text: string): Promise<TurnResponse> {
  const res = await call(cookie, {
    method: 'POST',
    url: '/mentor/turn',
    payload: { conversationId: null, input: { kind: 'text', text }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: null },
  });
  turnBodies.push(res.body);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<TurnResponse>();
}

/** Everything §16 keeps free, for this player, with no AI involved. */
async function everyFreeFeature(cookie: string) {
  expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
  const rule = await call(cookie, {
    method: 'POST',
    url: '/rules',
    payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }, confirmed: true },
  });
  expect(rule.statusCode).toBe(201);
  const meal = await call(cookie, {
    method: 'POST',
    url: '/meals',
    payload: { meal: { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast' } }, confirmed: true },
  });
  expect(meal.statusCode).toBe(201);
  const pantry = await call(cookie, {
    method: 'POST',
    url: '/pantry/changes',
    payload: { add: [{ name: 'rice', ingredientId: null }], removeNames: [], removeIds: [], confirmed: true },
  });
  expect(pantry.statusCode).toBe(200);
  expect((await call(cookie, { method: 'PUT', url: '/profile', payload: { marketDays: [6] } })).statusCode).toBe(200);
  // The recipe checks run for everyone: a coconut rule blocks nothing it shouldn't, and the check is there.
  const list = await call(cookie, { method: 'GET', url: `/recipes?date=${TODAY}` });
  expect(list.statusCode).toBe(200);
  expect(list.json<{ recipes: { check: { status: string } }[] }>().recipes.every((r) => typeof r.check.status === 'string')).toBe(true);
  const detail = await call(cookie, { method: 'GET', url: `/recipes/india/kerala/parippu?date=${TODAY}` });
  expect(detail.statusCode).toBe(200);
  expect(detail.json<{ check: { status: string } }>().check.status).toBe('blocked'); // parippu has coconut
  expect((await call(cookie, { method: 'GET', url: '/me/export' })).statusCode).toBe(200);
}

const deleteAccount = async (cookie: string) =>
  expect((await call(cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })).statusCode).toBe(204);

// ---- M5 Step 12: the weekly loop, with no AI ----
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
/** TODAY (a Tuesday) is in the plan week that starts Monday 2026-11-09 (no market day set). */
const WEEK = '2026-11-09';

/**
 * Everything the weekly loop keeps free, with no AI and no entitlement: plan the week (PUT /plans), open, tick and
 * finish the market run, cook (progress events), log the meal, write a margin note, record Cooked for Someone, read
 * the book's data, and export. `ids` fixes the events' client ids, so two players can send identical events.
 */
async function everyLoopFeature(cookie: string, ids: string[] = Array.from({ length: 12 }, () => randomUUID())) {
  const consents = (await call(cookie, { method: 'GET', url: '/me/consents' })).json<{ consents: { purpose: string; current: boolean }[] }>();
  if (!consents.consents.some((c) => c.purpose === 'health_data' && c.current)) expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
  const plan: Plan = {
    weekStart: WEEK, hard: false, slot: 'declined',
    items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 2, kind: 'dish', slug: ONIGIRI, servings: 2 }],
  };
  const saved = await call(cookie, { method: 'PUT', url: `/plans/${WEEK}`, payload: { plan, confirmed: true, today: TODAY } });
  expect(saved.statusCode, saved.body).toBe(200);
  const current = await call(cookie, { method: 'GET', url: `/plans/current?today=${TODAY}` });
  expect(current.statusCode).toBe(200);
  const got = current.json<{ plan: Plan; checks: { status: string }[] }>();
  expect(got.checks.every((c) => c.status === 'ok')).toBe(true);

  const opened = await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } });
  expect(opened.statusCode, opened.body).toBe(200);
  const run = opened.json<MarketRunView>();
  expect(run.items.length).toBeGreaterThan(0);
  const ticked = await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: run.items[0].key, ticked: true, today: TODAY } });
  expect(ticked.statusCode, ticked.body).toBe(200);
  const done = await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/finish`, payload: { confirmed: true, today: TODAY } });
  expect(done.statusCode, done.body).toBe(200);
  expect(done.json<MarketRunView>().doneAt).not.toBeNull();

  const meal = await call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn: TODAY, slot: 'dinner', item: { kind: 'dish', slug: ONIGIRI, servings: 1 } }, confirmed: true } });
  expect(meal.statusCode, meal.body).toBe(201);
  const mealLogId = meal.json<{ meal: { id: string } }>().meal.id;
  const events: ProgressEvent[] = [
    ...Array.from({ length: 6 }, (_, i): ProgressEvent => ({ id: ids[i], kind: 'quest_step', at: TODAY, quest: 'leela-tempering', step: i + 1 })),
    { id: ids[6], kind: 'quest_done', at: TODAY, quest: 'leela-tempering' },
    { id: ids[7], kind: 'market_run', at: TODAY, weekStart: WEEK },
    { id: ids[8], kind: 'lesson', at: TODAY, recipe: ONIGIRI },
    { id: ids[9], kind: 'cooked', at: TODAY, recipe: ONIGIRI, planned: true },
    { id: ids[10], kind: 'meal_logged', at: TODAY, minute: 1140, mealLogId },
  ];
  const posted = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events } });
  expect(posted.statusCode, posted.body).toBe(200);
  const result = posted.json<{ accepted: { clientId: string; grants: RewardGrant[] }[]; rejected: unknown[] }>();
  expect(result.rejected).toEqual([]);

  const note = await call(cookie, { method: 'POST', url: '/notes', payload: { note: { recipe: ONIGIRI, ops: [{ op: 'add', name: 'lime' }], text: 'a squeeze of lime', at: TODAY }, confirmed: true, today: TODAY } });
  expect(note.statusCode, note.body).toBe(201);
  const shared = await call(cookie, { method: 'POST', url: '/shared-table', payload: { entry: { cookedOn: TODAY, recipe: ONIGIRI, frame: null, cookedFor: { count: 'just_me', who: null } }, confirmed: true, today: TODAY } });
  expect(shared.statusCode, shared.body).toBe(201);

  // The book's data: progress, notes, the Shared Table tally.
  const view = (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
  expect(view.cookedOn[ONIGIRI]).toEqual([TODAY]);
  const notes = await call(cookie, { method: 'GET', url: '/notes' });
  expect(notes.json<{ notes: { text: string | null }[] }>().notes.map((n) => n.text)).toEqual(['a squeeze of lime']);
  expect((await call(cookie, { method: 'GET', url: '/shared-table/tally' })).statusCode).toBe(200);

  const exported = await call(cookie, { method: 'GET', url: '/me/export' });
  expect(exported.statusCode).toBe(200);
  expect(exported.body).toContain('a squeeze of lime');
  expect(exported.body).toContain(ONIGIRI);
  // Grants without their client-chosen ids, so two players' identical events compare equal.
  const grants = result.accepted.flatMap((a) => a.grants.map((g) => ({ ...g, id: g.id.replace(a.clientId, 'e'), eventId: 'e' })));
  return { plan: got.plan, view, grants };
}

// ---- M6 Step 11: the market is free forever (§16, never rules 3 and 7; X16) ----
const loop = defaultLoopContent();
type Q = { id: string; options: { correct?: boolean }[] };
/** The written right answer's file index (Ruling 2: `pick` is the option's index in file order). */
const right = (q: Q): number => q.options.findIndex((o) => o.correct === true);
const stallQs = (stall: string, n: number): Q[] => loop.market.stalls.get(stall)!.questions.slice(0, n) as Q[];
const pcQs = (n: number): Q[] => (loop.market.stalls.get('bram')!.variants!.protein_counter!.questions as Q[]).slice(0, n);
const seasonalQ = (id: string): Q =>
  Object.values(loop.market.stalls.get('wen')!.seasonal ?? {}).flatMap((m) => Object.values(m).flat()).find((q) => q.id === id) as Q;
/** One right and one wrong answer when the question allows it, else the right one. */
const answersFor = (qs: Q[]) => qs.map((q, i) => ({ q: q.id, pick: i === 1 ? (right(q) + 1) % q.options.length : right(q) }));
const VEGETARIAN = { target: { kind: 'category', ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid', severity: 'preference' };

/**
 * Everything the M6 market keeps free, with no AI and no entitlement: a round at every stall (the seasonal round for
 * a Washington, USA profile, and the Protein Counter under a vegetarian rule), the list with amounts, a stall swap,
 * a check-off by the scripted grammar (at the cap, AI off or on), a tick by tap, finish, and the export. `ids` fixes
 * the events' client ids, so two players can send identical events.
 */
async function everyMarketFeature(cookie: string, ids: string[] = Array.from({ length: 6 }, () => randomUUID())) {
  const consents = (await call(cookie, { method: 'GET', url: '/me/consents' })).json<{ consents: { purpose: string; current: boolean }[] }>();
  if (!consents.consents.some((c) => c.purpose === 'health_data' && c.current)) expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
  expect((await call(cookie, { method: 'PUT', url: '/profile', payload: { country: 'United States', region: 'Washington' } })).statusCode).toBe(200);
  const plan: Plan = { weekStart: WEEK, hard: false, slot: 'declined', items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }] };
  expect((await call(cookie, { method: 'PUT', url: `/plans/${WEEK}`, payload: { plan, confirmed: true, today: TODAY } })).statusCode).toBe(200);
  const opened = await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } });
  expect(opened.statusCode, opened.body).toBe(200);
  const run = opened.json<MarketRunView>();
  // List amounts, for free.
  expect(run.items.find((i) => i.key === 'moong_dal')?.amounts).toEqual([{ quantity: 100, unit: 'g', text: '100 g' }]);
  // A stall swap: the dal out of stock, red lentils taken (core's curated offer).
  const swap = await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/stock`, payload: { key: 'moong_dal', action: 'take', toId: 'red_lentil' } });
  expect(swap.statusCode, swap.body).toBe(200);
  expect(swap.json<MarketRunView>().items.some((i) => i.key === 'stock:red_lentil' && i.ticked)).toBe(true);
  // Check-off by the scripted grammar: ticked at once (C31), whatever the AI allowance says.
  const said = await turn(cookie, 'got the shallots');
  expect(said.route).toBe('deterministic');
  expect(said.cards.map((c) => c.card.kind)).toEqual(['check_off']);
  expect(said.actions.map((a) => a.kind)).toEqual(['confirmed']);
  // Check-off by tap, and the shop done.
  const garlic = await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/ticks`, payload: { key: 'garlic', ticked: true, today: TODAY } });
  expect(garlic.statusCode, garlic.body).toBe(200);
  const after = garlic.json<MarketRunView>();
  expect(after.items.filter((i) => i.ticked).map((i) => i.key).sort()).toEqual(['garlic', 'shallot', 'stock:red_lentil']);
  const done = await call(cookie, { method: 'POST', url: `/market-runs/${run.id}/finish`, payload: { confirmed: true, today: TODAY } });
  expect(done.statusCode, done.body).toBe(200);

  // A round at every stall: right and wrong answers alike, Wen's seasonal round for the PNW in November.
  const rounds: ProgressEvent[] = [
    { id: ids[0], kind: 'stall_round', at: TODAY, stall: 'wen', answers: [...answersFor(stallQs('wen', 2)), { q: 'wen-pnw-11-cranberry', pick: right(seasonalQ('wen-pnw-11-cranberry')) }] },
    { id: ids[1], kind: 'stall_round', at: TODAY, stall: 'okafor-sato', answers: answersFor(stallQs('okafor-sato', 3)) },
    { id: ids[2], kind: 'stall_round', at: TODAY, stall: 'spice', answers: answersFor(stallQs('spice', 3)) },
    { id: ids[3], kind: 'stall_round', at: TODAY, stall: 'bram', answers: answersFor(stallQs('bram', 3)) },
  ];
  const posted = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events: rounds } });
  expect(posted.statusCode, posted.body).toBe(200);
  const a = posted.json<{ accepted: { clientId: string; grants: RewardGrant[] }[]; rejected: unknown[] }>();
  expect(a.rejected).toEqual([]);
  // The Protein Counter, a full stall: a vegetarian rule, then its round (health_data granted above).
  expect((await call(cookie, { method: 'POST', url: '/rules', payload: { rule: VEGETARIAN, confirmed: true } })).statusCode).toBe(201);
  const pc: ProgressEvent = { id: ids[4], kind: 'stall_round', at: TODAY, stall: 'bram', answers: answersFor(pcQs(2)) };
  const posted2 = await call(cookie, { method: 'POST', url: '/progress/events', payload: { events: [pc] } });
  expect(posted2.statusCode, posted2.body).toBe(200);
  const b = posted2.json<{ accepted: { clientId: string; grants: RewardGrant[] }[]; rejected: unknown[] }>();
  expect(b.rejected).toEqual([]);

  const view = (await call(cookie, { method: 'GET', url: '/progress' })).json<{ view: ProgressView }>().view;
  const exported = await call(cookie, { method: 'GET', url: '/me/export' });
  expect(exported.statusCode).toBe(200);
  expect(exported.body).toContain('wen-pnw-11-cranberry');
  expect(exported.body).toContain(pcQs(1)[0].id);
  expect(exported.body).toContain('stock:red_lentil');
  const grants = [...a.accepted, ...b.accepted].flatMap((x) => x.grants.map((g) => ({ ...g, id: g.id.replace(x.clientId, 'e'), eventId: 'e' })));
  return { view, grants };
}

describe('free forever (§16)', () => {
  it('AI off and the global budget spent: every free feature works; the mentor is scripted (ai_off / needs_ai_health), never 402 or 403', async () => {
    await makeApp(null);
    await db.insert(aiCostHours).values({ hour: new Date(NOW.getTime() - HOUR), costMicroUsd: 1e9 }).onConflictDoNothing();
    const p = await cappedFreePlayer();
    await everyFreeFeature(p.cookie);
    const chat = await turn(p.cookie, 'what should I cook tonight?');
    expect(chat).toMatchObject({ route: 'scripted', notice: 'ai_off' });
    const health = await turn(p.cookie, "I'm allergic to sesame");
    expect(health.route).toBe('scripted');
    expect(FREE_NOTICES).toContain(health.notice);
    await deleteAccount(p.cookie);
  });

  it('AI on but the player is capped and has no ai_health: free features work; health text gets needs_ai_health, chat rate_limited', async () => {
    const ai = fakeAi([]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    await everyFreeFeature(p.cookie);
    expect(await turn(p.cookie, "I'm allergic to sesame")).toMatchObject({ route: 'scripted', notice: 'needs_ai_health' });
    expect(await turn(p.cookie, 'tell me a joke')).toMatchObject({ route: 'scripted', notice: 'rate_limited' });
    expect(ai.requests).toHaveLength(0);
    await deleteAccount(p.cookie);
  });

  it('AI help creating rules is never capped (C6): the capped player with ai_health gets a rule card; other chat is rate_limited', async () => {
    const ai = fakeAi([toolCall('propose_rule', { term: 'sesame', severity: 'allergy' })]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    expect((await grant(p.cookie, 'health_data')).statusCode).toBe(201);
    expect((await grant(p.cookie, 'ai_health')).statusCode).toBe(201);
    const rule = await turn(p.cookie, "I'm allergic to sesame");
    expect(rule.route).toBe('ai');
    expect(rule.cards.map((c) => c.card.kind)).toEqual(['rule']);
    const dinner = await turn(p.cookie, "what's for dinner?");
    expect(dinner).toMatchObject({ route: 'scripted', notice: 'rate_limited' });
    expect(ai.requests).toHaveLength(1);
  });

  // ---- M5 Step 12: the weekly loop is free forever (§16, never rules 3 and 7, Ruling 27, C26). ----

  it('M5: at the cap, "plan my week" is a scripted turn with no sells text (Ruling 27: plan intent is not moved ahead of the allowance)', async () => {
    const ai = fakeAi([]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    expect((await grant(p.cookie, 'health_data')).statusCode).toBe(201);
    const capped = await turn(p.cookie, 'plan my week: parippu on Sunday');
    expect(capped.route).toBe('scripted');
    expect(JSON.stringify(capped)).not.toMatch(SELLS);
    expect(ai.requests).toHaveLength(0);
    // The same player still plans the week through the form path (Form 7-W, PUT /plans): never a paywall.
    const loop = await everyLoopFeature(p.cookie);
    expect(loop.plan.items.map((i) => i.slug)).toContain(PARIPPU);
    await deleteAccount(p.cookie);
  });

  it('M5: AI off, capped, no entitlements: plan, market run, cook, log, note, Cooked for Someone, the book, export and delete all work', async () => {
    await makeApp(null);
    const p = await cappedFreePlayer();
    // AI off: code alone answers (a code-built plan card, or a scripted line); never the model, never a sale.
    const off = await turn(p.cookie, 'plan my week: parippu on Sunday');
    expect(['scripted', 'deterministic']).toContain(off.route);
    expect(JSON.stringify(off)).not.toMatch(SELLS);
    const loop = await everyLoopFeature(p.cookie);
    expect(loop.view.xp).toBeGreaterThan(0);
    expect(loop.view.stamps).toBeGreaterThan(0);
    await deleteAccount(p.cookie);
    expect((await call(p.cookie, { method: 'GET', url: '/progress' })).statusCode).toBe(401);
  });

  it('M5: a Guild player earns exactly the grants a free, capped player earns for the same loop (never rule 3)', async () => {
    await makeApp(null);
    const free = await cappedFreePlayer();
    const guildCookie = await signIn(app, mailer, `guild${++seq}@example.com`);
    const guildId = (await call(guildCookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
    await grantEntitlement(db, guildId, 'guild', 'manual', new Date(NOW.getTime() - HOUR));
    const ids = Array.from({ length: 12 }, () => randomUUID());
    const a = await everyLoopFeature(free.cookie, ids);
    const b = await everyLoopFeature(guildCookie, ids);
    expect(b.grants).toEqual(a.grants);
    expect(b.view).toEqual(a.view);
    expect(a.grants.length).toBeGreaterThan(5);
  });

  // ---- M6 Step 11: the market is free forever (§16, never rules 3 and 7; X16). ----

  it('M6: AI off, capped, no entitlements: every stall (seasonal and Protein Counter), amounts, a stall swap, the grammar check-off, a tap, export and delete', async () => {
    await makeApp(null);
    const p = await cappedFreePlayer();
    const m = await everyMarketFeature(p.cookie);
    // Five rounds: 5 XP a right first answer, one stamp a stall a week (Bram's two variants are one stall).
    expect(m.grants.filter((g) => g.kind === 'stamp').length).toBe(4);
    expect(m.view.xp).toBeGreaterThanOrEqual(5 * 6);
    expect(Object.keys(m.view.marketAnswered).length).toBeGreaterThan(0);
    await deleteAccount(p.cookie);
    expect((await call(p.cookie, { method: 'GET', url: '/progress' })).statusCode).toBe(401);
  });

  it('M6: AI on but capped (no ai_health): the grammar check-off still ticks, with no model call', async () => {
    const ai = fakeAi([]);
    await makeApp(ai);
    const p = await cappedFreePlayer();
    await everyMarketFeature(p.cookie);
    expect(ai.requests).toHaveLength(0);
    await deleteAccount(p.cookie);
  });

  it('M6: a Guild player earns exactly the grants a free, capped player earns for the same stall rounds (never rule 3)', async () => {
    await makeApp(null);
    const free = await cappedFreePlayer();
    const guildCookie = await signIn(app, mailer, `guild${++seq}@example.com`);
    const guildId = (await call(guildCookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
    await grantEntitlement(db, guildId, 'guild', 'manual', new Date(NOW.getTime() - HOUR));
    const ids = Array.from({ length: 6 }, () => randomUUID());
    const a = await everyMarketFeature(free.cookie, ids);
    const b = await everyMarketFeature(guildCookie, ids);
    expect(b.grants).toEqual(a.grants);
    expect(b.view).toEqual(a.view);
    expect(a.grants.length).toBeGreaterThan(5);
  });

  it('M6: the market code reads no entitlement (never rule 3)', () => {
    for (const rel of ['../src/week/market-service.ts', '../src/progress/service.ts', '../src/progress/catalogue.ts', '../src/mentor/check-off-turn.ts']) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src, rel).not.toMatch(/entitlement|guild|subscri/i);
    }
  });

  it('no response body in this file sells (never rule 7), the export\'s processor register aside', () => {
    expect(allBodies.length).toBeGreaterThan(20);
    for (const { url, body } of allBodies) {
      let text = body;
      // The export lists every processor in the register, the planned payment provider ("Guild billing") included:
      // a legal disclosure (GDPR Art. 15(1)(c)), not an offer. A Guild player's export (M5) also lists their own
      // entitlement rows, the record of what they hold (Art. 15(1)), not an offer. Everything else is scanned.
      if (url === '/me/export') {
        const { processors: _processors, entitlements: _entitlements, ...rest } = JSON.parse(body) as Record<string, unknown>;
        text = JSON.stringify(rest);
      }
      expect(text, url).not.toMatch(SELLS);
    }
  });

  it('no mentor response in this file sells (never rule 7)', () => {
    expect(turnBodies.length).toBe(8 + 4);
    for (const b of turnBodies) expect(b).not.toMatch(SELLS);
  });
});

describe('the daily write limit is an abuse limit, the same for every plan (M4 final, ruling M-4)', () => {
  it('a Guild player meets the 200-a-day meal-log limit exactly where a free player does: it is never a paid feature', async () => {
    await makeApp(null);
    const limitFor = async (guild: boolean) => {
      const cookie = await signIn(app, mailer, `cap${++seq}@example.com`);
      const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
      if (guild) await grantEntitlement(db, userId, 'guild', 'manual', new Date(NOW.getTime() - HOUR));
      expect((await grant(cookie, 'health_data')).statusCode).toBe(201);
      const at = new Date(NOW.getTime() - HOUR);
      const rows = (n: number) => Array.from({ length: n }, () => ({ at, actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'meals.create', target: 'x' }));
      const log = () => call(cookie, { method: 'POST', url: '/meals', payload: { meal: { eatenOn: TODAY, slot: 'breakfast', item: { kind: 'free', description: 'toast' } }, confirmed: true } });
      await db.insert(auditEvents).values(rows(WRITES_PER_DAY - 1));
      const last = await log();
      const over = await log();
      return [last.statusCode, over.statusCode];
    };
    expect(await limitFor(false)).toEqual([201, 429]);
    expect(await limitFor(true)).toEqual([201, 429]);
  });

  it('the limit reads no plan: the write-cap module never looks at entitlements', () => {
    const src = readFileSync(new URL('../src/usage/write-cap.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/entitlement|guild|GUILD|tier|plan/i);
  });
});
