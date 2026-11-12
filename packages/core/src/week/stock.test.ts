import { describe, expect, test } from 'vitest';
import { applyNotes } from '../book/margin-notes';
import type { Substitution } from '../rules/check';
import { ALLIUM, avoid, canon, dish, graph, MONDAY, PEANUT, planCtx, PORK, STALLS, subs } from './fixtures';
import { marketList, type ListItem, type MarketRunView } from './market-list';
import type { Plan, PlanContext, PlanItem } from './plan';
import { checkWithStockSwaps, markOutOfStock, MAX_STOCK_SWAPS_PER_RUN, stockSwaps, stockSwapsFor, takeStockSwap, undoStock, type StockSwap } from './stock';

const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const ONION: Substitution = { from: 'shallot', to: 'onion', note: 'Half an onion for three shallots.' };
const SUBS: Substitution[] = [...subs, ONION];
const plan = (items: PlanItem[]): Plan => ({ weekStart: MONDAY, items, hard: false, slot: 'unanswered' });
const dishOn = (day: number, slug: string): PlanItem => ({ day, kind: 'dish', slug, servings: 3 });
const ctxWith = (over: Partial<PlanContext> = {}) => planCtx({ subs: SUBS, ...over });
const rowOf = (list: ListItem[], id: string): ListItem => {
  const row = list.find((i) => i.ingredientId === id);
  if (!row) throw new Error(`no ${id} row`);
  return row;
};
const PARIPPU_WEEK = plan([dishOn(0, PARIPPU)]);
const shallotRow = () => rowOf(marketList(PARIPPU_WEEK, ctxWith(), [], STALLS), 'shallot');
const runOf = (items: ListItem[]): MarketRunView => ({ id: 'run-1', weekStart: MONDAY, items, doneAt: null });

/** A small test dish with no label-dependent line, so a non-allium rule leaves it ✅. */
const SIMPLE = 'test/shallot-salt';
const simpleCtx = (over: Partial<PlanContext> = {}) => ctxWith({ recipes: new Map([...canon, [SIMPLE, dish('leela', ['shallot', 'salt'])]]), ...over });
const SIMPLE_WEEK = plan([dishOn(0, SIMPLE)]);

describe('stockSwaps (Ruling 11)', () => {
  test('stockSwaps: shallot → onion offered for parippu with no rules; with an allium rule → none', () => {
    const row = shallotRow();
    expect(stockSwaps(row, PARIPPU_WEEK, ctxWith())).toEqual([{ toId: 'onion', toName: 'onion', note: ONION.note, dishes: [PARIPPU] }]);
    expect(stockSwaps(row, PARIPPU_WEEK, ctxWith({ rules: [ALLIUM] }))).toEqual([]);
    // A rule on onion alone: the shallot dish is fine, but the swap isn't.
    expect(stockSwaps(row, PARIPPU_WEEK, ctxWith({ rules: [avoid('onion')] }))).toEqual([]);
    // Only from the curated table: none without the entry. The row's own id only, never an isA ancestor's swap.
    expect(stockSwaps(row, PARIPPU_WEEK, ctxWith({ subs }))).toEqual([]);
    expect(stockSwaps(row, PARIPPU_WEEK, ctxWith({ subs: [{ from: 'allium', to: 'salt' }] }))).toEqual([]);
    // A rule active on any day the dish is planned: parippu twice, an onion rule from the second day.
    const twice = plan([dishOn(0, PARIPPU), dishOn(3, PARIPPU)]);
    const phased = ctxWith({ rules: [avoid('onion', { phase: { start: '2026-11-11' } })] });
    expect(stockSwaps(rowOf(marketList(twice, ctxWith(), [], STALLS), 'shallot'), twice, phased)).toEqual([]);
    expect(stockSwaps(rowOf(marketList(twice, ctxWith(), [], STALLS), 'shallot'), plan([dishOn(0, PARIPPU)]), phased)).toHaveLength(1);
  });

  test("a swap's unsafeFor touching an active rule target is never offered", () => {
    const row = rowOf(marketList(SIMPLE_WEEK, simpleCtx(), [], STALLS), 'shallot');
    const toParsley: Substitution = { from: 'shallot', to: 'parsley', unsafeFor: ['peanut'] };
    expect(stockSwaps(row, SIMPLE_WEEK, simpleCtx({ subs: [toParsley] }))).toHaveLength(1);
    expect(stockSwaps(row, SIMPLE_WEEK, simpleCtx({ subs: [toParsley], rules: [PEANUT] }))).toEqual([]);
    expect(stockSwaps(row, SIMPLE_WEEK, simpleCtx({ subs: [{ ...toParsley, unsafeFor: [] }], rules: [PEANUT] }))).toHaveLength(1);
  });

  test('a swap whose result is ❓ for any dish it serves is not offered', () => {
    // Tamari is label-dependent: ❓ under any rule. Onion stays ✅ under a peanut rule.
    const tamari: Substitution = { from: 'shallot', to: 'tamari' };
    const ctx = simpleCtx({ subs: [tamari, ONION], rules: [PEANUT] });
    const row = rowOf(marketList(SIMPLE_WEEK, ctx, [], STALLS), 'shallot');
    expect(stockSwaps(row, SIMPLE_WEEK, ctx).map((s) => s.toId)).toEqual(['onion']);
    // Parippu holds pappadam (label-dependent): under any rule the dish is ❓, so it is offered nothing.
    const ppCtx = ctxWith({ rules: [PEANUT] });
    expect(stockSwaps(rowOf(marketList(PARIPPU_WEEK, ppCtx, [], STALLS), 'shallot'), PARIPPU_WEEK, ppCtx)).toEqual([]);
    // A row serving two dishes needs both: one dish missing from the canon, or sacred, means nothing is offered.
    const both = plan([dishOn(0, PARIPPU), dishOn(1, SIMPLE)]);
    const shared = rowOf(marketList(both, simpleCtx(), [], STALLS), 'shallot');
    expect(shared.forDishes).toEqual([PARIPPU, SIMPLE]);
    expect(stockSwaps(shared, both, simpleCtx())).toEqual([{ toId: 'onion', toName: 'onion', note: ONION.note, dishes: [PARIPPU, SIMPLE] }]);
    expect(stockSwaps(shared, both, ctxWith())).toEqual([]);
    expect(stockSwaps(shared, plan([dishOn(0, PARIPPU)]), simpleCtx())).toEqual([]);
  });

  test('a rules-engine-swapped row and a ❓ row offer no stock swap', () => {
    const ctx = ctxWith({ rules: [PORK], subs: [...SUBS, { from: 'neutral_oil', to: 'ghee' }, { from: 'corn_tortilla', to: 'rice' }] });
    const week = plan([dishOn(0, FRIJOLES)]);
    const list = marketList(week, ctx, [], STALLS);
    const oil = rowOf(list, 'neutral_oil');
    expect(oil.swappedFor).toEqual([FRIJOLES]);
    expect(stockSwaps(oil, week, ctx)).toEqual([]);
    const tortilla = rowOf(list, 'corn_tortilla');
    expect(tortilla.unverified).toBe(true);
    expect(stockSwaps(tortilla, week, ctx)).toEqual([]);
    // An unresolved row (no ingredient id) and a stall swap's own row offer none either.
    expect(stockSwaps({ ...shallotRow(), ingredientId: null }, PARIPPU_WEEK, ctxWith())).toEqual([]);
    expect(stockSwaps({ ...shallotRow(), stockSwap: { from: 'x' } }, PARIPPU_WEEK, ctxWith())).toEqual([]);
  });
});

describe('taking and undoing a stall swap', () => {
  const swap = (): StockSwap => stockSwaps(shallotRow(), PARIPPU_WEEK, ctxWith())[0];

  test('take → row outOfStock, a ticked stock: row labelled with its dishes; undo → both restored exactly', () => {
    const run = runOf(marketList(PARIPPU_WEEK, ctxWith(), [], STALLS));
    const { run: taken, added } = takeStockSwap(run, 'shallot', swap());
    expect(added).toEqual({ key: 'stock:onion', name: 'onion', ingredientId: 'onion', stall: 'wen', forDishes: [PARIPPU], stockSwap: { from: 'shallot' }, ticked: true });
    const at = taken.items.findIndex((i) => i.key === 'shallot');
    expect(taken.items[at]).toEqual({ ...run.items.find((i) => i.key === 'shallot'), outOfStock: true, ticked: false });
    expect(taken.items[at + 1]).toEqual(added);
    expect(taken.items).toHaveLength(run.items.length + 1);
    // The other rows are untouched, and the input run is not changed in place.
    expect(taken.items.filter((i) => i.key !== 'shallot' && i.key !== 'stock:onion')).toEqual(run.items.filter((i) => i.key !== 'shallot'));
    expect(run.items.some((i) => i.outOfStock)).toBe(false);
    // Undo by either key restores the run exactly.
    for (const key of ['shallot', 'stock:onion']) {
      const undone = undoStock(taken, key);
      expect(undone.removedKey).toBe('stock:onion');
      expect(undone.run).toEqual(run);
    }
    // Marked out with no swap (the keeper had none): undo clears the mark.
    const marked = markOutOfStock(run, 'shallot');
    expect(marked.items.find((i) => i.key === 'shallot')).toMatchObject({ outOfStock: true, ticked: false });
    expect(undoStock(marked, 'shallot')).toEqual({ run, removedKey: null });
    expect(markOutOfStock(marked, 'shallot')).toEqual(marked);
    expect(undoStock(run, 'shallot')).toEqual({ run, removedKey: null });
    // A ticked row marked out of stock is unticked.
    const ticked = runOf(run.items.map((i) => (i.key === 'shallot' ? { ...i, ticked: true } : i)));
    expect(markOutOfStock(ticked, 'shallot').items.find((i) => i.key === 'shallot')?.ticked).toBe(false);
  });

  test('what a run can not take: a missing row, a swap row, a second swap, the same substitute twice, the run cap', () => {
    const run = runOf(marketList(PARIPPU_WEEK, ctxWith(), [], STALLS));
    expect(() => takeStockSwap(run, 'nope', swap())).toThrow(RangeError);
    expect(() => markOutOfStock(run, 'nope')).toThrow(RangeError);
    expect(() => undoStock(run, 'nope')).toThrow(RangeError);
    const { run: taken } = takeStockSwap(run, 'shallot', swap());
    expect(() => takeStockSwap(taken, 'shallot', swap())).toThrow(RangeError);
    expect(() => takeStockSwap(taken, 'stock:onion', swap())).toThrow(RangeError);
    expect(() => markOutOfStock(taken, 'stock:onion')).toThrow(RangeError);
    expect(() => takeStockSwap(taken, 'salt', swap())).toThrow(RangeError); // onion is already on as a swap
    expect(() => takeStockSwap(run, 'shallot', { ...swap(), toId: 'shallot' })).toThrow(RangeError);
    // The cap: MAX_STOCK_SWAPS_PER_RUN swap rows, then no more.
    const full = runOf([
      ...run.items,
      ...Array.from({ length: MAX_STOCK_SWAPS_PER_RUN }, (_, k): ListItem => ({ key: `stock:x${k}`, name: `x${k}`, ingredientId: `x${k}`, stall: 'general', forDishes: [PARIPPU], stockSwap: { from: `gone${k}` }, ticked: true })),
    ]);
    expect(() => takeStockSwap(full, 'shallot', swap())).toThrow(RangeError);
    expect(() => takeStockSwap(runOf(full.items.slice(0, -1)), 'shallot', swap())).not.toThrow();
  });

  test('stockSwapsFor + checkWithStockSwaps: cook mode sees the swap; a rule added afterwards makes it ⛔, never ✅', () => {
    const run = runOf(marketList(PARIPPU_WEEK, ctxWith(), [], STALLS));
    const { run: taken } = takeStockSwap(run, 'shallot', swap());
    const swaps = stockSwapsFor(taken, PARIPPU);
    expect(swaps).toEqual([{ from: 'shallots', to: 'onion' }]);
    expect(stockSwapsFor(taken, FRIJOLES)).toEqual([]);
    expect(stockSwapsFor(null, PARIPPU)).toEqual([]);
    expect(stockSwapsFor(run, PARIPPU)).toEqual([]);
    const recipe = canon.get(PARIPPU)!;
    const day = MONDAY;
    const now = checkWithStockSwaps(recipe, swaps, [], graph, SUBS, day);
    expect(now.status).toBe('ok');
    // The swap renames the line, keeping its amount (the margin-note op), so cook mode shows onion, not shallots.
    const applied = applyNotes(recipe, [{ recipe: PARIPPU, ops: [{ op: 'swap', from: 'shallots', to: 'onion' }], text: null, at: day }]);
    expect(applied.ingredients.map((x) => x.name)).toContain('onion');
    expect(applied.ingredients.map((x) => x.name)).not.toContain('shallots');
    // A rule added after the market: an onion rule, or an allium rule, makes the dish ⛔ with the swap, never ✅.
    for (const rule of [avoid('onion'), ALLIUM]) expect(checkWithStockSwaps(recipe, swaps, [rule], graph, SUBS, day).status).toBe('blocked');
    // A swap whose `from` the recipe doesn't hold still has its `to` checked.
    expect(checkWithStockSwaps(canon.get(FRIJOLES)!, [{ from: 'shallots', to: 'peanut' }], [PEANUT], graph, SUBS, day).status).toBe('blocked');
    // No swaps: the same as the plain check.
    expect(checkWithStockSwaps(recipe, [], [], graph, SUBS, day).status).toBe('ok');
  });
});
