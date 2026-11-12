// M5 Step 8: the Pan plans the week. The model only proposes (`propose_plan`, `propose_navigation`); code resolves
// and checks every dish (Ruling 14, §2.2); the plan is a card the player taps or a strict typed yes; a navigation
// is a chip, never a jump (Ruling 15). The scripted path (code alone, the AI off) builds the same card.
import type { Plan, PlanCard, ReplyPart, TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { AiProvider, AiResult } from '../src/ai/provider.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { and, eq, isNull } from 'drizzle-orm';
import { consents } from '../src/db/schema.js';
import { lockUserPlan } from '../src/db/advisory-locks.js';
import { PROPOSAL_TTL_MS } from '../src/mentor/constants.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { N6_TEXTS, N7_TEXTS } from './helpers/gate-texts.js';
import { fakeAi, reply, toolCall } from './helpers/fake-ai.js';

const config = testConfig();
const catalog = defaultCatalog();
/** Tuesday 2026-11-10: with no market day the plan week is Monday 2026-11-09 … Sunday 2026-11-15. */
const NOW = new Date('2026-11-10T18:00:00Z');
const TODAY = '2026-11-10';
const WEEK = '2026-11-09';
const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`delete from canon_recipes`;
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
beforeEach(() => {
  mailer = new CaptureMailer();
});
afterEach(async () => {
  await app?.close();
});

async function makeApp(ai: AiProvider | null) {
  app = await buildApp({ config, db, mailer, ai, now: () => NOW, logger: false });
  return app;
}
const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });

type Purpose = 'health_data' | 'ai_health';
async function player(purposes: Purpose[] = ['health_data']) {
  const cookie = await signIn(app, mailer, `plan${++seq}@example.com`);
  for (const purpose of purposes) {
    const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });
    expect(res.statusCode).toBe(201);
  }
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  let conversationId: string | null = null;
  const turn = async (text: string, extra: { answering?: string } = {}): Promise<TurnResponse> => {
    const res = await call(cookie, {
      method: 'POST',
      url: '/mentor/turn',
      payload: { conversationId, input: { kind: 'text', text }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: null, ...extra },
    });
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<TurnResponse>();
    conversationId = r.conversationId;
    expect(r.parts.filter((p) => p.kind === 'text')).toEqual([]);
    return r;
  };
  return { cookie, userId, turn };
}

const triggers = (r: { parts: ReplyPart[] }) => r.parts.flatMap((p) => (p.kind === 'line' ? [p.line.trigger] : []));
const planOf = (r: TurnResponse): PlanCard => {
  const c = r.cards.find((x) => x.card.kind === 'plan');
  if (c === undefined || c.card.kind !== 'plan') throw new Error(`no plan card: ${JSON.stringify(r)}`);
  return c.card;
};
const proposalIdOf = (r: TurnResponse): string => r.cards.find((x) => x.card.kind === 'plan')!.proposalId;
const currentPlan = async (cookie: string): Promise<Plan | null> =>
  (await call(cookie, { method: 'GET', url: `/plans/current?today=${TODAY}` })).json<{ plan: Plan | null }>().plan;
const putPlan = (cookie: string, plan: Plan) =>
  call(cookie, { method: 'PUT', url: `/plans/${plan.weekStart}`, payload: { plan, confirmed: true, today: TODAY } });
const tap = (cookie: string, id: string) => call(cookie, { method: 'POST', url: `/mentor/proposals/${id}/confirm`, payload: { channel: 'tap', today: TODAY } });
const undo = (cookie: string, id: string) => call(cookie, { method: 'POST', url: `/mentor/writes/${id}/undo`, payload: {} });
const status = async (id: string) => (await sql<{ status: string }[]>`select status from mentor_proposals where id = ${id}`)[0].status;
const planArgs = (args: object) => toolCall('propose_plan', { days: null, pick: null, hard_week: null, after: null, ...args });
/** One model result with several tool calls. */
const calls = (list: { name: string; args: object }[]): AiResult => ({
  ok: true,
  text: '',
  toolCalls: list.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) })),
  finish: 'tool_calls',
  usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 },
});

describe('the scripted path (code alone)', () => {
  test('scripted (AI off): "plan my week: parippu on Sunday" → one plan card; tap → plan saved; undo → previous plan', async () => {
    await makeApp(null);
    const p = await player();
    const before: Plan = { weekStart: WEEK, items: [{ day: 2, kind: 'dish', slug: FRIJOLES, servings: 6 }], hard: false, slot: 'unanswered' };
    expect((await putPlan(p.cookie, before)).statusCode).toBe(200);

    const r = await p.turn('plan my week: parippu on Sunday');
    expect(r.route).toBe('deterministic');
    expect(r.cards).toHaveLength(1);
    const card = planOf(r);
    expect(card).toMatchObject({ weekStart: WEEK, hard: false, unknown: [], dropped: [] });
    // The week as it stands plus Sunday's parippu (day 6), each with code's own check.
    expect(card.items).toEqual([
      { day: 2, kind: 'dish', slug: FRIJOLES, servings: 6 },
      { day: 6, kind: 'dish', slug: PARIPPU, servings: 3 },
    ]);
    expect(card.checks).toEqual([
      { slug: FRIJOLES, status: 'ok' },
      { slug: PARIPPU, status: 'ok' },
    ]);
    expect(triggers(r)[0]).toBe('plan.readback');
    expect(await currentPlan(p.cookie)).toMatchObject({ items: before.items });

    const id = proposalIdOf(r);
    const confirmed = await tap(p.cookie, id);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json<{ parts: ReplyPart[]; trail: { kind: string; summary: string } }>()).toMatchObject({
      parts: [{ kind: 'line', line: { trigger: 'plan.saved', vars: {} } }],
      trail: { kind: 'plan', summary: card.summary },
    });
    expect((await currentPlan(p.cookie))?.items).toEqual(card.items);

    const undone = await undo(p.cookie, id);
    expect(undone.statusCode).toBe(200);
    expect(undone.json<{ undone: boolean }>().undone).toBe(true);
    expect(await currentPlan(p.cookie)).toMatchObject({ items: before.items, hard: false, slot: 'unanswered' });

    // With no plan before, the undo deletes the week's plan.
    const q = await player();
    const r2 = await q.turn('plan my week: onigiri on Monday');
    expect((await tap(q.cookie, proposalIdOf(r2))).statusCode).toBe(200);
    expect(await currentPlan(q.cookie)).not.toBeNull();
    expect((await undo(q.cookie, proposalIdOf(r2))).statusCode).toBe(200);
    expect(await currentPlan(q.cookie)).toBeNull();
  });

  test('a plan-card turn writes nothing: not even the empty profile row a first plan save creates (eval noWrite)', async () => {
    await makeApp(null);
    const p = await player();
    const rows = async () => (await sql<{ n: number }[]>`select count(*)::int as n from profiles where user_id = ${p.userId}`)[0].n;
    expect(await rows()).toBe(0);
    const r = await p.turn('plan my week: onigiri on Monday');
    expect(planOf(r).items).toEqual([{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }]);
    expect(await rows()).toBe(0);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from meal_plans where user_id = ${p.userId}`)[0].n).toBe(0);
  });

  test('scripted (AI off): "plan my week: dal on Sunday" → no code card ("dal" is no exact title, C1; fix round 2: the client\'s scripted engine takes it)', async () => {
    await makeApp(null);
    const p = await player();
    const r = await p.turn('plan my week: dal on Sunday');
    expect(r).toMatchObject({ route: 'scripted', cards: [], notice: 'ai_off' });
    // "pick 3" is code's choice, never a padded list; a dish with no single day gets its own ask.
    const pick = await p.turn('pick 3');
    expect(planOf(pick).items.map((i) => i.day)).toEqual([1, 2, 3]);
    const weekend = await p.turn('plan my week: onigiri at the weekend');
    expect(weekend).toMatchObject({ route: 'scripted', cards: [] });
  });

  test('scripted: without health_data a plan is the consent card, never a card (plans are health data)', async () => {
    await makeApp(null);
    const p = await player([]);
    const r = await p.turn('plan my week: onigiri on Monday');
    expect(r.cards).toEqual([]);
    expect(r.parts).toEqual([
      { kind: 'line', line: { trigger: 'consent.health_first', vars: {} } },
      { kind: 'consent', purpose: 'health_data' },
    ]);
  });
});

describe('the model only proposes', () => {
  test('AI: propose_plan with a dish not in the player\'s words → that day dropped', async () => {
    const ai = fakeAi([
      planArgs({ days: [{ weekday: 'Monday', dish: 'onigiri' }, { weekday: 'Tuesday', dish: 'frijoles de olla' }] }),
    ]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('could you put onigiri in for monday dinner?');
    expect(ai.requests).toHaveLength(1);
    expect(ai.requests[0].tools.map((t) => t.name)).toContain('propose_plan');
    const card = planOf(r);
    expect(card.items.map((i) => i.slug)).toEqual([ONIGIRI]);
    expect(JSON.stringify(r)).not.toContain(FRIJOLES);
  });

  test('a plan clause code reads ("put the frijoles on Saturday\'s plan") is proposed when the model made no plan call (T13)', async () => {
    const ai = fakeAi([toolCall('propose_meal_log', { slot: 'dinner', when: 'today', dish: 'dal', servings: null, description: 'dal' })]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn("Had dal for dinner. Also put the frijoles on Saturday's plan, and remind me about dinner at 6:30 pm.");
    // Fix round 2: "put the frijoles on Saturday's plan" names no exact dish, so code proposes no plan clause: only the
    // model can. Fix round 4 (N6): "Had dal for dinner" and that clause are not closed, so code builds no reminder card
    // either; the model's own profile call is the only way to one (the next tests).
    expect(r.cards.map((c) => c.card.kind)).toEqual(['meal']);
    expect(JSON.stringify(r)).not.toMatch(/plan\.dish_unknown/);
  });

  test('AI: propose_plan hard_week true without the player saying so → hard false', async () => {
    const ai = fakeAi([
      planArgs({ days: [{ weekday: 'Monday', dish: 'onigiri' }], hard_week: true }),
      planArgs({ days: [{ weekday: 'Monday', dish: 'onigiri' }], hard_week: true, pick: 40 }),
    ]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('onigiri for monday would be lovely');
    expect(planOf(r).hard).toBe(false);
    expect(triggers(r)).not.toContain('plan.hard_week');
    // The player's own words say it, so it is kept; a pick of 40 is clamped to the week's 7 days.
    const q = await player(['health_data', 'ai_health']);
    const r2 = await q.turn("rough week ahead, onigiri for monday and pick whatever else");
    const card = planOf(r2);
    expect(card.hard).toBe(true);
    expect(card.offer).toBeNull();
    expect(card.items.length).toBeLessThanOrEqual(7);
    expect(triggers(r2)).toContain('plan.hard_week');
  });

  test('a typed yes confirms a plan card; a rule added between card and yes → plan_invalid, card closed, nothing saved', async () => {
    await makeApp(null);
    const p = await player();
    const r = await p.turn('plan my week: parippu on Sunday');
    const yes = await p.turn('yes', { answering: proposalIdOf(r) });
    expect(yes.actions).toMatchObject([{ kind: 'confirmed', proposalId: proposalIdOf(r) }]);
    expect(triggers(yes)).toEqual(['plan.saved']);
    expect((await currentPlan(p.cookie))?.items.map((i) => i.slug)).toEqual([PARIPPU]);

    const q = await player();
    const r2 = await q.turn('plan my week: parippu on Sunday');
    const id = proposalIdOf(r2);
    // Parippu has grated coconut: a coconut rule filed in between blocks it.
    const ruled = await call(q.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' }, confirmed: true } });
    expect(ruled.statusCode).toBe(201);
    const no = await q.turn('yes', { answering: id });
    expect(no.actions).toEqual([]);
    expect(no.parts).toMatchObject([{ kind: 'line', line: { trigger: 'plan.blocked_dish', vars: { dish: 'Parippu Curry' } } }]);
    expect(await status(id)).toBe('rejected');
    expect(await currentPlan(q.cookie)).toBeNull();
    // Closed: a tap now changes nothing.
    expect((await tap(q.cookie, id)).statusCode).toBe(409);

    // The tap path: 400 plan_invalid with the lines, and the card closed.
    const s = await player();
    const r3 = await s.turn('plan my week: parippu on Sunday');
    await call(s.cookie, { method: 'POST', url: '/rules', payload: { rule: { target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'allergy' }, confirmed: true } });
    const tapped = await tap(s.cookie, proposalIdOf(r3));
    expect(tapped.statusCode).toBe(400);
    expect(tapped.json<{ error: { code: string; details: { parts: ReplyPart[] } } }>().error).toMatchObject({
      code: 'plan_invalid',
      details: { parts: [{ kind: 'line', line: { trigger: 'plan.blocked_dish' } }] },
    });
    expect(await status(proposalIdOf(r3))).toBe('rejected');
    expect(await currentPlan(s.cookie)).toBeNull();
  });
});

describe('navigation is a chip (Ruling 15)', () => {
  test('propose_navigation to an unknown cook → dropped; a known one → one go part; never with child.grownup', async () => {
    const ai = fakeAi([
      toolCall('propose_navigation', { to: 'visit', id: 'grandma-ruth' }),
      // Two chips proposed: one is kept.
      calls([
        { name: 'propose_navigation', args: { to: 'visit', id: 'haruka' } },
        { name: 'propose_navigation', args: { to: 'market', id: null } },
      ]),
    ]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const unknown = await p.turn('I want to see where Grandma Ruth cooks');
    expect(unknown.parts.filter((x) => x.kind === 'go')).toEqual([]);
    const known = await p.turn('I want to see where Haruka cooks');
    expect(known.parts.filter((x) => x.kind === 'go')).toEqual([
      { kind: 'go', target: { to: 'visit', cook: 'haruka' }, line: { trigger: 'nav.offer', vars: { place: "Haruka's kitchen" } } },
    ]);
    expect(known.actions).toEqual([]);

    // Code alone reads "take me to the market"; a child's turn is the grown-up line only, with no chip.
    const q = await player();
    expect((await q.turn('take me to the market')).parts).toEqual([
      { kind: 'go', target: { to: 'market' }, line: { trigger: 'nav.offer', vars: { place: 'the market list' } } },
    ]);
    const child = await q.turn("i'm 8, take me to the map");
    expect(child.parts).toEqual([{ kind: 'line', line: { trigger: 'child.grownup', vars: {} } }]);
    expect(ai.requests).toHaveLength(2);
  });
});

describe('C-13', () => {
  test('ruling (c): the prompt carries no taught slugs or dish names in its context (code resolves dish names)', async () => {
    const ai = fakeAi([reply('Ok.')]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    await p.turn('what should I cook tonight?');
    const ctxMessage = ai.requests[0].messages.find((m) => m.role === 'system' && (m.content ?? '').startsWith('PLAYER CONTEXT'))!;
    expect(ctxMessage.content).not.toMatch(/taught/);
    for (const slug of [PARIPPU, ONIGIRI, FRIJOLES]) expect(JSON.stringify(ai.requests[0].messages)).not.toContain(slug);
    expect(ctxMessage.content).not.toMatch(/parippu|frijoles/i);
  });

  test('T13 shape: the meal card and a profile card with the 18:30 dinner window when the model omits the windows (ruling b)', async () => {
    const ai = fakeAi([
      calls([
        { name: 'propose_meal_log', args: { slot: 'dinner', when: 'today', dish: null, servings: null, description: 'dal' } },
        { name: 'propose_profile', args: { market_days: null, meals_per_week: null } },
      ]),
    ]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn("Had dal for dinner. Also put the frijoles on Saturday's plan, and remind me about dinner at 6:30 pm.");
    expect(r.cards.map((c) => c.card.kind).sort()).toEqual(['meal', 'profile']);
    expect(JSON.stringify(r)).toMatch(/"name":"dinner","start":"18:30"/);
  });

  test('ruling: T13 with a malformed propose_profile → the malformed call is never used; fix round 4 (N6): code builds no card from a message with unclosed clauses', async () => {
    const malformed = { id: 'm1', name: 'propose_profile', arguments: JSON.stringify({ market_days: null, meals_per_week: 'null\n</parameter>\n<' }) };
    const shaped: AiResult = {
      ...calls([
        { name: 'propose_meal_log', args: { slot: 'dinner', when: 'today', dish: 'dal', servings: null, description: null } },
        { name: 'propose_plan', args: { days: [{ weekday: 'Saturday', dish: 'the frijoles' }], pick: null, hard_week: null, after: null } },
      ]),
    };
    if (shaped.ok) shaped.toolCalls.push(malformed);
    const malformedOnly: AiResult = { ok: true, text: '', toolCalls: [malformed], finish: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1, costMicroUsd: 1 } };
    const ai = fakeAi([shaped, malformedOnly, { ...shaped }, toolCall('propose_meal_log', { slot: 'lunch', when: 'today', dish: null, servings: null, description: 'soup' })]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn("Had dal for dinner. Also put the frijoles on Saturday's plan, and remind me about dinner at 6:30 pm.");
    expect(r.cards.map((c) => c.card.kind).sort()).toEqual(['meal']);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.dish_unknown', vars: { dish: 'frijoles' } } });
    // A message whose every clause is closed: code builds the profile card from the clock clause (meal windows only).
    const c = await player(['health_data', 'ai_health']);
    const closed = await c.turn('remind me about dinner at 6:30 pm, thanks');
    const prof = closed.cards.find((x) => x.card.kind === 'profile')!.card;
    expect(prof.kind === 'profile' && prof.patch).toEqual({ mealWindows: [{ name: 'dinner', start: '18:30', end: '19:30' }] });
    // No clock clause: the malformed call still makes nothing.
    const q = await player(['health_data', 'ai_health']);
    const r2 = await q.turn("Had dal for dinner. Also put the frijoles on Saturday's plan.");
    expect(r2.cards.map((c) => c.card.kind)).toEqual(['meal']);
    // A time the player says they ate at is no reminder.
    const u = await player(['health_data', 'ai_health']);
    const r3 = await u.turn('had soup for lunch at 1pm');
    expect(r3.cards.map((c) => c.card.kind)).toEqual(['meal']);
  });

  test('ruling: T08 "after that" with one weekday named → after that day; two weekdays → plan.after_which_day, nothing picked', async () => {
    const ai = fakeAi([
      calls([
        { name: 'propose_plan', args: { days: [{ weekday: 'Saturday', dish: 'the beans' }], pick: 3, hard_week: null, after: null } },
        { name: 'propose_profile', args: { market_days: ['Saturday'], meals_per_week: null, region: null, country: null, meal_windows: null } },
      ]),
      planArgs({ pick: 2 }),
    ]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn("idk just pick 3 things for this week. market's saturday so do the beans after that");
    const card = planOf(r);
    // Saturday is day 5 of the Monday week: every pick is after it.
    expect(card.items.length).toBeGreaterThan(0);
    expect(card.items.every((i) => i.day > 5)).toBe(true);
    expect(r.cards.map((c) => c.card.kind).sort()).toEqual(['plan', 'profile']);
    const q = await player(['health_data', 'ai_health']);
    const r2 = await q.turn("pick 2 for me, i'm away friday and saturday so do them after that");
    expect(r2.cards).toEqual([]);
    expect(r2.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.after_which_day', vars: { day: 'that' } } });
  });

  test('C-13: PromptContext.week carries weekday names and hasPlan only; no date, margin note, cooked-for answer or pantry date appears anywhere in the prompt (C24)', async () => {
    const ai = fakeAi([reply('Ok.'), reply('Ok.')]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const note = await call(p.cookie, {
      method: 'POST',
      url: '/notes',
      payload: { note: { recipe: ONIGIRI, ops: [], text: 'less salt for Gran', at: TODAY }, confirmed: true, today: TODAY },
    });
    expect(note.statusCode, note.body).toBe(201);
    await p.turn('what should I cook tonight?');
    expect((await putPlan(p.cookie, { weekStart: WEEK, items: [{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }], hard: false, slot: 'unanswered' })).statusCode).toBe(200);
    await p.turn('anything good this week?');
    for (const [i, req] of ai.requests.entries()) {
      const ctxMessage = req.messages.find((m) => m.role === 'system' && (m.content ?? '').startsWith('PLAYER CONTEXT'))!;
      const ctx = JSON.parse(ctxMessage.content!.slice(ctxMessage.content!.indexOf('\n') + 1)) as { week: Record<string, unknown> };
      expect(Object.keys(ctx.week).sort()).toEqual(['hasPlan', 'weekdays']);
      expect(ctx.week.weekdays).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
      expect(ctx.week.hasPlan).toBe(i === 1);
      const all = JSON.stringify(req.messages);
      expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(all).not.toMatch(/less salt|Gran/);
    }
  });
});

describe('fix round 1', () => {
  const aiPlayer = () => player(['health_data', 'ai_health']);
  const noCalls = () => reply('');

  test('C1: the model\'s after "all safe now" never reaches a line; the ask echoes only the player\'s words', async () => {
    const ai = fakeAi([planArgs({ pick: 3, after: 'all safe now' }), planArgs({ pick: 2, after: 'the weekend' })]);
    await makeApp(ai);
    const p = await aiPlayer();
    const r = await p.turn('help me with my week please');
    expect(JSON.stringify(r)).not.toMatch(/all safe now/i);
    expect(triggers(r)).not.toContain('plan.after_which_day');
    // "after that" with two weekdays: the ask names the player's own word, never the model's.
    const q = await aiPlayer();
    const r2 = await q.turn("pick 2, i'm out friday and saturday so after that");
    expect(r2.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.after_which_day', vars: { day: 'that' } } });
  });

  test('I1: health precedence inside plan turns: "no peanuts on sunday", "nothing with nuts", "peanut free" go to the health path; plain dishes still plan', async () => {
    const ai = fakeAi([
      noCalls(),
      noCalls(),
      calls([{ name: 'propose_plan', args: { days: [{ weekday: 'sunday', dish: 'parippu' }, { weekday: 'monday', dish: 'peanut free' }], pick: null, hard_week: null, after: null } }]),
    ]);
    await makeApp(ai);
    const health = ['rule.ask_keep_off', 'rule.ask_what_else', 'rule.unknown_term', 'rule.which_one'];
    for (const text of ['plan my week: no peanuts on sunday', 'plan my week: nothing with nuts on monday']) {
      const p = await aiPlayer();
      const r = await p.turn(text);
      expect(r.cards.filter((c) => c.card.kind === 'plan'), text).toEqual([]);
      expect(triggers(r).some((t) => health.includes(t)) || r.cards.some((c) => c.card.kind === 'rule'), `${text}: ${JSON.stringify(r.parts)}`).toBe(true);
      expect(JSON.stringify(r), text).not.toMatch(/plan\.dish_unknown/);
    }
    const p = await aiPlayer();
    const r = await p.turn('plan my week: parippu on sunday, peanut free on monday');
    expect(planOf(r).items.map((i) => i.slug)).toEqual([PARIPPU]);
    expect(JSON.stringify(r)).not.toMatch(/peanut free/);
    // The plan card never stands in for the health ask.
    expect(triggers(r).some((t) => health.includes(t)) || r.cards.some((c) => c.card.kind === 'rule')).toBe(true);
    expect(ai.requests).toHaveLength(3);
  });

  test('I2: no code-built profile card for "dinner at 7:30 pm made me sick", "my kid has dinner at 5pm" or a meal cooked for someone; the health ask stays', async () => {
    const ai = fakeAi([noCalls(), noCalls(), noCalls()]);
    await makeApp(ai);
    const results: TurnResponse[] = [];
    for (const text of ['dinner at 7:30 pm made me sick', 'my kid has dinner at 5pm', "I'm cooking lunch at 1pm for my mum"]) {
      const r = await (await aiPlayer()).turn(text);
      expect(r.cards, text).toEqual([]);
      results.push(r);
    }
    expect(triggers(results[0])).toContain('rule.ask_keep_off');
  });

  test('I2: a code-built profile card never suppresses the health ask (fix round 2: a symptom anywhere means no code card at all)', async () => {
    const ai = fakeAi([noCalls(), noCalls()]);
    await makeApp(ai);
    const r = await (await aiPlayer()).turn('remind me about dinner at 6:30 pm, my tummy has been funny all week');
    expect(r.cards).toEqual([]);
    expect(triggers(r)).toContain('rule.ask_keep_off');
    // A closed reminder clause on a health turn by M4's broad meal-time gate: the card, and it suppresses nothing.
    const s = await (await aiPlayer()).turn('remind me about dinner at 6:30 pm');
    expect(s.cards.map((c) => c.card.kind)).toEqual(['profile']);
  });

  test('M1: a plan confirm takes plan: and the health_data grant before its proposal row', async () => {
    await makeApp(null);
    for (const hold of ['plan', 'consent'] as const) {
      const p = await player();
      const r = await p.turn('plan my week: onigiri on Monday');
      const id = proposalIdOf(r);
      let release!: () => void;
      const gate = new Promise<void>((res) => (release = res));
      let held!: () => void;
      const isHeld = new Promise<void>((res) => (held = res));
      const holder = db.transaction(async (tx) => {
        if (hold === 'plan') await lockUserPlan(tx, p.userId);
        else await tx.select({ id: consents.id }).from(consents).where(and(eq(consents.userId, p.userId), eq(consents.purpose, 'health_data'), isNull(consents.withdrawnAt))).for('update');
        held();
        await gate;
      });
      await isHeld;
      const confirming = tap(p.cookie, id);
      // Fix round 1 (Task 9 review): no wall-clock sleep. Wait until the confirm's backend is actually blocked on a
      // lock (this file's own database), so the check below is never vacuous under load.
      for (let i = 0; ; i++) {
        const [w] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
        if (w.n > 0) break;
        if (i > 2000) throw new Error(`${hold}: the confirm never waited on the held lock`);
        await new Promise((res) => setTimeout(res, 5));
      }
      // The confirm waits on the held lock, so it has not reached (locked) its proposal row yet.
      const free = await sql`select id from mentor_proposals where id = ${id} for update skip locked`;
      expect(free, hold).toHaveLength(1);
      release();
      await holder;
      expect((await confirming).statusCode, hold).toBe(200);
    }
  });

  test('M2: a card built on an older week is not saved: it is closed and re-offered on the week as it is now', async () => {
    await makeApp(null);
    const p = await player();
    const r = await p.turn('plan my week: onigiri on Monday');
    const id = proposalIdOf(r);
    // The player edits the week on Form 7-W in between.
    const edited: Plan = { weekStart: WEEK, items: [{ day: 3, kind: 'dish', slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered' };
    expect((await putPlan(p.cookie, edited)).statusCode).toBe(200);
    const stale = await tap(p.cookie, id);
    expect(stale.statusCode).toBe(409);
    const err = stale.json<{ error: { code: string; details: { card: { proposalId: string; card: PlanCard }; parts: ReplyPart[] } } }>().error;
    expect(err.code).toBe('plan_changed');
    expect(err.details.card.card.items).toEqual([{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }, { day: 3, kind: 'dish', slug: PARIPPU, servings: 3 }]);
    expect(err.details.parts[0]).toMatchObject({ kind: 'line', line: { trigger: 'plan.readback' } });
    expect(await status(id)).toBe('rejected');
    // Nothing was saved over the edit; the re-offered card saves the week with both.
    expect((await currentPlan(p.cookie))?.items).toEqual(edited.items);
    expect((await tap(p.cookie, err.details.card.proposalId)).statusCode).toBe(200);
    expect((await currentPlan(p.cookie))?.items).toEqual(err.details.card.card.items);

    // The typed yes: the re-offered card comes back as a card in the reply.
    const q = await player();
    const r2 = await q.turn('plan my week: onigiri on Monday');
    expect((await putPlan(q.cookie, edited)).statusCode).toBe(200);
    const yes = await q.turn('yes', { answering: proposalIdOf(r2) });
    expect(yes.actions).toEqual([]);
    expect(yes.cards.map((c) => c.card.kind)).toEqual(['plan']);
    expect(triggers(yes)[0]).toBe('plan.readback');
  });

  test('M4: a yes to a plan card confirms it while open, and writes nothing once it has expired', async () => {
    let at = NOW.getTime();
    app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(at), logger: false });
    const p = await player();
    const live = await p.turn('plan my week: onigiri on Monday');
    expect((await p.turn('yes', { answering: proposalIdOf(live) })).actions).toMatchObject([{ kind: 'confirmed' }]);
    const q = await player();
    const old = await q.turn('plan my week: onigiri on Monday');
    at += PROPOSAL_TTL_MS + 60_000;
    const late = await q.turn('yes', { answering: proposalIdOf(old) });
    expect(late.actions).toEqual([]);
    expect(triggers(late)).not.toContain('plan.saved');
    expect(await currentPlan(q.cookie)).toBeNull();
  });

  test('market-day ruling: T03 with the model omitting the call still gets the market-day card; T08 (fix round 4, N6: unclosed clauses), another person or a symptom gets none', async () => {
    const ai = fakeAi([
      noCalls(),
      calls([{ name: 'propose_plan', args: { days: [{ weekday: 'Saturday', dish: 'the beans' }], pick: 3, hard_week: null, after: null } }]),
      noCalls(),
      noCalls(),
    ]);
    await makeApp(ai);
    const t03 = await (await aiPlayer()).turn('My market day is Saturday.');
    expect(t03.cards.map((c) => c.card.kind)).toEqual(['profile']);
    expect(JSON.stringify(t03)).toMatch(/"marketDays":\[6\]/);
    const t08 = await (await aiPlayer()).turn("idk just pick 3 things for this week. market's saturday so do the beans after that");
    expect(t08.cards.map((c) => c.card.kind).sort()).toEqual(['plan']);
    expect(JSON.stringify(t08)).not.toMatch(/"marketDays"/);
    for (const text of ["my mum's market is saturday", 'the market saturday made me sick']) {
      const r = await (await aiPlayer()).turn(text);
      expect(r.cards, text).toEqual([]);
    }
  });
});

describe('fix round 2: closed grammar only; health first', () => {
  const aiPlayer = () => player(['health_data', 'ai_health']);
  const HEALTH_LINES = ['rule.ask_keep_off', 'rule.ask_what_else', 'rule.unknown_term', 'rule.which_one', 'rule.which_kind'];

  test('N1 probes: no code-built plan card; the turn takes the health path (an ask or a rule card)', async () => {
    const texts = [
      'plan my week: parippu minus the peanuts on monday',
      'put the parippu minus the peanuts on monday',
      'hold the peanuts on monday',
      'go easy on the chilli on monday',
      'low sugar on monday',
      'low salt on monday',
      'less spicy on monday',
      'keto on monday',
    ];
    const ai = fakeAi(texts.map(() => reply('')));
    await makeApp(ai);
    for (const text of texts) {
      const r = await (await aiPlayer()).turn(text);
      expect(r.route, text).toBe('ai');
      expect(r.cards.filter((c) => c.card.kind === 'plan'), text).toEqual([]);
      expect(triggers(r).some((t) => HEALTH_LINES.includes(t)) || r.cards.some((c) => c.card.kind === 'rule'), `${text}: ${JSON.stringify(r.parts)}`).toBe(true);
      expect(JSON.stringify(r), text).not.toMatch(/plan\.dish_unknown/);
    }
  });

  test('N2 probes: no code-built profile or market card for another person, a past meal, two weekdays or a symptom', async () => {
    const texts = [
      'remind my brother about dinner at 6pm',
      'my neighbour usually eats dinner at 6pm',
      "my roommate's market is on friday",
      "my grandad's market day is saturday",
      "Ana's market is on saturday",
      'made lunch about 1pm yesterday',
      'my market day is saturday, sometimes sunday',
      "market's saturday, peanuts make me dizzy",
      "market's saturday, shrimp gives me a headache",
      "market's saturday, my throat gets scratchy after prawns",
      'remind me about dinner at 6pm, it makes me sick',
    ];
    const ai = fakeAi(texts.map(() => reply('')));
    await makeApp(ai);
    for (const text of texts) {
      const r = await (await aiPlayer()).turn(text);
      expect(r.cards, text).toEqual([]);
    }
  });

  test('the scripted path, AI off: an exact title plans; "dal" (no title) is no code card, so the client\'s scripted engine takes it', async () => {
    await makeApp(null);
    const p = await player();
    expect(planOf(await p.turn('plan my week: parippu on Sunday')).items.map((i) => i.slug)).toEqual([PARIPPU]);
    const dal = await p.turn('plan my week: dal on Sunday');
    expect(dal).toMatchObject({ route: 'scripted', cards: [], notice: 'ai_off' });
  });
});


// Fix round 4 (review-task8-fix2.md): every N6, N7, N9 and N11 probe through /mentor/turn, and one behaviour test
// for each code-card exclusion gate (N10). The model makes no call in every probe, so any card is code's.
/** M6 final M6: every N7 text over HTTP, twice 45 turns; a hang should fail, a busy machine should not. */
const N7_TIMEOUT = 180_000;

describe('fix round 4: the whole message, health first, a spelled age', () => {
  const HEALTH_LINES = ['rule.ask_keep_off', 'rule.ask_what_else', 'rule.unknown_term', 'rule.which_one', 'rule.which_kind'];
  const silent = (n: number) => fakeAi(Array.from({ length: n }, () => reply('')));
  const codeCards = (r: TurnResponse) => r.cards.filter((c) => c.card.kind === 'plan' || c.card.kind === 'profile');
  /**
   * Each text in a conversation of its own, spread over a few players: sign-ins (20 per app), turns per minute (the
   * clock is frozen) and the daily AI allowance are capped, and a capped turn would make no card for the wrong reason.
   */
  async function eachFresh(purposes: Purpose[], texts: string[], check: (r: TurnResponse, text: string) => void) {
    for (let i = 0; i < texts.length; i += 10) {
      const p = await player(purposes);
      for (const text of texts.slice(i, i + 10)) {
        const res = await call(p.cookie, {
          method: 'POST',
          url: '/mentor/turn',
          payload: { conversationId: null, input: { kind: 'text', text }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: null },
        });
        expect(res.statusCode, res.body).toBe(200);
        const r = res.json<TurnResponse>();
        expect(r.notice, text).not.toBe('rate_limited');
        expect(r.parts.filter((x) => x.kind === 'text')).toEqual([]);
        check(r, text);
      }
    }
  }

  // Fix round 1 (Task 9 review, flakes): every N6 and N7 text runs through the gate directly in mentor-gate.test.ts
  // (no HTTP); the N6 test keeps two /mentor/turn probes as integration smoke. M6 final review M6: the two N7 tests run
  // every N7 text over HTTP again (the emoji, Spanish and "type 2" texts with ai_health among them), in one app each,
  // because the direct test calls its own copy of the gate; a long, explicit budget, not the default.
  test('N6 probes: a clause outside the closed grammar anywhere in the message → no code card, for either player', async () => {
    const texts = ['remind me to eat dinner at 6pm, no wait, 7pm', 'put parippu on monday, for my brother'];
    expect(N6_TEXTS).toEqual(expect.arrayContaining(texts));
    await makeApp(silent(texts.length * 2));
    for (const purposes of [['health_data', 'ai_health'], ['health_data']] as Purpose[][]) {
      await eachFresh(purposes, texts, (r, text) => expect(codeCards(r), `${purposes.join('+')}: ${text}`).toEqual([]));
    }
  });

  test('N6: closed clauses with a neutral clause still make their cards', async () => {
    await makeApp(silent(3));
    const r = await (await player(['health_data', 'ai_health'])).turn('remind me about dinner at 6pm, thanks');
    expect(r.cards.map((c) => c.card.kind)).toEqual(['profile']);
    const m = await (await player(['health_data', 'ai_health'])).turn("ok, my market day is saturday");
    expect(JSON.stringify(m.cards)).toMatch(/"marketDays":\[6\]/);
    const p = await (await player(['health_data', 'ai_health'])).turn("put parippu on monday and my market's saturday, thanks");
    expect(r.cards.length + p.cards.length).toBeGreaterThan(1);
    expect(p.cards.map((c) => c.card.kind)).toEqual(['plan']); // two weekdays: no market card
  });

  test('N7: health_data only → the text never reaches the model (needs_ai_health), no code card', { timeout: N7_TIMEOUT }, async () => {
    const texts = N7_TEXTS;
    expect(texts.length).toBeGreaterThanOrEqual(44);
    const ai = silent(texts.length);
    await makeApp(ai);
    await eachFresh(['health_data'], texts, (r, text) => expect(r, text).toMatchObject({ route: 'scripted', notice: 'needs_ai_health', cards: [] }));
    expect(ai.requests).toHaveLength(0);
  });

  test('N7: with ai_health the same texts get no code card and take the health path (an ask or a rule card)', { timeout: N7_TIMEOUT }, async () => {
    const texts = N7_TEXTS;
    expect(texts).toEqual(expect.arrayContaining(['put parippu on monday. 🥜', 'put parippu on monday, sin cacahuetes', 'remind me to eat dinner at 6pm, type 2']));
    await makeApp(silent(texts.length));
    await eachFresh(['health_data', 'ai_health'], texts, (r, text) => {
      expect(r.route, text).toBe('ai');
      expect(codeCards(r), text).toEqual([]);
      expect(triggers(r).some((t) => HEALTH_LINES.includes(t)) || r.cards.some((c) => c.card.kind === 'rule'), `${text}: ${JSON.stringify(r.parts)}`).toBe(true);
    });
  });

  test('N9: a child who spells out their age gets the grown-up line and no card, for either player', async () => {
    const texts = ["im seven, market's saturday", "i'm twelve, put parippu on monday", 'i am seven years old. remind me about dinner at 6pm', "year 4. market's saturday"];
    const ai = silent(texts.length * 2);
    await makeApp(ai);
    for (const purposes of [['health_data', 'ai_health'], ['health_data']] as Purpose[][]) {
      await eachFresh(purposes, texts, (r, text) => {
        expect(r, text).toMatchObject({ route: 'deterministic', cards: [] });
        expect(triggers(r), text).toEqual(['child.grownup']);
      });
    }
    expect(ai.requests).toHaveLength(0);
  });

  test('N11 probes: a health turn beyond the meal-time words → no code card (the ask stays with ai_health)', async () => {
    const texts = ["market's saturday, i'm on a diet", "market's saturday, i'm dieting", "market's saturday, mushrooms are rough after", "put parippu on monday, i'm on a diet"];
    await makeApp(silent(texts.length));
    await eachFresh(['health_data', 'ai_health'], texts, (r, text) => {
      expect(codeCards(r), text).toEqual([]);
      expect(triggers(r).some((t) => HEALTH_LINES.includes(t)), `${text}: ${JSON.stringify(r.parts)}`).toBe(true);
    });
  });

  // N10: each exclusion gate, by behaviour. The canon title "Parippu Curry (Kerala dal with coconut)" names graph
  // ingredients inside a closed clause, so these messages pass the closed grammar and only the health gate stops them.
  const COCONUT = 'put the parippu curry (kerala dal with coconut) on monday';

  test('N10 gate: no code plan card on a message with health words (planWordsIn behind !healthWords)', async () => {
    await makeApp(silent(1));
    const r = await (await player(['health_data', 'ai_health'])).turn(COCONUT);
    expect(r.route).toBe('ai');
    expect(codeCards(r)).toEqual([]);
  });

  test('N10 gate: no code reminder card on a message with health words (reminderSlots behind !healthWords)', async () => {
    await makeApp(silent(1));
    const r = await (await player(['health_data', 'ai_health'])).turn(`${COCONUT} and remind me about dinner at 6pm`);
    expect(codeCards(r)).toEqual([]);
  });

  test('N10 gate: no code market card on a message with health words (marketDayStated behind !healthWords)', async () => {
    await makeApp(silent(1));
    const r = await (await player(['health_data', 'ai_health'])).turn("put the parippu curry (kerala dal with coconut) on saturday and my market's saturday");
    expect(codeCards(r)).toEqual([]);
  });

  test('N10 gate: the diet cue and health words keep a plan message off code cards ("low-fodmap", "it makes me sick")', async () => {
    await makeApp(silent(2));
    for (const text of ['put parippu on monday, low-fodmap', 'put parippu on monday, it makes me sick']) {
      const r = await (await player(['health_data', 'ai_health'])).turn(text);
      expect(codeCards(r), text).toEqual([]);
    }
  });

  test('N10 gate: the code route never runs on a health turn: the allergies intake step, or an open health card', async () => {
    const ai = fakeAi([reply(''), toolCall('propose_rule', { term: 'peanut', severity: 'anaphylactic' }), reply('')]);
    await makeApp(ai);
    // The allergies intake step.
    const p = await player(['health_data', 'ai_health']);
    const res = await call(p.cookie, {
      method: 'POST',
      url: '/mentor/turn',
      payload: { conversationId: null, input: { kind: 'text', text: 'plan my week: parippu on Sunday' }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: 'allergies' },
    });
    const r = res.json<TurnResponse>();
    expect(r.route).not.toBe('deterministic');
    expect(codeCards(r)).toEqual([]);
    // An open health card from the previous turn.
    const q = await player(['health_data', 'ai_health']);
    const first = await q.turn("I'm allergic to peanuts");
    expect(first.cards.map((c) => c.card.kind)).toEqual(['rule']);
    const second = await q.turn('plan my week: parippu on Sunday');
    expect(second.route).not.toBe('deterministic');
    expect(codeCards(second)).toEqual([]);
  });

  test('N10 gate: without the lead, a dish clause needs "put" ("parippu on monday" inside a longer message is no code card)', async () => {
    await makeApp(silent(2));
    const r = await (await player(['health_data', 'ai_health'])).turn("my market's saturday and parippu on monday");
    expect(r.cards.filter((c) => c.card.kind === 'plan')).toEqual([]);
    const s = await (await player(['health_data', 'ai_health'])).turn("pick 2 and parippu on monday");
    expect(s.cards.filter((c) => c.card.kind === 'plan')).toEqual([]);
  });
});

// Fix round 5 (rulings 5a, 5c): every clause consumed by an existing grammar or a closed filler; a correction cue
// means no plan or profile card, from code or from the model, and an ask instead.
describe('fix round 5', () => {
  const aiPlayer = () => player(['health_data', 'ai_health']);
  const kinds = (r: TurnResponse) => r.cards.map((c) => c.card.kind).sort();
  const profileCall = (args: object) => toolCall('propose_profile', args);
  const WHICH_TIME = { kind: 'line', line: { trigger: 'profile.which_time', vars: { meal: 'dinner' } } };

  test('5c: "dinner at 6pm, no wait, 7pm" with no model call → no card, the which-time ask', async () => {
    await makeApp(fakeAi([reply('')]));
    const r = await (await aiPlayer()).turn('remind me to eat dinner at 6pm, no wait, 7pm');
    expect(r.cards).toEqual([]);
    expect(r.parts).toContainEqual(WHICH_TIME);
  });

  test('5c: the same with the model\'s profile call (19:00 or 18:00) → no profile card, the which-time ask', async () => {
    await makeApp(fakeAi([profileCall({ meal_windows: [{ name: 'dinner', start: '19:00' }] }), profileCall({ meal_windows: [{ name: 'dinner', start: '18:00' }] })]));
    for (let i = 0; i < 2; i++) {
      const r = await (await aiPlayer()).turn('remind me to eat dinner at 6pm, no wait, 7pm');
      expect(r.cards.filter((c) => c.card.kind === 'profile')).toEqual([]);
      expect(r.parts).toContainEqual(WHICH_TIME);
    }
  });

  test('5c: a corrected plan → no plan card from the model either, plan.which_day', async () => {
    await makeApp(fakeAi([planArgs({ days: [{ weekday: 'Tuesday', dish: 'parippu' }] }), reply('')]));
    for (const p of [await aiPlayer(), await aiPlayer()]) {
      const r = await p.turn('put parippu on monday, actually tuesday');
      expect(r.cards.filter((c) => c.card.kind === 'plan')).toEqual([]);
      expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.which_day', vars: { dish: 'parippu' } } });
    }
  });

  test('5c: a corrected market day → no profile card from the model, the market-day ask', async () => {
    await makeApp(fakeAi([profileCall({ market_days: ['Sunday'] })]));
    const r = await (await aiPlayer()).turn('my market day is saturday, i mean sunday');
    expect(r.cards).toEqual([]);
    expect(triggers(r)).toContain('intake.market_day.ask');
  });

  test('5c: other cards in a corrected message stay (a meal the player ate)', async () => {
    await makeApp(fakeAi([calls([
      { name: 'propose_meal_log', args: { slot: 'lunch', when: 'today', dish: null, servings: null, description: 'soup' } },
      { name: 'propose_plan', args: { days: [{ weekday: 'Friday', dish: 'onigiri' }], pick: null, hard_week: null, after: null } },
    ])]));
    const r = await (await aiPlayer()).turn('had soup for lunch. put onigiri on thursday, no wait, friday');
    expect(kinds(r)).toEqual(['meal']);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.which_day', vars: { dish: 'onigiri' } } });
  });

  test('M5 final m5: only the corrected clause loses its card; the dinner time it never touched stands', async () => {
    await makeApp(fakeAi([calls([
      { name: 'propose_profile', args: { market_days: null, meals_per_week: null, region: null, country: null, meal_windows: [{ name: 'dinner', start: '19:00' }] } },
      { name: 'propose_plan', args: { days: [{ weekday: 'Tuesday', dish: 'parippu' }], pick: null, hard_week: null, after: null } },
    ])]));
    const r = await (await aiPlayer()).turn('remind me to eat dinner at 7pm, and parippu on monday, actually tuesday');
    expect(kinds(r)).toEqual(['profile']);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.which_day', vars: { dish: 'parippu' } } });
    expect(triggers(r)).not.toContain('profile.which_time');
  });

  test('M5 final m5, the other half: a corrected time loses the profile card; the dish day stands', async () => {
    await makeApp(fakeAi([calls([
      { name: 'propose_profile', args: { market_days: null, meals_per_week: null, region: null, country: null, meal_windows: [{ name: 'dinner', start: '19:00' }] } },
      { name: 'propose_plan', args: { days: [{ weekday: 'Monday', dish: 'parippu' }], pick: null, hard_week: null, after: null } },
    ])]));
    const r = await (await aiPlayer()).turn('put parippu on monday, and remind me to eat dinner at 6pm, no wait, 7pm');
    expect(kinds(r)).toEqual(['plan']);
    expect(r.parts).toContainEqual(WHICH_TIME);
    expect(triggers(r)).not.toContain('plan.which_day');
  });

  test('M5 final m6: "pick 2, actually 3" → no plan card from the model\'s count, the which-count ask', async () => {
    await makeApp(fakeAi([planArgs({ pick: 3 }), planArgs({ pick: 2 }), reply('')]));
    for (let i = 0; i < 3; i++) {
      const r = await (await aiPlayer()).turn('pick 2, actually 3');
      expect(r.cards.filter((c) => c.card.kind === 'plan')).toEqual([]);
      expect(triggers(r)).toContain('plan.which_count');
    }
  });

  test('5a: a meal-log or pantry clause next to a closed clause → the code card; a T08-shaped clause → none', async () => {
    await makeApp(fakeAi([reply(''), reply(''), reply('')]));
    const r = await (await aiPlayer()).turn('had toast for lunch. put onigiri on monday');
    expect(kinds(r)).toContain('plan');
    // M6 Step 5 fix round 1: bare "rice" is a graph name now (a health word, like "milk"); "flour" is still read only
    // inside a longer name, the case this pins.
    const s = await (await aiPlayer()).turn("ran out of flour, my market's saturday");
    expect(JSON.stringify(s.cards)).toMatch(/"marketDays":\[6\]/);
    const t = await (await aiPlayer()).turn("idk just pick 3 things for this week. market's saturday so do the beans after that");
    expect(t.cards).toEqual([]);
  });
});

describe('adjudication B', () => {
  test('"dinner at 6, actually 7" → no profile card from the model, the which-time ask; "I actually like parippu" drops nothing', async () => {
    await makeApp(
      fakeAi([
        toolCall('propose_profile', { meal_windows: [{ name: 'dinner', start: '19:00' }] }),
        planArgs({ days: [{ weekday: 'Monday', dish: 'parippu' }] }),
      ]),
    );
    const r = await (await player(['health_data', 'ai_health'])).turn('remind me to eat dinner at 6, actually 7');
    expect(r.cards).toEqual([]);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'profile.which_time', vars: { meal: 'dinner' } } });
    const s = await (await player(['health_data', 'ai_health'])).turn('I actually like parippu, put it on monday');
    expect(s.cards.map((c) => c.card.kind)).toEqual(['plan']);
    expect(triggers(s)).not.toContain('plan.which_day');
  });

  test('"no wait" is no health word: a health_data-only player\'s corrected plan reaches the model and gets the ask', async () => {
    await makeApp(fakeAi([reply('')]));
    const r = await (await player(['health_data'])).turn('put parippu on monday, no wait, tuesday');
    expect(r.notice ?? null).not.toBe('needs_ai_health');
    expect(r.cards).toEqual([]);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.which_day', vars: { dish: 'parippu' } } });
  });
});
