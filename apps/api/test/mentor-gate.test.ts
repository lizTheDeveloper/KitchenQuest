// Task 9 fix round 1 (review flakes): the N6/N7 code-card gate, tested directly on the functions /mentor/turn calls,
// with no HTTP and no database. mentor-plan.test.ts keeps one or two /mentor/turn probes per gate as integration smoke.
// M7 Step 7 (M6 final M6): the after-model gate is the turn's own exported `codeCardGate`, never a copy here; and (P13)
// a transcript naming a food is stopped by its heard card before the check-off grammar and the gate (HTTP, below).
// The turn (apps/api/src/mentor/turn.ts):
//   - stage 4: a health text (core `isHealthText`, via ./health) with no ai_health → `needs_ai_health`, no model, no card;
//   - stage 5b: code's own plan card only from the closed grammar (`planIntent`) on a turn that isn't health;
//   - after the model: code cards only when `codeCardHealth` is false, from `planWordsIn`, `reminderSlots` and
//     `marketDayStated` (each consumes the whole message, or gives nothing, N6).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { heardCheck, parseRecipe, planIntent, type MarketRunView, type Plan, type TurnResponse } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { isHealthText } from '../src/mentor/health.js';
import { MENTOR_TOOLS } from '../src/mentor/tools.js';
import { codeCardGate } from '../src/mentor/turn.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { fakeAi, toolCall } from './helpers/fake-ai.js';
import { N6_TEXTS, N7_TEXTS } from './helpers/gate-texts.js';

const catalog = defaultCatalog();
const cookFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? cookFiles(f) : f.endsWith('.cook') ? [f] : []; });
const dishes = cookFiles(RECIPES_DIR).map((f) => ({ slug: f.slice(RECIPES_DIR.length).replace(/\.cook$/, ''), title: parseRecipe(readFileSync(f, 'utf8')).meta.title }));

const ALL_TOOLS: ReadonlySet<string> = new Set(MENTOR_TOOLS.map((t) => t.name));
/** The turn's own after-model gate (`codeCardGate`), every tool offered and the model silent: whether it builds anything. */
const afterModel = (text: string): boolean => {
  const g = codeCardGate(text, dishes, catalog, ALL_TOOLS, []);
  return g.words !== null || g.timed.length > 0 || g.market !== null;
};
/** Whether any code card can come of this text on a turn whose model makes no call (both players: the code paths alone). */
function codeCard(text: string): boolean {
  // Stage 5b (codeRoute) runs only on a turn that isn't health (stage 4's `isHealthTurn`).
  if (!isHealthText(text, catalog) && planIntent(text, dishes) !== null) return true;
  return afterModel(text);
}

describe('the N6/N7 code-card gate, directly (fix round 1)', () => {
  test('the canon dishes are read', () => {
    expect(dishes.map((d) => d.slug).sort()).toContain('india/kerala/parippu');
  });

  test('N6: a clause outside the closed grammar anywhere in the message → no code card', () => {
    expect(N6_TEXTS.filter(codeCard)).toEqual([]);
  });

  test('N6: closed clauses with a neutral clause still make their cards (the gate is not just "never")', () => {
    for (const t of ['remind me about dinner at 6pm, thanks', 'ok, my market day is saturday', "put parippu on monday and my market's saturday, thanks"]) expect(codeCard(t), t).toBe(true);
  });

  test('N7: every health text is health (needs_ai_health without ai_health) and makes no code card with it', () => {
    expect(N7_TEXTS.filter((t) => !isHealthText(t, catalog))).toEqual([]);
    expect(N7_TEXTS.filter(codeCard)).toEqual([]);
  });
});

describe('M7 Step 7 (M6 final M6): the exported gate is the one the turn runs, in the turn\'s order', () => {
  const source = readFileSync(new URL('../src/mentor/turn.ts', import.meta.url), 'utf8');
  const body = (name: string) => {
    const at = source.indexOf(`function ${name}(`);
    expect(at, name).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf('\n}\n', at));
  };
  const inOrder = (text: string, needles: string[]) => {
    const at = needles.map((n) => text.indexOf(n));
    for (const [i, n] of needles.entries()) expect(at[i], n).toBeGreaterThan(-1);
    expect(at, needles.join(' < ')).toEqual([...at].sort((a, b) => a - b));
  };

  test('codeCardGate checks the health words first, then the three readers; finishTurn builds its code cards only through it', () => {
    inOrder(body('codeCardGate'), ['codeCardHealth(', 'planWordsIn(', 'reminderSlots(', 'marketDayStated(']);
    const finish = body('finishTurn');
    expect(finish).toContain('codeCardGate(');
    for (const reader of ['planWordsIn(', 'reminderSlots(', 'marketDayStated(', 'codeCardHealth(']) expect(finish, reader).not.toContain(reader);
  });

  test('a reorder of the turn fails: heard gate → check-off grammar → health gate → code route → model → finish (gate)', () => {
    inOrder(body('turnAt'), ['heardCheck(raw', 'checkOffRoute(', 'isHealthTurn(', 'codeRoute(', 'deps.ai.complete(', 'finishTurn(']);
  });

  test('the gate gives nothing on a health message, whatever the readers could build, and builds cards on a closed one', () => {
    expect(afterModel('remind me about dinner at 6pm, thanks')).toBe(true);
    expect(afterModel('my market day is saturday')).toBe(true);
    for (const t of N7_TEXTS) expect(codeCardGate(t, dishes, catalog, ALL_TOOLS, []), t).toEqual({ words: null, timed: [], market: null });
    // A call of that kind already made: code adds no second one.
    expect(codeCardGate('remind me about dinner at 6pm, thanks', dishes, catalog, ALL_TOOLS, [{ name: 'propose_profile', args: { market_days: null, meals_per_week: null, region: null, country: null, meal_windows: null } }]).timed).toEqual([]);
    // A tool not offered (rule help, no ai_health): nothing from it.
    expect(codeCardGate('my market day is saturday', dishes, catalog, new Set(['propose_rule']), []).market).toBeNull();
  });
});

// ---- P13: over HTTP, a transcript naming a food reaches its heard card first ----

const config = testConfig();
const NOW = new Date('2026-11-10T18:00:00Z');
const TODAY = '2026-11-10';
const WEEK = '2026-11-09';
let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | undefined;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
  await sql`delete from canon_recipes`;
  await syncCanon(db, RECIPES_DIR, catalog.graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('P13: a transcript naming a food is stopped by its heard card before the check-off grammar and the code-card gate', () => {
  test('Step 6\'s probes and the N7 texts that name a food, spoken with an open market run: the heard part, no model call, no card, nothing ticked or kept', async () => {
    // The model would make a plan, a profile and a check-off card if it were ever called.
    const ai = fakeAi(Array.from({ length: 40 }, () => toolCall('propose_check_off', { got: ['shallots'], missing: [] })));
    const mailer = new CaptureMailer();
    app = await buildApp({ config, db, mailer, ai, now: () => NOW, logger: false });
    const cookie = await signIn(app, mailer, `gate${++seq}@example.com`);
    const call = (opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });
    for (const purpose of ['health_data', 'ai_health'] as const) {
      expect((await call({ method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } })).statusCode).toBe(201);
    }
    const plan: Plan = { weekStart: WEEK, items: [{ day: 6, kind: 'dish', slug: 'india/kerala/parippu', servings: 3 }, { day: 1, kind: 'dish', slug: 'mexico/oaxaca/frijoles-de-olla', servings: 6 }], hard: false, slot: 'unanswered' };
    expect((await call({ method: 'PUT', url: `/plans/${WEEK}`, payload: { plan, confirmed: true, today: TODAY } })).statusCode).toBe(200);
    const run = (await call({ method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } })).json<MarketRunView>();
    const userId = (await call({ method: 'GET', url: '/me' })).json<{ id: string }>().id;
    // Step 6's probes (one per mishearing group, the spoken check-off) and every N7 text the heard check stops.
    const texts = ['got the shallots', 'got the shallots and the onion', "i'm allergic to rice", "i'm allergic to selfish", 'pea cans please', ...N7_TEXTS.filter((t) => heardCheck(t, catalog.graph, catalog.ruleTerms) !== null)];
    expect(texts.length).toBeGreaterThan(10);
    for (const text of texts) {
      expect(heardCheck(text, catalog.graph, catalog.ruleTerms), text).not.toBeNull();
      const res = await call({ method: 'POST', url: '/mentor/turn', payload: { conversationId: null, input: { kind: 'transcript', text }, localDate: TODAY, localTime: '18:30', screen: null, intakeStep: null } });
      expect(res.statusCode, text).toBe(200);
      const r = res.json<TurnResponse>();
      expect(r.parts[0]?.kind, text).toBe('heard');
      expect({ cards: r.cards, actions: r.actions, route: r.route }, text).toEqual({ cards: [], actions: [], route: 'deterministic' });
    }
    expect(ai.requests).toHaveLength(0);
    const now = (await call({ method: 'POST', url: '/market-runs', payload: { weekStart: WEEK, today: TODAY } })).json<MarketRunView>();
    expect(now.items.filter((i) => i.ticked)).toEqual([]);
    expect(run.items.length).toBeGreaterThan(0);
    for (const table of ['mentor_proposals', 'messages', 'usage_events']) {
      expect((await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where user_id = ${userId}`)[0].n, table).toBe(0);
    }
  }, 60_000);
});
