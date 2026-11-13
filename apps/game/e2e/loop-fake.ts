// M5 Step 12: a small stateful fake of the API for the weekly-loop flows (weekly-loop and free-forever e2e). It keeps
// the plan, the rules, the notes, the meal logs and every progress event posted, and answers the week's routes the
// way Step 6 does (a market run whose ticks and finish it records). Mocked /api/** only: tests never touch the network.
import { randomUUID } from 'node:crypto';
import type { Page, Request, Route } from 'playwright';
import { UNDO_WINDOW_MS, type Plan, type ProgressEvent, type ProgressView } from '@kitchenquest/core/engine';

export const PARIPPU = 'india/kerala/parippu';
export const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
/** Market day: Saturday 14 November 2026, mid-morning, local time. The plan week starts today. */
export const NOW = new Date(2026, 10, 14, 10, 0, 0);
export const WEEK = '2026-11-14';
const json = (status: number, body: unknown) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

export interface Fake { requests: Request[]; plan: Plan | null; events: ProgressEvent[]; uploads: boolean[]; rules: unknown[]; notes: unknown[]; meals: string[] }

export function planCard(): object {
  const items = [
    { day: 1, kind: 'dish', slug: PARIPPU, servings: 3 },
    { day: 3, kind: 'dish', slug: 'japan/osaka/onigiri', servings: 2 },
    { day: 5, kind: 'dish', slug: FRIJOLES, servings: 4 },
  ];
  return {
    kind: 'plan', weekStart: WEEK, items, hard: false,
    checks: items.map((i) => ({ slug: i.slug, status: 'ok' })), unknown: [], dropped: [], offer: null,
    summary: 'Sunday: Parippu Curry; Tuesday: Onigiri; Thursday: Frijoles de Olla.', added: items, basis: '00000000',
    readback: [{ trigger: 'plan.readback', vars: { summary: 'Sunday: Parippu Curry; Tuesday: Onigiri; Thursday: Frijoles de Olla' } }],
  };
}

const RUN_ITEMS = [
  { key: 'moong_dal', name: 'split moong dal', ingredientId: 'moong_dal', stall: 'okafor-sato', forDishes: [PARIPPU], ticked: false },
  { key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [PARIPPU], ticked: false },
  { key: 'mustard_seed', name: 'mustard seeds', ingredientId: 'mustard_seed', stall: 'spice', forDishes: [PARIPPU], ticked: false },
  { key: 'rice', name: 'Japanese short-grain rice', ingredientId: 'rice', stall: 'general', forDishes: ['japan/osaka/onigiri'], ticked: false },
];

export interface FakeOptions {
  /** The account's own view (GET /progress). */
  view: ProgressView;
  /** The pantry GET /pantry answers with. */
  pantry?: unknown[];
  /** What POST /mentor/turn answers: the plan card (the AI on), or the capped scripted turn. */
  turn?: 'plan_card' | 'capped';
}

export const newFake = (): Fake => ({ requests: [], plan: null, events: [], uploads: [], rules: [], notes: [], meals: [] });

export async function fakeApi(page: Page, fake: Fake, opts: FakeOptions): Promise<void> {
  const ACCOUNT_VIEW = opts.view;
  const run = { id: 'run1', weekStart: WEEK, items: RUN_ITEMS.map((i) => ({ ...i })), doneAt: null as string | null };
  const consents = {
    consents: ['health_data', 'ai_health'].map((purpose) => ({ purpose, noticeVersion: purpose === 'health_data' ? 'v3' : 'v1', noticeSha256: 'x', method: 'tap', grantedAt: '2026-11-01T00:00:00Z', withdrawnAt: null, endedReason: null, current: true })),
    needsReconsent: [], notices: {},
  };
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/')) fake.requests.push(r); });
  await page.route((u) => u.pathname.startsWith('/api/'), async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname.replace(/^\/api/, '');
    const m = req.method();
    const body = () => req.postDataJSON() as Record<string, unknown>;
    if (path === '/me') return route.fulfill(json(200, { id: 'u1', email: 'cook@example.com', entitlements: [] }));
    if (path === '/me/consents') return route.fulfill(json(200, consents));
    if (path === '/profile') return route.fulfill(json(200, { marketDays: [6], mealsPerWeek: null, country: null, region: null, mealWindows: [] }));
    if (path === '/rules' && m === 'GET') return route.fulfill(json(200, { rules: fake.rules }));
    if (path === '/rules' && m === 'POST') {
      const rule = { ...(body().rule as object), id: `s${fake.rules.length + 1}` };
      fake.rules.push(rule);
      return route.fulfill(json(201, { rule }));
    }
    if (path === '/pantry' && m === 'GET') return route.fulfill(json(200, { items: opts.pantry ?? [] }));
    if (path === '/progress') return route.fulfill(json(200, { view: ACCOUNT_VIEW }));
    if (path === '/progress/events') {
      const b = body() as { events: ProgressEvent[]; upload?: boolean };
      fake.events.push(...b.events);
      fake.uploads.push(b.upload === true);
      // M7 Step 9 (M6 fix review N3): the server's grants replace the device's for every accepted event, so this fake
      // answers with the grants the server's core computes for them. Same core, same catalogue, one account: they are
      // the device's own, read from the page (the server agrees with the device here).
      const mine = await page.evaluate(({ k, ids }) => {
        const st = JSON.parse(localStorage.getItem(k) ?? '{}') as { progress?: { grants?: { eventId: string }[] }; accountProgress?: Record<string, { progress: { grants: { eventId: string }[] } }> };
        return [...(st.progress?.grants ?? []), ...Object.values(st.accountProgress ?? {}).flatMap((p) => p.progress.grants)].filter((g) => ids.includes(g.eventId));
      }, { k: 'kq.player.v1', ids: b.events.map((e) => e.id) });
      const accepted = b.events.map((e) => ({ clientId: e.id, grants: mine.filter((g) => g.eventId === e.id) }));
      return route.fulfill(json(200, { accepted, duplicate: [], rejected: [], warnings: [], view: ACCOUNT_VIEW }));
    }
    if (path === '/plans/current') return route.fulfill(json(200, { plan: fake.plan ? { ...fake.plan, id: 'plan1' } : null, weekStart: WEEK, checks: [] }));
    if (path === `/plans/${WEEK}` && m === 'PUT') {
      fake.plan = (body() as { plan: Plan }).plan;
      return route.fulfill(json(200, { plan: { ...fake.plan, id: 'plan1' }, checks: [] }));
    }
    if (path === '/mentor/turn' && opts.turn === 'capped') {
      return route.fulfill(json(200, { conversationId: null, route: 'scripted', parts: [], cards: [], actions: [], notice: 'rate_limited', toolTurn: false }));
    }
    if (path === '/mentor/turn') {
      return route.fulfill(json(200, {
        conversationId: 'c1', route: 'ai', notice: null, toolTurn: true, actions: [],
        parts: [{ kind: 'line', line: (planCard() as { readback: unknown[] }).readback[0] }],
        cards: [{ proposalId: 'P1', expiresAt: new Date(NOW.getTime() + 30 * 60_000).toISOString(), card: planCard() }],
      }));
    }
    if (path === '/mentor/proposals/P1/confirm') {
      const c = planCard() as Plan & { summary: string };
      fake.plan = { weekStart: WEEK, items: c.items, hard: false, slot: 'unanswered' };
      return route.fulfill(json(200, {
        trail: { id: 'P1', origin: 'server', kind: 'plan', summary: c.summary, undoUntil: new Date(NOW.getTime() + UNDO_WINDOW_MS).toISOString() },
        parts: [{ kind: 'line', line: { trigger: 'plan.saved', vars: {} } }],
      }));
    }
    if (path === '/market-runs') return route.fulfill(json(200, run));
    if (path === '/market-runs/run1/ticks') {
      const b = body() as { key: string; ticked: boolean };
      const row = run.items.find((i) => i.key === b.key)!;
      row.ticked = b.ticked;
      return route.fulfill(json(200, run));
    }
    if (path === '/market-runs/run1/finish') {
      run.doneAt ??= NOW.toISOString();
      return route.fulfill(json(200, run));
    }
    if (path === '/notes' && m === 'GET') return route.fulfill(json(200, { notes: fake.notes }));
    if (path === '/notes' && m === 'POST') {
      const note = { ...(body().note as object), id: randomUUID() };
      fake.notes.push(note);
      return route.fulfill(json(201, { note: { ...note, check: { status: 'ok', findings: [], severe: false, disclaimer: null } } }));
    }
    if (path === '/shared-table' && m === 'POST') return route.fulfill(json(201, { id: randomUUID() }));
    if (path === '/shared-table/tally') return route.fulfill(json(200, { shared: 0, byRecipe: {} }));
    if (path === '/meals' && m === 'POST') {
      const id = randomUUID();
      fake.meals.push(id);
      return route.fulfill(json(201, { meal: { ...(body().meal as object), id } }));
    }
    if (path.startsWith('/meals/') && m === 'DELETE') {
      fake.meals = fake.meals.filter((id) => !path.endsWith(id));
      return route.fulfill({ status: 204 });
    }
    return route.fulfill(json(404, { error: { code: 'not_found', message: `no mock for ${m} ${path}` } }));
  });
}
