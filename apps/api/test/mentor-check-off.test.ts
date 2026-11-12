// M6 Step 8: the Pan at the market (Rulings 13, 14; C30, C31, C32). A message the closed grammar claims whole ticks
// its rows at once, with an Undo; everything else goes to the health path as in M4/M5; a check-off the model proposes
// waits for a tap. Fake AiProvider only; real Postgres.
import type { CheckOffCard, MarketRunView, Plan, ReplyPart, TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { AiProvider, AiRequest, AiResult } from '../src/ai/provider.js';
import { buildApp } from '../src/app.js';
import { defaultCatalog, defaultLoopContent } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { lockLiveUser } from '../src/auth/live-user.js';
import { usageEvents } from '../src/db/schema.js';
import { recentMessages } from '../src/mentor/conversations.js';
import { confirmProposalIn } from '../src/mentor/writes.js';
import { createRecipeIndexSource } from '../src/recipes/recipe-index.js';
import { tickIn } from '../src/week/market-service.js';
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
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const HOUR = 3_600_000;

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
const grant = (cookie: string, purpose: Purpose) =>
  call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });

/** A player with the given consents, a plan (frijoles Tuesday, parippu Sunday) and its open market run (unless `run: false`). */
async function player(purposes: Purpose[] = ['health_data'], opts: { run?: boolean } = {}) {
  const cookie = await signIn(app, mailer, `checkoff${++seq}@example.com`);
  // The plan and the run need health_data; a player without it is given one first and then withdraws (keep).
  const needed = purposes.includes('health_data') ? purposes : (['health_data', ...purposes] as Purpose[]);
  for (const purpose of needed) expect((await grant(cookie, purpose)).statusCode).toBe(201);
  const userId = (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id;
  let run: MarketRunView | null = null;
  if (opts.run !== false) {
    const plan: Plan = {
      weekStart: WEEK,
      items: [
        { day: 1, kind: 'dish', slug: FRIJOLES, servings: 6 },
        { day: 6, kind: 'dish', slug: PARIPPU, servings: 3 },
      ],
      hard: false,
      slot: 'unanswered',
    };
    expect((await call(cookie, { method: 'PUT', url: `/plans/${WEEK}`, payload: { plan, confirmed: true, today: TODAY } })).statusCode).toBe(200);
    const opened = await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } });
    expect(opened.statusCode, opened.body).toBe(200);
    run = opened.json<MarketRunView>();
  }
  if (!purposes.includes('health_data')) {
    expect((await call(cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
  }
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
  return { cookie, userId, turn, run };
}

const triggers = (r: { parts: ReplyPart[] }) => r.parts.flatMap((p) => (p.kind === 'line' ? [p.line.trigger] : []));
const checkOffOf = (r: TurnResponse): { proposalId: string; card: CheckOffCard } => {
  const c = r.cards.find((x) => x.card.kind === 'check_off');
  if (c === undefined || c.card.kind !== 'check_off') throw new Error(`no check-off card: ${JSON.stringify(r)}`);
  return { proposalId: c.proposalId, card: c.card };
};
const keyOf = (run: MarketRunView | null, name: string): string => {
  const row = run?.items.find((i) => i.name === name);
  if (row === undefined) throw new Error(`no row ${name}: ${JSON.stringify(run?.items.map((i) => i.name))}`);
  return row.key;
};
const runNow = async (cookie: string): Promise<MarketRunView> =>
  (await call(cookie, { method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } })).json<MarketRunView>();
const ticked = async (cookie: string): Promise<string[]> => (await runNow(cookie)).items.filter((i) => i.ticked).map((i) => i.name).sort();
type PantryRow = { id: string; name: string; addedOn?: string; source?: string };
const pantry = async (cookie: string): Promise<PantryRow[]> => (await call(cookie, { method: 'GET', url: '/pantry' })).json<{ items: PantryRow[] }>().items;
const tap = (cookie: string, id: string) => call(cookie, { method: 'POST', url: `/mentor/proposals/${id}/confirm`, payload: { channel: 'tap', today: TODAY } });
const undo = (cookie: string, id: string) => call(cookie, { method: 'POST', url: `/mentor/writes/${id}/undo`, payload: {} });
const status = async (id: string) => (await sql<{ status: string }[]>`select status from mentor_proposals where id = ${id}`)[0].status;
async function seedUsage(userId: string, n: number) {
  for (let i = 0; i < n; i++) await db.insert(usageEvents).values({ userId, feature: 'mentor_text', units: 1, costMicroUsd: 0, createdAt: new Date(NOW.getTime() - HOUR) });
}
const checkOff = (got: string[], missing: string[] = [], text = ''): AiResult => toolCall('propose_check_off', { got, missing }, text);
const contextOf = (req: AiRequest): Record<string, unknown> => {
  const m = req.messages.find((x) => x.role === 'system' && typeof x.content === 'string' && x.content.startsWith('PLAYER CONTEXT'))!;
  return JSON.parse((m.content as string).slice((m.content as string).indexOf('\n') + 1)) as Record<string, unknown>;
};

describe('the closed grammar: ticks at once, with an Undo (C31)', () => {
  test('code-built (grammar) card with AI off ticks at once into the pantry dated today, with an Undo and no tap; the same with AI on and the model silent', async () => {
    for (const ai of [null, fakeAi([])]) {
      await makeApp(ai);
      const p = await player();
      const r = await p.turn('got the shallots and the onion');
      expect(r.route).toBe('deterministic');
      expect(r.notice).toBeNull();
      const { proposalId, card } = checkOffOf(r);
      expect(card).toMatchObject({ source: 'grammar', got: [keyOf(p.run, 'shallots'), keyOf(p.run, 'white onion')], missing: [], summary: 'got shallots and white onion' });
      expect(triggers(r)).toEqual(['market.checkoff_readback', 'market.ticked_pantry']);
      expect(r.parts[1]).toEqual({ kind: 'line', line: { trigger: 'market.ticked_pantry', vars: { items: 'shallots and white onion' } } });
      // Applied already: the trail entry with its Undo, no tap needed, and the health path never ran.
      expect(r.actions).toEqual([{ kind: 'confirmed', proposalId, trail: expect.objectContaining({ kind: 'check_off', summary: '2 ticked', origin: 'server' }) }]);
      expect(await status(proposalId)).toBe('confirmed');
      expect(triggers(r)).not.toContain('rule.ask_keep_off');
      expect(await ticked(p.cookie)).toEqual(['shallots', 'white onion']);
      const rows = await pantry(p.cookie);
      expect(rows.map((x) => ({ name: x.name, addedOn: x.addedOn, source: x.source })).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'shallots', addedOn: TODAY, source: 'market' },
        { name: 'white onion', addedOn: TODAY, source: 'market' },
      ]);
      if (ai !== null) expect(ai.requests).toHaveLength(0);
      await app.close();
    }
  });

  test('a got and a missing clause: the got row ticks, the missing row never does; undo unticks exactly those pantry ids', async () => {
    await makeApp(null);
    const p = await player();
    // A row the player had in the pantry before stays whatever the undo does.
    expect((await call(p.cookie, { method: 'POST', url: '/pantry/changes', payload: { add: [{ name: 'basmati', ingredientId: null }], removeNames: [], removeIds: [], confirmed: true } })).statusCode).toBe(200);
    const r = await p.turn('they were out of curry leaves, got the moong dal');
    const { proposalId, card } = checkOffOf(r);
    expect(card).toMatchObject({ source: 'grammar', got: [keyOf(p.run, 'split moong dal')], missing: [keyOf(p.run, 'curry leaf sprig')] });
    expect(await ticked(p.cookie)).toEqual(['split moong dal']);
    const added = (await pantry(p.cookie)).find((x) => x.name === 'split moong dal')!;
    const u = await undo(p.cookie, proposalId);
    expect(u.statusCode, u.body).toBe(200);
    expect(await ticked(p.cookie)).toEqual([]);
    const after = await pantry(p.cookie);
    expect(after.map((x) => x.name)).toEqual(['basmati']);
    expect(after.some((x) => x.id === added.id)).toBe(false);
    expect(await status(proposalId)).toBe('undone');
  });

  test('a typed "undo" right after undoes the grammar card too', async () => {
    await makeApp(null);
    const p = await player();
    await p.turn('got the shallots');
    expect(await ticked(p.cookie)).toEqual(['shallots']);
    const u = await p.turn('undo');
    expect(u.actions.map((a) => a.kind)).toEqual(['undone']);
    expect(await ticked(p.cookie)).toEqual([]);
  });
});

describe('everything the grammar does not claim goes to the health path (C30)', () => {
  test('a message the grammar does not claim (bare "no fennel", any allergy/diet wording) reaches the health path, writes nothing, and the model is never offered a check-off for it', async () => {
    // Without ai_health: the health gate, exactly as M4 (no model call, nothing written).
    const ai = fakeAi([checkOff([], ['fennel'])]);
    await makeApp(ai);
    const p = await player();
    for (const text of ['no fennel', 'no shallots', "got the shallots, I'm allergic", "got the onion, I can't eat gluten", 'got the shallots, no fennel']) {
      const r = await p.turn(text);
      expect(r, text).toMatchObject({ route: 'scripted', notice: 'needs_ai_health', cards: [], actions: [] });
    }
    expect(ai.requests).toHaveLength(0);
    expect(await ticked(p.cookie)).toEqual([]);
    expect(await pantry(p.cookie)).toEqual([]);
  });

  test('with ai_health, a bare "no X" is never put on a card as missing, and the health ask follows (M03)', async () => {
    const ai = fakeAi([checkOff(['the chicken'], ['fennel']), checkOff([], ['shallots'])]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('got the chicken, no fennel');
    expect(r.route).toBe('ai');
    expect(r.cards.filter((c) => c.card.kind === 'check_off')).toEqual([]); // chicken is no row, fennel only a "no X"
    expect(triggers(r)).toContain('rule.ask_keep_off');
    // "no shallots": the open row is still not marked missing from a bare "no X"; the ask, nothing written.
    const s = await p.turn('no shallots');
    expect(s.cards.filter((c) => c.card.kind === 'check_off')).toEqual([]);
    expect(triggers(s)).toContain('rule.ask_keep_off');
    expect(await ticked(p.cookie)).toEqual([]);
  });

  test('emergency and child phrasing win: nothing ticks', async () => {
    await makeApp(null);
    const p = await player();
    expect(triggers(await p.turn('got the onions, chest pain'))).toContain('rule.emergency');
    expect(triggers(await p.turn('im 7yo, got the onions'))).toEqual(['child.grownup']);
    // The child flag holds for the rest of the conversation: a safe check-off after it is the grown-up line too.
    expect(triggers(await p.turn('got the shallots'))).toEqual(['child.grownup']);
    expect(await ticked(p.cookie)).toEqual([]);
  });
});

describe('a check-off the model proposes waits for the tap (Ruling 14)', () => {
  test('a model-proposed check_off card is pending: nothing ticks until the tap or a typed yes; a severe message never confirms', async () => {
    const ai = fakeAi([checkOff(['shallots']), checkOff(['onion'])]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('found the shallots');
    expect(r.route).toBe('ai');
    const first = checkOffOf(r);
    expect(first.card).toMatchObject({ source: 'model', got: [keyOf(p.run, 'shallots')], summary: 'got shallots' });
    expect(r.actions).toEqual([]);
    expect(triggers(r)).toContain('market.checkoff_readback');
    expect(await ticked(p.cookie)).toEqual([]);
    // A message that is not a strict yes (it states a severe allergy) never confirms it.
    const severe = await p.turn("yes, I'm anaphylactic to peanuts", { answering: first.proposalId });
    expect(severe.actions).toEqual([]);
    expect(await status(first.proposalId)).toBe('open');
    expect(await ticked(p.cookie)).toEqual([]);
    // The tap ticks it.
    const t = await tap(p.cookie, first.proposalId);
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json<{ trail: { summary: string } }>().trail.summary).toBe('1 ticked');
    expect(await ticked(p.cookie)).toEqual(['shallots']);
    // A plain typed yes for the card the client names ticks the next one.
    const r2 = await p.turn('found the onion');
    const second = checkOffOf(r2);
    const yes = await p.turn('yes', { answering: second.proposalId });
    expect(yes.actions.map((a) => a.kind)).toEqual(['confirmed']);
    expect(await ticked(p.cookie)).toEqual(['shallots', 'white onion']);
  });

  test('model propose_check_off with a word the player never said → dropped (R5), no echo', async () => {
    const ai = fakeAi([checkOff(['shallots', 'onion', 'moong dal']), checkOff(['everything on my list'])]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('found the shallots');
    expect(checkOffOf(r).card.got).toEqual([keyOf(p.run, 'shallots')]);
    expect(JSON.stringify(r)).not.toMatch(/onion|moong/i);
    // Words that match no open row: nothing on a card, and never named back.
    const none = await p.turn('[Player tapped Tick] got everything on my list');
    expect(none.cards).toEqual([]);
    expect(triggers(none)).toContain('market.checkoff_none');
    expect(JSON.stringify(none)).not.toMatch(/everything on my list/);
    expect(await ticked(p.cookie)).toEqual([]);
  });

  test('confirm ticks each key into the pantry dated today (source market); undo removes exactly those pantry ids', async () => {
    const ai = fakeAi([checkOff(['shallots', 'onion'])]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const { proposalId } = checkOffOf(await p.turn('found the shallots and the onion'));
    expect((await tap(p.cookie, proposalId)).statusCode).toBe(200);
    const rows = await pantry(p.cookie);
    expect(rows.map((x) => [x.name, x.addedOn, x.source]).sort()).toEqual([
      ['shallots', TODAY, 'market'],
      ['white onion', TODAY, 'market'],
    ]);
    expect((await undo(p.cookie, proposalId)).statusCode).toBe(200);
    expect(await pantry(p.cookie)).toEqual([]);
    expect(await ticked(p.cookie)).toEqual([]);
  });

  test('confirm after a row was ticked on screen → skipped, trail counts only new ticks', async () => {
    const ai = fakeAi([checkOff(['shallots', 'onion'])]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const { proposalId } = checkOffOf(await p.turn('found the shallots and the onion'));
    const onScreen = await call(p.cookie, { method: 'POST', url: `/market-runs/${p.run!.id}/ticks`, payload: { key: keyOf(p.run, 'shallots'), ticked: true, today: TODAY } });
    expect(onScreen.statusCode).toBe(200);
    const t = await tap(p.cookie, proposalId);
    expect(t.json<{ trail: { summary: string }; parts: ReplyPart[] }>().trail.summary).toBe('1 ticked');
    expect(t.json<{ parts: ReplyPart[] }>().parts).toEqual([{ kind: 'line', line: { trigger: 'market.ticked_pantry', vars: { items: 'white onion' } } }]);
    // One pantry row per tick: the on-screen tick's and the card's, never a second shallots.
    expect((await pantry(p.cookie)).map((x) => x.name).sort()).toEqual(['shallots', 'white onion']);
    // Undo unticks only the row the card ticked.
    expect((await undo(p.cookie, proposalId)).statusCode).toBe(200);
    expect(await ticked(p.cookie)).toEqual(['shallots']);
  });
});

describe('no run, the AI cap, consent', () => {
  test('no open run → `market.no_run` + go chip; at the AI cap the grammar still ticks; without health_data → nothing ticks, consent card first, for both sources', async () => {
    // No open run (fix round 1, I1): no code path. The message goes to the health path and the model, exactly as in
    // M4/M5; a model check-off then answers market.no_run and the chip (Ruling 14), with no card and nothing stored.
    const ai = fakeAi([checkOff(['shallots'])]);
    await makeApp(ai);
    const none = await player(['health_data', 'ai_health'], { run: false });
    const r = await none.turn('got the shallots');
    expect(r).toMatchObject({ route: 'ai', cards: [], actions: [] });
    expect(r.parts.slice(0, 2)).toEqual([
      { kind: 'line', line: { trigger: 'market.no_run', vars: {} } },
      { kind: 'go', target: { to: 'market' }, line: { trigger: 'nav.offer', vars: { place: 'the market list' } } },
    ]);
    expect(ai.requests).toHaveLength(1);
    // At the AI cap: the grammar is code, free forever (§16).
    const capped = await player(['health_data', 'ai_health']);
    await seedUsage(capped.userId, 15);
    const c = await capped.turn('got the shallots');
    expect(checkOffOf(c).card.source).toBe('grammar');
    expect(c.actions.map((a) => a.kind)).toEqual(['confirmed']);
    expect(await ticked(capped.cookie)).toEqual(['shallots']);
    expect(ai.requests).toHaveLength(1); // only the no-run turn above reached the model
    await app.close();

    // Without health_data (a "keep" withdrawal): the grammar card waits, pending, behind the consent card; a tap after consent ticks it.
    await makeApp(null);
    const q = await player([]);
    const g = await q.turn('got the shallots');
    const { proposalId, card } = checkOffOf(g);
    expect(card.source).toBe('grammar');
    expect(g.actions).toEqual([]);
    expect(triggers(g)).toEqual(['market.checkoff_readback', 'consent.health_first']);
    expect(g.parts.some((x) => x.kind === 'consent' && x.purpose === 'health_data')).toBe(true);
    expect(await status(proposalId)).toBe('open');
    expect((await tap(q.cookie, proposalId)).statusCode).toBe(403);
    expect((await grant(q.cookie, 'health_data')).statusCode).toBe(201);
    expect((await tap(q.cookie, proposalId)).statusCode).toBe(200);
    expect(await ticked(q.cookie)).toEqual(['shallots']);
    await app.close();

    // The model's card the same way: proposed with consent, tapped after a withdrawal → 403, nothing ticks, still open.
    await makeApp(fakeAi([checkOff(['onion'])]));
    const m = await player(['health_data', 'ai_health']);
    const mc = checkOffOf(await m.turn('found the onion'));
    expect((await call(m.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } })).statusCode).toBe(204);
    expect((await tap(m.cookie, mc.proposalId)).statusCode).toBe(403);
    expect(await status(mc.proposalId)).toBe('open');
    expect((await grant(m.cookie, 'health_data')).statusCode).toBe(201);
    expect((await tap(m.cookie, mc.proposalId)).statusCode).toBe(200);
    expect(await ticked(m.cookie)).toEqual(['white onion']);
  });

  test('the model with no open run: `market.no_run` and the chip, no card', async () => {
    await makeApp(fakeAi([checkOff(['shallots'])]));
    const p = await player(['health_data', 'ai_health'], { run: false });
    const r = await p.turn('found the shallots');
    expect(r.cards).toEqual([]);
    expect(triggers(r)).toContain('market.no_run');
    expect(r.parts.some((x) => x.kind === 'go' && x.target.to === 'market')).toBe(true);
  });

  test('an allergies intake answer, or an open rule card, is never a check-off: the health path', async () => {
    await makeApp(null);
    const p = await player();
    const res = await call(p.cookie, {
      method: 'POST',
      url: '/mentor/turn',
      payload: { conversationId: null, input: { kind: 'text', text: 'no shallots today' }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: 'allergies' },
    });
    expect(res.json<TurnResponse>()).toMatchObject({ route: 'scripted', notice: 'needs_ai_health', cards: [] });
    expect(await ticked(p.cookie)).toEqual([]);
  });
});

describe('the prompt and the post-checks', () => {
  test("prompt context: M6 adds market.runOpen only (no row names, no season region id or category, no seasonal answers, no stall answers); M4's profile.region is unchanged and no other region-derived field exists (C-13, C32)", async () => {
    const ai = fakeAi([reply(''), reply('')]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    expect((await call(p.cookie, { method: 'PUT', url: '/profile', payload: { region: 'Kerala', country: 'India' } })).statusCode).toBe(200);
    await p.turn('what should I cook tonight?');
    const ctx = contextOf(ai.requests[0]);
    expect(Object.keys(ctx).sort()).toEqual(['dish', 'intakeStep', 'market', 'mealsToday', 'openCards', 'pantry', 'profile', 'rules', 'slot', 'turnsLeftToday', 'week', 'weekday'].sort());
    expect(ctx.market).toEqual({ runOpen: true });
    expect(Object.keys(ctx.profile as object).sort()).toEqual(['marketDays', 'mealWindows', 'mealsPerWeek', 'region']);
    expect((ctx.profile as { region: string }).region).toBe('Kerala');
    const sent = JSON.stringify(ai.requests[0].messages.slice(-2));
    for (const word of ['shallot', 'curry leaf', 'moong', 'black bean', 'pnw', 'season', 'stall', 'wen', 'okafor']) expect(sent.toLowerCase(), word).not.toContain(word);
    // Without an open run (none this week) it is false.
    const q = await player(['health_data', 'ai_health'], { run: false });
    await q.turn('what should I cook tonight?');
    expect(contextOf(ai.requests[1]).market).toEqual({ runOpen: false });
  });

  test('postcheck: a reply claiming a tick with no card is replaced by write.not_done', async () => {
    const ai = fakeAi([reply("Done! I've ticked the shallots off your list."), reply('I checked them all off for you.')]);
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('what should I cook tonight?');
    expect(r.cards).toEqual([]);
    expect(triggers(r)).toEqual(['write.not_done']);
    const r2 = await p.turn('what goes with rice?');
    expect(triggers(r2)).toContain('write.not_done');
    expect(await ticked(p.cookie)).toEqual([]);
  });

  test('a player asking for a tick that made no card gets write.not_done', async () => {
    await makeApp(fakeAi([reply('')]));
    const p = await player(['health_data', 'ai_health']);
    const r = await p.turn('tick off the chicken please');
    expect(r.cards).toEqual([]);
    expect(triggers(r)).toContain('write.not_done');
  });
});

describe('fix round 1', () => {
  test('I1: with no open run, "I bought milk", "got eggs, milk and rice" and "picked up some tofu" are pantry adds exactly as in M4/M5', async () => {
    const texts = ['I bought milk', 'got eggs, milk and rice', 'picked up some tofu'];
    const adds = [['milk'], ['eggs', 'milk', 'rice'], ['tofu']];
    const ai = fakeAi(adds.map((add) => toolCall('propose_pantry_change', { add, remove: [] })));
    await makeApp(ai);
    const p = await player(['health_data', 'ai_health'], { run: false });
    for (const [i, text] of texts.entries()) {
      const r = await p.turn(text);
      expect(r.route, text).toBe('ai');
      expect(r.cards.map((c) => c.card.kind), text).toEqual(['pantry']);
      expect(triggers(r), text).not.toContain('market.no_run');
      expect(r.cards[0].card.kind === 'pantry' && r.cards[0].card.add.map((a) => a.name), text).toEqual(adds[i]);
    }
    expect(ai.requests).toHaveLength(3);
    // Without ai_health: the health gate, as M4 (the scripted engine on the device takes it), never market.no_run.
    await app.close();
    await makeApp(null);
    const q = await player(['health_data'], { run: false });
    for (const text of texts) expect(await q.turn(text), text).toMatchObject({ route: 'scripted', notice: 'needs_ai_health', cards: [] });
  });

  test('I1: a pantry intake answer is never market.no_run, with or without a run', async () => {
    await makeApp(null);
    for (const run of [false, true]) {
      const p = await player(['health_data'], { run });
      const res = await call(p.cookie, {
        method: 'POST',
        url: '/mentor/turn',
        payload: { conversationId: null, input: { kind: 'text', text: 'got eggs and rice' }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: 'pantry' },
      });
      const r = res.json<TurnResponse>();
      expect(triggers(r)).not.toContain('market.no_run');
      expect(r).toMatchObject({ route: 'scripted', notice: 'needs_ai_health', cards: [], actions: [] });
    }
  });

  test("m2: channel 'grammar' applies only a grammar check-off card; a model card is refused and stays open", async () => {
    await makeApp(fakeAi([checkOff(['shallots'])]));
    const p = await player(['health_data', 'ai_health']);
    const { proposalId } = checkOffOf(await p.turn('found the shallots'));
    await expect(db.transaction((tx) => confirmProposalIn(tx, { keyring: config.keyring, catalog }, p.userId, proposalId, 'grammar', undefined, NOW))).rejects.toThrow(
      /only a grammar check-off card/,
    );
    expect(await status(proposalId)).toBe('open');
    expect(await ticked(p.cookie)).toEqual([]);
  });

  test('m2: the run is read again under the locks: a row ticked on screen between the two reads is never on the card', async () => {
    await makeApp(null);
    const p = await player();
    const shallots = keyOf(p.run, 'shallots');
    let turn: Promise<TurnResponse> | undefined;
    await db.transaction(async (tx) => {
      // Hold the user row and tick shallots, uncommitted: the turn's first read (no lock) still sees the row open,
      // then the turn waits on the user row; it reads again once this commits.
      await lockLiveUser(tx, p.userId);
      const week = { keyring: config.keyring, catalog, loop: defaultLoopContent(), recipes: await createRecipeIndexSource().current(tx) };
      await tickIn(tx, week, p.userId, p.run!.id, shallots, true, NOW, undefined, TODAY);
      turn = p.turn('got the shallots and the onion');
      for (let i = 0; i < 200; i++) {
        const [w] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
        if (w.n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    const r = await turn!;
    // Shallots is no open row now, so the grammar claims nothing: the health path, no card.
    expect(r.cards.filter((c) => c.card.kind === 'check_off')).toEqual([]);
    expect(r).toMatchObject({ route: 'scripted', notice: 'needs_ai_health' });
    expect(await ticked(p.cookie)).toEqual(['shallots']);
  });

  test('m5: the stored Pan message is exactly the reply the player got, built from the rows actually ticked', async () => {
    await makeApp(null);
    const p = await player();
    const r = await p.turn('got the shallots and the onion');
    const history = await recentMessages(db, config.keyring, app.mentor.memory, p.userId, r.conversationId!, true, NOW);
    const pan = history.filter((m) => m.role === 'pan').at(-1);
    expect(pan).toMatchObject({ role: 'pan', parts: r.parts, proposalIds: [checkOffOf(r).proposalId] });
  });
});
