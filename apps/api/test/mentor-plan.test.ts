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
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
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

  test('scripted (AI off): "plan my week: dal on Sunday" → no card, plan.dish_unknown for "dal" (C1)', async () => {
    await makeApp(null);
    const p = await player();
    const r = await p.turn('plan my week: dal on Sunday');
    expect(r.cards).toEqual([]);
    expect(r.parts).toEqual([{ kind: 'line', line: { trigger: 'plan.dish_unknown', vars: { dish: 'dal' } } }]);
    // "pick 3" is code's choice, never a padded list; a dish with no single day gets its own ask.
    const pick = await p.turn('pick 3');
    expect(planOf(pick).items.map((i) => i.day)).toEqual([1, 2, 3]);
    const weekend = await p.turn('plan my week: onigiri at the weekend');
    expect(weekend.cards).toEqual([]);
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
    expect(r.cards.map((c) => c.card.kind)).toEqual(['meal']);
    expect(r.parts).toContainEqual({ kind: 'line', line: { trigger: 'plan.dish_unknown', vars: { dish: 'frijoles' } } });
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
  test('C-13: PromptContext.week carries weekday names, taught slugs and hasPlan only; no date, margin note, cooked-for answer or pantry date appears anywhere in the prompt (C24)', async () => {
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
      expect(Object.keys(ctx.week).sort()).toEqual(['hasPlan', 'taught', 'weekdays']);
      expect(ctx.week.weekdays).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);
      expect(ctx.week.taught).toEqual([PARIPPU, ONIGIRI, FRIJOLES].sort());
      expect(ctx.week.hasPlan).toBe(i === 1);
      const all = JSON.stringify(req.messages);
      expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(all).not.toMatch(/less salt|Gran/);
    }
  });
});
