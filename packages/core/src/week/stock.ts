// Stall swaps (M6 Ruling 11, spec §3.2): the stall is out of something on the list, so the keeper offers a labelled
// substitute from the curated `data/substitutions.json` (never the model), re-checked by the rules engine for every
// dish it serves. Taking one marks the row out of stock and adds a ticked row for the swap; undo restores both. Cook
// mode then checks the dish with the swap applied. Pure and browser-safe: no I/O, no recipe parser.
import { checkWithNotes, type NoteOp } from '../book/margin-notes';
import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { ParsedRecipe } from '../recipe/types';
import { isActive } from '../rules/active';
import type { CheckResult, Substitution } from '../rules/check';
import type { Rule } from '../rules/types';
import type { ListItem, MarketRunView } from './market-list';
import { itemDate, type Plan, type PlanContext } from './plan';

/** A swap a stall keeper may offer for one list row: the curated substitute, its note, and the dishes it serves. */
export interface StockSwap {
  toId: string;
  toName: string;
  /** The curated note ("Same amount of sunflower or canola oil."); '' when the table has none. */
  note: string;
  /** The row's dishes (plan order), every one of which checks ✅ or 🔁 with the swap. */
  dishes: string[];
}

/** Stall swaps one market run may hold, at most (`takeStockSwap` refuses more). */
export const MAX_STOCK_SWAPS_PER_RUN = 21;

/** The prefix of a stall swap's added row key: never the same key as a plan row for that ingredient (C11). */
const STOCK = 'stock:';

const passes = (r: CheckResult): boolean => r.status === 'ok' || r.status === 'swap';

/**
 * Cook mode (and the offer itself): the rules engine's check of `recipe` with the run's stall swaps applied, as
 * margin-note swap ops (`checkWithNotes`, which also counts every ingredient the swaps name). Each swap renames every
 * line that is the `from` ingredient (by graph id, or by name when unresolved) to `to`; a swap whose `from` the recipe
 * doesn't hold adds `to`, so what the player bought is always checked. The rules are the player's rules NOW: a rule
 * added after the market makes the dish ⛔ or ❓, never ✅.
 */
export function checkWithStockSwaps(
  recipe: ParsedRecipe,
  swaps: readonly { from: string; to: string }[],
  rules: Rule[],
  graph: IngredientGraph,
  subs: Substitution[],
  date: string,
): CheckResult {
  const ops: NoteOp[] = [];
  for (const sw of swaps) {
    const fromId = graph.resolve(sw.from);
    const names = new Set(
      recipe.ingredients
        .filter((l) => (fromId !== null ? graph.resolve(l.name) === fromId : normalizeName(l.name) === normalizeName(sw.from)))
        .map((l) => l.name),
    );
    if (names.size === 0) ops.push({ op: 'swap', from: sw.from, to: sw.to });
    for (const name of names) ops.push({ op: 'swap', from: name, to: sw.to });
  }
  return checkWithNotes(recipe, [{ recipe: '', ops, text: null, at: date }], rules, graph, subs, date);
}

/**
 * Ruling 11: candidates from `subs` whose `from` resolves to the row's ingredient (own id, not isA ancestors: a swap
 * is for a concrete item) and whose `unsafeFor` doesn't touch any rule target active on a date the row's dishes are
 * planned for; each kept only when, for every slug in row.forDishes and every date that dish is planned on,
 * `checkWithStockSwaps` (checkWithNotes with the swap as a note op) is ✅ or 🔁, and the swapped-in item itself has no
 * finding (it is not hit, swapped again or ❓). Offers none for a rules-engine-swapped row (swappedFor), a ❓ row
 * (unverified), a stall swap's own row, a row with no ingredient id, or a row with any dish the plan or canon doesn't
 * hold, or that is sacred: what can't be checked is never offered. In `subs` order, each substitute once.
 */
export function stockSwaps(row: ListItem, plan: Plan, ctx: PlanContext): StockSwap[] {
  const id = row.ingredientId;
  if (id === null || row.swappedFor !== undefined || row.unverified === true || row.stockSwap !== undefined || row.forDishes.length === 0) return [];
  if (!ctx.graph.has(id)) return [];
  const dishes: { recipe: ParsedRecipe; dates: string[] }[] = [];
  for (const slug of row.forDishes) {
    const recipe = ctx.recipes.get(slug);
    const dates = plan.items.filter((i) => i.kind === 'dish' && i.slug === slug).map((i) => itemDate(plan, i));
    if (recipe === undefined || recipe.meta.sacred || dates.length === 0) return [];
    dishes.push({ recipe, dates });
  }
  const allDates = dishes.flatMap((d) => d.dates);
  const targets = new Set(ctx.rules.filter((r) => allDates.some((d) => isActive(r, d))).flatMap((r) => r.target.ids));
  const out: StockSwap[] = [];
  for (const sub of ctx.subs) {
    // A `to` the graph lacks is not skipped: graph.get throws, as check() does on such a table (fail loudly).
    if ((sub.from !== id && ctx.graph.resolve(sub.from) !== id) || sub.to === id) continue;
    if (out.some((s) => s.toId === sub.to)) continue;
    if ((sub.unsafeFor ?? []).some((t) => targets.has(t))) continue;
    const toName = ctx.graph.get(sub.to).name;
    const fits = dishes.every(({ recipe, dates }) =>
      dates.every((date) => {
        const r = checkWithStockSwaps(recipe, [{ from: row.name, to: toName }], ctx.rules, ctx.graph, ctx.subs, date);
        return passes(r) && !r.findings.some((f) => f.ingredientId === sub.to);
      }),
    );
    if (fits) out.push({ toId: sub.to, toName, note: sub.note ?? '', dishes: [...row.forDishes] });
  }
  return out;
}

function rowAt(run: MarketRunView, key: string): ListItem {
  const row = run.items.find((i) => i.key === key);
  if (row === undefined) throw new RangeError(`no row "${key}" on this market run`);
  return row;
}

/**
 * The stall was out of a row's item: the row is marked `outOfStock` and unticked. Throws RangeError (the API's
 * `stock_invalid`) for a key the run doesn't hold or a stall swap's own row (undo that instead). Marking a row that
 * is already out of stock changes nothing.
 */
export function markOutOfStock(run: MarketRunView, key: string): MarketRunView {
  const row = rowAt(run, key);
  if (row.stockSwap !== undefined) throw new RangeError(`row "${key}" is a stall swap: undo it instead`);
  return { ...run, items: run.items.map((i) => (i.key === key ? { ...i, outOfStock: true, ticked: false } : i)) };
}

/**
 * Take a stall swap for a row: the row is marked out of stock (unticked), and a ticked row for the swap is added right
 * after it, keyed `stock:<toId>`, at the stall of the keeper who offered it, for the row's dishes, with `stockSwap.from`
 * naming the row. The swap must be one `stockSwaps` offers now: the caller checks that (this function has no plan or
 * rules). Throws RangeError for a key the run doesn't hold, a stall swap's own row, a row that already has a swap, a
 * substitute already on the run as a swap, the substitute being the row's own item, or a run at MAX_STOCK_SWAPS_PER_RUN.
 */
export function takeStockSwap(run: MarketRunView, key: string, swap: StockSwap): { run: MarketRunView; added: ListItem } {
  const row = rowAt(run, key);
  if (row.stockSwap !== undefined) throw new RangeError(`row "${key}" is a stall swap`);
  if (swap.toId === row.ingredientId) throw new RangeError(`a swap for "${key}" can't be the same item`);
  if (run.items.some((i) => i.stockSwap?.from === key)) throw new RangeError(`row "${key}" already has a stall swap`);
  const addedKey = `${STOCK}${swap.toId}`;
  if (run.items.some((i) => i.key === addedKey)) throw new RangeError(`"${swap.toId}" is already on this run as a stall swap`);
  if (run.items.filter((i) => i.stockSwap !== undefined).length >= MAX_STOCK_SWAPS_PER_RUN) throw new RangeError('this run holds the most stall swaps it may');
  const added: ListItem = {
    key: addedKey,
    name: swap.toName,
    ingredientId: swap.toId,
    stall: row.stall,
    forDishes: [...row.forDishes],
    stockSwap: { from: row.key },
    ticked: true,
  };
  const items = run.items.flatMap((i) => (i.key === key ? [{ ...i, outOfStock: true as const, ticked: false }, added] : [i]));
  return { run: { ...run, items }, added };
}

/**
 * Undo a row's out-of-stock mark and its stall swap, if any. `key` is the row's key or its swap row's. The row's
 * `outOfStock` is cleared (it stays unticked) and the swap's row is removed; `removedKey` names it, or null when the
 * row had no swap. Undoing a row that is neither out of stock nor swapped changes nothing. Throws RangeError for a
 * key the run doesn't hold.
 */
export function undoStock(run: MarketRunView, key: string): { run: MarketRunView; removedKey: string | null } {
  const at = rowAt(run, key);
  const from = at.stockSwap !== undefined ? at.stockSwap.from : key;
  const swapRow = at.stockSwap !== undefined ? at : run.items.find((i) => i.stockSwap?.from === from);
  const items = run.items
    .filter((i) => i !== swapRow)
    .map((i) => {
      if (i.key !== from || i.outOfStock === undefined) return i;
      const { outOfStock: _gone, ...rest } = i;
      return rest;
    });
  return { run: { ...run, items }, removedKey: swapRow?.key ?? null };
}

/**
 * For cook mode: the stall swaps a run made for one dish, as margin-note swap ops (`from` the row's name, `to` the
 * swap's), for `checkWithStockSwaps` and the "swapped at the market: Y for X" label. That plan week's run only; null
 * (no run) gives none. A swap row whose original row is gone gives none.
 */
export function stockSwapsFor(run: MarketRunView | null, slug: string): { from: string; to: string }[] {
  if (run === null) return [];
  const out: { from: string; to: string }[] = [];
  for (const row of run.items) {
    if (row.stockSwap === undefined || !row.forDishes.includes(slug)) continue;
    const from = run.items.find((i) => i.key === row.stockSwap?.from);
    if (from !== undefined) out.push({ from: from.name, to: row.name });
  }
  return out;
}
