// M6 Step 11: a small stateful fake of the API for the market flows (market-week and free-forever e2e). Mocked
// /api/** only: tests never touch the network. The server's decisions are mocked the way Steps 6–8 make them: 5 XP for
// a first right answer and one stamp a stall a week, the run recomputed under the rules (a coconut rule takes
// parippu's unticked rows), the closed grammar's check-off card applied at once, a model card only on its tap, and at
// the AI cap (`turn: 'capped'`) a scripted turn for anything the grammar does not claim.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page, Route } from 'playwright';
import { parse } from 'yaml';
import { buildCheckOffCard, UNDO_WINDOW_MS, type ListItem, type MarketRunView, type ProgressEvent, type ProgressView, type RewardGrant } from '@kitchenquest/core/engine';
import type { LocalProfile } from '../src/state/store';

export const yaml = <T>(rel: string): T => parse(readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8')) as T;
export interface Q { id: string; contains?: string[]; countries?: string[]; options: { text: string; correct?: boolean }[] }
interface Stall { name: string; questions: Q[]; seasonal?: Record<string, Record<string, Q[]>>; variants?: { protein_counter: { name: string; questions: Q[] } } }
export const stalls = Object.fromEntries(['wen', 'bram', 'okafor-sato', 'spice'].map((s) => [s, yaml<Stall>(`content/market/${s}.yaml`)])) as Record<string, Stall>;
const allQuestions = (s: Stall): Q[] => [...s.questions, ...(s.variants?.protein_counter.questions ?? []), ...Object.values(s.seasonal ?? {}).flatMap((m) => Object.values(m).flat())];
export const question = (id: string): Q => Object.values(stalls).flatMap(allQuestions).find((q) => q.id === id)!;
export const rightPick = (id: string) => question(id).options.findIndex((o) => o.correct === true);
export const wrongPick = (id: string) => question(id).options.findIndex((o) => o.correct !== true);

export const PARIPPU = 'india/kerala/parippu';
/** Saturday 14 November 2026, mid-morning, local time. With no market day the plan week is Monday 9 … Sunday 15. */
export const NOW = new Date(2026, 10, 14, 10, 0, 0);
export const MONDAY = '2026-11-09';
export const TODAY = '2026-11-14';
/** The Pacific Northwest, as a player writes it ("Washington" alone is ambiguous with DC: core gives null, Step 2 I2). */
export const PNW: LocalProfile = { marketDays: [], mealsPerWeek: null, country: 'United States', region: 'Washington State', mealWindows: [] };
export const KERALA: LocalProfile = { ...PNW, country: 'India', region: 'Kerala' };
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });


/** Parippu's rows on the server's run, for 3 servings (the device computes the same list). */
export const RUN_ROWS = (): ListItem[] => [
  ['curry_leaf_sprig', 'curry leaf sprig', 'wen', '1'], ['garlic', 'garlic clove', 'wen', '1'], ['grated_coconut', 'grated coconut', 'wen', '60 g'],
  ['green_chili', 'green chillies', 'wen', '2'], ['shallot', 'shallots', 'wen', '3'], ['moong_dal', 'split moong dal', 'okafor-sato', '100 g'],
  ['cumin_seed', 'cumin seeds', 'spice', '0.5 tsp'], ['dried_red_chili', 'dried red chillies', 'spice', '2'], ['mustard_seed', 'mustard seeds', 'spice', '0.5 tsp'],
  ['turmeric', 'turmeric', 'spice', '0.25 tsp'], ['coconut_oil', 'coconut oil', 'general', '1 tbsp'], ['ghee', 'ghee', 'general', '1 tsp'],
  ['pappadam', 'pappadam', 'general', '3'], ['salt', 'salt', 'general', '0.75 tsp'],
].map(([key, name, stall, text]) => {
  const [q, unit] = text.split(' ');
  return { key, name, ingredientId: key, stall: stall as ListItem['stall'], forDishes: [PARIPPU], ticked: false, amounts: [{ quantity: Number(q), unit: unit ?? null, text }] };
});

export interface ServerFake {
  rules: (object & { id: string })[]; profile: { country: string | null; region: string | null };
  run: MarketRunView; view: ProgressView; posted: ProgressEvent[]; granted: RewardGrant[]; calls: string[];
}
export function newServer(): ServerFake {
  const marketAnswered = Object.fromEntries(stalls.wen.questions.map((q) => [q.id, { correct: true, lastAt: '2026-10-19' }]));
  return {
    rules: [], profile: { country: PNW.country, region: PNW.region }, posted: [], granted: [], calls: [],
    run: { id: 'run1', weekStart: MONDAY, doneAt: null, items: RUN_ROWS() },
    view: { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered },
  };
}
const blocksCoconut = (f: ServerFake) => f.rules.some((r) => JSON.stringify(r).includes('"coconut"'));
/** The server's recompute (C20, C23): under a rule that blocks parippu, only its ticked and stall-swap rows stay. */
function recomputed(f: ServerFake): MarketRunView {
  if (f.run.doneAt === null && blocksCoconut(f)) f.run.items = f.run.items.filter((i) => i.ticked || i.stockSwap !== undefined);
  return f.run;
}
const inHalfAnHour = () => new Date(Date.now() + 30 * 60_000).toISOString();
const line = (trigger: string, vars: Record<string, string> = {}) => ({ kind: 'line', line: { trigger, vars } });

export async function serverApi(page: Page, f: ServerFake, opts: { turn?: 'capped' } = {}): Promise<void> {
  const consents = {
    consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
    needsReconsent: [], notices: {},
  };
  const grantCheckOff = (keys: string[], source: 'grammar' | 'model', id: string) => {
    const card = buildCheckOffCard(f.run, keys, [], source)!;
    return { proposalId: id, expiresAt: inHalfAnHour(), card };
  };
  const tick = (key: string) => { const row = f.run.items.find((i) => i.key === key); if (row) row.ticked = true; };
  await page.route((u) => u.pathname.startsWith('/api/'), async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    const m = req.method();
    f.calls.push(`${m} ${path}`);
    const body = () => req.postDataJSON() as Record<string, unknown>;
    if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
    if (path === '/me/consents') return route.fulfill(json(200, consents));
    if (path === '/profile') return route.fulfill(json(200, { marketDays: [], mealsPerWeek: null, ...f.profile, mealWindows: [] }));
    if (path === '/rules') return route.fulfill(json(200, { rules: f.rules }));
    if (path === '/pantry') return route.fulfill(json(200, { items: [] }));
    if (path === '/progress') return route.fulfill(json(200, { view: f.view }));
    if (path === '/progress/events') {
      const { events } = body() as { events: ProgressEvent[] };
      const accepted = events.map((e) => {
        f.posted.push(e);
        const grants: RewardGrant[] = [];
        if (e.kind === 'stall_round') {
          let n = 0;
          for (const a of e.answers) {
            const correct = a.pick === rightPick(a.q);
            const was = f.view.marketAnswered[a.q]?.correct === true;
            f.view.marketAnswered[a.q] = { correct: was || correct, lastAt: e.at };
            if (correct && !was) { grants.push({ id: `${e.id}#${n++}`, eventId: e.id, isoDay: e.at, kind: 'xp', amount: 5, reason: 'market_game' }); f.view.xp += 5; }
          }
          const stamped = f.posted.some((p) => p !== e && p.kind === 'stall_round' && p.stall === e.stall && p.at >= MONDAY);
          if (!stamped) { grants.push({ id: `${e.id}#${n++}`, eventId: e.id, isoDay: e.at, kind: 'stamp', stamp: 'market_game' }); f.view.stamps += 1; }
        }
        f.granted.push(...grants);
        return { clientId: e.id, grants };
      });
      return route.fulfill(json(200, { accepted, duplicate: [], rejected: [], warnings: [], view: f.view }));
    }
    if (path === '/plans/current') {
      const plan = { weekStart: MONDAY, items: [{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }], hard: false, slot: 'unanswered', id: 'plan1' };
      return route.fulfill(json(200, { plan, weekStart: MONDAY, checks: [{ item: plan.items[0], status: blocksCoconut(f) ? 'blocked' : 'ok', findings: [] }] }));
    }
    if (path === '/market-runs/current') return route.fulfill(json(200, { run: recomputed(f) }));
    if (path === '/market-runs') return route.fulfill(json(200, recomputed(f)));
    if (path === '/market-runs/run1/ticks') {
      const b = body() as { key: string; ticked: boolean };
      f.run.items.find((i) => i.key === b.key)!.ticked = b.ticked;
      return route.fulfill(json(200, f.run));
    }
    if (path === '/market-runs/run1/stock') {
      const b = body() as { key: string; action: string; toId?: string };
      const row = f.run.items.find((i) => i.key === b.key)!;
      if (b.action === 'out') { row.outOfStock = true; row.ticked = false; }
      if (b.action === 'take' && b.key === 'shallot' && b.toId === 'onion') {
        row.outOfStock = true; row.ticked = false;
        f.run.items.splice(f.run.items.indexOf(row), 0, { key: 'stock:onion', name: 'onion', ingredientId: 'onion', stall: 'wen', forDishes: [PARIPPU], stockSwap: { from: 'shallot' }, ticked: true });
      } else if (b.action === 'take') return route.fulfill(json(400, { error: { code: 'stock_invalid', message: 'x' } }));
      return route.fulfill(json(200, f.run));
    }
    if (path === '/market-runs/run1/finish') { f.run.doneAt ??= NOW.toISOString(); return route.fulfill(json(200, f.run)); }
    if (path === '/mentor/turn') {
      const text = ((body().input as { text?: string }).text ?? '').toLowerCase();
      if (text === 'got the moong dal') {
        // The closed grammar's card (C30, C31): applied at once by the server, with an Undo.
        tick('moong_dal');
        const c = grantCheckOff(['moong_dal'], 'grammar', 'P1');
        return route.fulfill(json(200, {
          conversationId: 'c1', route: 'deterministic', notice: null, toolTurn: false,
          parts: [line('market.checkoff_readback', { summary: c.card.summary }), line('market.ticked_pantry', { items: 'split moong dal' })],
          cards: [c],
          actions: [{ kind: 'confirmed', proposalId: 'P1', trail: { id: 'P1', origin: 'server', kind: 'check_off', summary: '1 ticked', undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() } }],
        }));
      }
      if (opts.turn === 'capped') {
        // The daily AI allowance used up: the server answers with the script (M4), never the model.
        return route.fulfill(json(200, { conversationId: null, route: 'scripted', parts: [], cards: [], actions: [], notice: 'rate_limited', toolTurn: false }));
      }
      if (text === 'no fennel') {
        return route.fulfill(json(200, { conversationId: 'c1', route: 'scripted', notice: null, toolTurn: false, parts: [line('rule.ask_keep_off')], cards: [], actions: [] }));
      }
      // The model's propose_check_off: a card that ticks nothing until the tap.
      const c = grantCheckOff(['green_chili'], 'model', 'P2');
      return route.fulfill(json(200, { conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, parts: c.card.readback.map((l) => ({ kind: 'line', line: l })), cards: [c], actions: [] }));
    }
    if (path === '/mentor/proposals/P2/confirm') {
      tick('green_chili');
      return route.fulfill(json(200, {
        trail: { id: 'P2', origin: 'server', kind: 'check_off', summary: '1 ticked', undoUntil: new Date(Date.now() + UNDO_WINDOW_MS).toISOString() },
        parts: [line('market.ticked_pantry', { items: 'green chillies' })],
      }));
    }
    return route.fulfill(json(404, { error: { code: 'not_found', message: `no mock for ${m} ${path}` } }));
  });
}
