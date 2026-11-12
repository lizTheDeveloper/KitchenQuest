// @vitest-environment happy-dom
// M6 Step 10: market day on Form 12-M: amounts, stall swaps (core stockSwaps only), the Season's Table (core seasonNote /
// dishSeasonNote only, ✅ items only, following data/seasonality.yaml), and the plan view's note (text only).
import { describe, expect, test } from 'vitest';
import { stockSwaps, type ListItem, type Plan, type Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { buildRecipeCard } from '../recipes/card-model';
import { activeRules } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import { planContextFor } from './context';
import { createWeekStore } from './local-week';
import { amountText, marketScreen } from './market-screen';
import { stockSwapsNow } from './market-swaps';
import { writtenLine } from './plan-view';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const MON = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(2026, 10, 11, 12, 0);
const noClient = new Proxy({}, { get: (_t, name: string) => () => Promise.reject(new Error(`unexpected call: ${name}`)) }) as ApiClient;
const plan = (items: Plan['items']): Plan => ({ weekStart: MON, items, hard: false, slot: 'unanswered' });
const dish = (day: number, slug: string, servings = 3) => ({ day, kind: 'dish' as const, slug, servings });
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
function store(patch: Partial<PlayerState> = {}): PlayerStore {
  const s = createStore(null);
  s.update((x) => ({ ...x, ...patch }));
  return s;
}
const appCtx = (s: PlayerStore): AppContext => ({ store: s, now: () => NOW, navigate: () => undefined });
const row = (patch: Partial<ListItem> = {}): ListItem => ({ key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [PARIPPU], ticked: false, ...patch });
const ONION_RULE: Rule = { id: 'r-onion', target: { kind: 'ingredient', ids: ['onion'] }, type: 'avoid', severity: 'allergy' };

async function mountList(s: PlayerStore): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.append(el);
  await marketScreen(noClient).mount(el, { name: 'market' }, appCtx(s));
  await flush();
  return el;
}

describe('amounts (Ruling 12)', () => {
  test('market rows show amounts; a fuzzy amount shows as written; no amounts → nothing (never "0")', async () => {
    expect(amountText(row({ amounts: [{ quantity: 100, unit: 'g', text: '100 g' }] }))).toBe('100 g');
    expect(amountText(row({ amounts: [{ quantity: 2, unit: 'tbsp', text: '2 tbsp' }, { quantity: 1, unit: 'cup', text: '1 cup' }] }))).toBe('2 tbsp + 1 cup');
    expect(amountText(row({ amounts: [{ quantity: null, unit: 'a handful', text: 'a handful' }] }))).toBe('a handful');
    expect(amountText(row())).toBeNull();
    expect(amountText(row({ amounts: [] }))).toBeNull();
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(0, PARIPPU)]));
    const el = await mountList(s);
    // Parippu serves 3 with 100 g of split moong dal: 3 servings planned → 100 g.
    expect(el.querySelector('.market-row[data-key="moong_dal"] .market-amount')?.textContent).toBe('100 g');
    for (const a of el.querySelectorAll('.market-amount')) expect(a.textContent).not.toMatch(/^0(\s|$)/);
    el.remove();
  });
});

describe('stall swaps (Ruling 11)', () => {
  test('Out of stock? offers only core stockSwaps; take → a ticked "stall swap" row and a dated pantry item; undo restores', async () => {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    const el = await mountList(s);
    const run = w.run(MON, TODAY)!;
    const shallot = run.items.find((i) => i.key === 'shallot')!;
    const offered = stockSwaps(shallot, w.plan(MON)!, planContextFor(MON, [])).map((x) => x.toId);
    expect(offered).toEqual(['onion']);
    const li = () => el.querySelector<HTMLElement>('.market-row[data-key="shallot"]')!;
    li().querySelector<HTMLButtonElement>('.stock-ask')!.click();
    const chips = [...li().querySelectorAll<HTMLButtonElement>('.stock-swap')];
    expect(chips.map((c) => c.dataset.to)).toEqual(offered);
    expect(chips[0].textContent).toContain('for Parippu Curry');
    expect(li().textContent).toContain('Skip it this week');
    chips[0].click();
    await flush();
    const after = s.get().localWeek.runs[0];
    expect(after.items.find((i) => i.key === 'shallot')).toMatchObject({ outOfStock: true, ticked: false });
    expect(after.items.find((i) => i.key === 'stock:onion')).toMatchObject({ ticked: true, stockSwap: { from: 'shallot' }, forDishes: [PARIPPU] });
    expect(s.get().localPantry).toContainEqual(expect.objectContaining({ name: 'onion', ingredientId: 'onion', addedOn: TODAY, source: 'market' }));
    expect(el.querySelector('.market-row[data-key="stock:onion"] .market-for')?.textContent).toBe('stall swap for Parippu Curry');
    expect(li().querySelector<HTMLInputElement>('.market-tick')!.disabled).toBe(true);
    expect(el.textContent).toContain(writtenLine('market.stock_swapped', { item: 'shallots', swap: 'onion', dish: 'Parippu Curry' }));
    li().querySelector<HTMLButtonElement>('.stock-undo')!.click();
    await flush();
    const undone = s.get().localWeek.runs[0];
    expect(undone.items.find((i) => i.key === 'stock:onion')).toBeUndefined();
    expect(undone.items.find((i) => i.key === 'shallot')).not.toHaveProperty('outOfStock');
    expect(s.get().localPantry.some((p) => p.ingredientId === 'onion')).toBe(false);
    el.remove();
  });

  test('a take the rules now refuse is never written (the device re-derives the offer); "Skip it this week" marks it out', () => {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    w.run(MON, TODAY);
    s.update((x) => ({ ...x, localRules: [ONION_RULE] }));
    expect(w.stock(MON, { key: 'shallot', action: 'take', toId: 'onion' }, TODAY)).toEqual({ ok: false, reason: 'invalid' });
    expect(s.get().localPantry).toEqual([]);
    const out = w.stock(MON, { key: 'shallot', action: 'out' }, TODAY);
    expect(out.ok && out.run.items.find((i) => i.key === 'shallot')?.outOfStock).toBe(true);
    // Out of stock is never ticked; the mark survives a recompute.
    expect(w.tick(MON, 'shallot', true, TODAY)).toBeNull();
    expect(w.run(MON, TODAY)!.items.find((i) => i.key === 'shallot')?.outOfStock).toBe(true);
  });

  test('Family Table: amounts shown, no stock control, nothing written', async () => {
    const s = store();
    createWeekStore({ store: s }).savePlan(plan([dish(0, PARIPPU)]));
    s.update((x) => ({ ...x, settings: { ...x.settings, familyTable: true } }));
    let writes = 0;
    s.subscribe(() => { writes++; });
    const el = await mountList(s);
    expect(el.querySelector('.market-amount')).not.toBeNull();
    expect(el.querySelector('.stock-control, .stock-ask, input')).toBeNull();
    expect(writes).toBe(0);
    el.remove();
  });

  test('cook mode for a dish with a stall swap shows the label and the checkWithStockSwaps status; a new rule → ⛔ and Cook disabled', () => {
    const s = store();
    const w = createWeekStore({ store: s });
    w.savePlan(plan([dish(0, PARIPPU)]));
    w.run(MON, TODAY);
    expect(w.stock(MON, { key: 'shallot', action: 'take', toId: 'onion' }, TODAY).ok).toBe(true);
    const swaps = stockSwapsNow(s.get(), PARIPPU, TODAY);
    expect(swaps).toEqual([{ from: 'shallots', to: 'onion' }]);
    // Onigiri isn't the swap's dish: no label.
    expect(stockSwapsNow(s.get(), ONIGIRI, TODAY)).toEqual([]);
    const card = (rules: Rule[]) => buildRecipeCard({
      slug: PARIPPU, content, graph, rules: activeRules({ ...s.get(), localRules: rules }, graph), today: TODAY, showCalories: false, stockSwaps: swaps,
    });
    const ok = card([]);
    expect(ok.stockSwapLabels).toEqual(['swapped at the market: onion for shallots']);
    expect(ok.cookable).toBe(true);
    const blocked = card([ONION_RULE]);
    expect(blocked.status).toBe('blocked');
    expect(blocked.cookable).toBe(false);
  });
});

describe('Fix round 1 (I2): loadKnownRun gives up on a stalled read', () => {
  test('currentRun hung → null by the 3 s limit; nothing remembered', async () => {
    const { loadKnownRun } = await import('./market-swaps');
    const { rememberedRun } = await import('./run-memory');
    const { LOOKUP_TIMEOUT_MS } = await import('../shell/within');
    const { vi } = await import('vitest');
    const s = store({ account: { email: 'slow@example.com' }, accountRules: [] });
    vi.useFakeTimers();
    try {
      const got = loadKnownRun(s.get(), { currentRun: () => new Promise(() => {}) }, TODAY);
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      expect(await got).toBeNull();
      expect(rememberedRun('slow@example.com')).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
