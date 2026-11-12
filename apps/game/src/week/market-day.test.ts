// @vitest-environment happy-dom
// M6 Step 10: market day on Form 12-M: amounts, stall swaps (core stockSwaps only), the Season's Table (core seasonNote /
// dishSeasonNote only, ✅ items only, following data/seasonality.yaml), and the plan view's note (text only).
import { describe, expect, test } from 'vitest';
import { stockSwaps, type ListItem, type ParsedRecipe, type Plan, type Rule } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { loadMarket } from '../market/content';
import { marketCtxFor } from '../market/stall-context';
import { buildRecipeCard } from '../recipes/card-model';
import { activeRules } from '../recipes/rules';
import type { AppContext } from '../shell/app';
import { createStore, type PlayerState, type PlayerStore } from '../state/store';
import { canonRecipes, planContextFor } from './context';
import { createWeekStore } from './local-week';
import { amountText, marketScreen } from './market-screen';
import { stockSwapsNow } from './market-swaps';
import { renderPlanView, writtenLine } from './plan-view';
import { dishSeasonNote, seasonNoteFor } from './season-note';
import { stockControl } from './stock-view';

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

  test('no stock control on a ⛔ (never listed), ❓, ticked, rules-swapped or stall-swap row, or in Family Table', () => {
    const deps = { swaps: [], act: () => Promise.resolve({ ok: true }), familyTable: false };
    expect(stockControl(row(), deps)).not.toBeNull();
    expect(stockControl(row({ unverified: true }), deps)).toBeNull();
    expect(stockControl(row({ ticked: true }), deps)).toBeNull();
    expect(stockControl(row({ swappedFor: [PARIPPU] }), deps)).toBeNull();
    expect(stockControl(row({ key: 'stock:onion', stockSwap: { from: 'shallot' } }), deps)).toBeNull();
    expect(stockControl(row(), { ...deps, familyTable: true })).toBeNull();
    // With no swap: the Pan's market.no_swap (no keeper line given) and "Skip it this week" only.
    const box = stockControl(row(), deps)!;
    box.querySelector<HTMLButtonElement>('.stock-ask')!.click();
    expect(box.textContent).toContain(writtenLine('market.no_swap', { item: 'shallots' }));
    expect(box.querySelectorAll('.stock-swap')).toHaveLength(0);
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

describe("The Season's Table (Ruling 10; data/seasonality.yaml)", () => {
  const SEATTLE = { country: 'USA', region: 'Seattle' };
  const ctx = (date: string, rules: Rule[] = [], profile: { country: string | null; region: string | null } = SEATTLE) => marketCtxFor(rules, profile, date, graph, [...content.substitutions])!;

  test('pnw-usa November: cranberry is "in season where you are"; winter squash is stored (its own label); December kale is in season', async () => {
    const table = (await loadMarket()).seasonality;
    const season = { regionId: 'pnw-usa', table };
    const nov = ctx('2026-11-11');
    expect(seasonNoteFor(row({ key: 'cranberry', name: 'cranberries', ingredientId: 'cranberry' }), season, nov)).toBe(writtenLine('season.now', { item: 'cranberries' }));
    expect(writtenLine('season.now', { item: 'x' })).toMatch(/in season where you are/);
    const squash = seasonNoteFor(row({ key: 'winter_squash', name: 'winter squash', ingredientId: 'winter_squash' }), season, nov);
    expect(squash).toBe(writtenLine('season.other', { item: 'winter squash', category: 'Local, stored from the autumn harvest' }));
    expect(squash).not.toMatch(/in season where you are/);
    expect(seasonNoteFor(row({ key: 'kale', name: 'kale', ingredientId: 'kale' }), season, ctx('2026-12-02'))).toBe(writtenLine('season.now', { item: 'kale' }));
  });

  test('no region → no notes; never on a ❓ or out-of-stock row; never for an item the rules hit; never a countdown', async () => {
    const table = (await loadMarket()).seasonality;
    const cran = row({ key: 'cranberry', name: 'cranberries', ingredientId: 'cranberry' });
    expect(seasonNoteFor(cran, { regionId: null, table }, ctx('2026-11-11', [], { country: null, region: null }))).toBeNull();
    const season = { regionId: 'pnw-usa', table };
    expect(seasonNoteFor({ ...cran, unverified: true }, season, ctx('2026-11-11'))).toBeNull();
    expect(seasonNoteFor({ ...cran, outOfStock: true }, season, ctx('2026-11-11'))).toBeNull();
    const noCran: Rule = { id: 'r-c', target: { kind: 'ingredient', ids: ['cranberry'] }, type: 'avoid', severity: 'preference' };
    expect(seasonNoteFor(cran, season, ctx('2026-11-11', [noCran]))).toBeNull();
    for (const l of [...content.pan.triggers['season.now'].lines, ...content.pan.triggers['season.other'].lines]) {
      expect(l).not.toMatch(/\d+ (days?|weeks?) left|hurry|last chance|running out|ends soon/i);
    }
  });

  test('plan view season note is text only; plan order and the rows are unchanged with it', async () => {
    const table = (await loadMarket()).seasonality;
    const base = canonRecipes().get(PARIPPU)!;
    const withKale: ParsedRecipe = { ...base, ingredients: [...base.ingredients, { ...base.ingredients[0], name: 'kale', quantity: 1, unit: null }] };
    const note = dishSeasonNote(withKale, { regionId: 'pnw-usa', table }, ctx('2026-12-02'));
    expect(note).toBe(writtenLine('season.now', { item: 'kale' }));
    expect(dishSeasonNote(withKale, { regionId: null, table }, ctx('2026-12-02'))).toBeNull();
    const p = plan([dish(2, ONIGIRI), dish(0, PARIPPU), dish(2, PARIPPU)]);
    const rows = p.items.map((item) => ({ item, status: 'ok' as const, findings: [] }));
    const plain = renderPlanView({ weekStart: MON, rows, line: writtenLine });
    const noted = renderPlanView({ weekStart: MON, rows, line: writtenLine, seasonNote: (i) => (i.slug === PARIPPU ? note : null) });
    const order = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.plan-item')].map((x) => `${x.closest('.plan-day')!.getAttribute('data-day')}:${x.dataset.slug}:${x.dataset.status}`);
    expect(order(noted)).toEqual(order(plain));
    const notes = [...noted.querySelectorAll('.season-note')];
    expect(notes).toHaveLength(2);
    for (const n of notes) {
      expect(n.tagName).toBe('P');
      expect(n.querySelector('.chip, [data-status]')).toBeNull();
      expect(n.getAttribute('class')).toBe('season-note');
    }
    // A ⛔ or ❓ dish never gets one.
    const bad = renderPlanView({ weekStart: MON, rows: rows.map((r, i) => ({ ...r, status: i === 1 ? 'blocked' as const : 'unverified' as const })), line: writtenLine, seasonNote: () => note });
    expect(bad.querySelectorAll('.season-note')).toHaveLength(0);
  });
});
