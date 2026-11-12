// Form 12-M, the market list (spec §3.2, Ruling 16): the plan's ingredients minus the pantry, grouped by stall, with
// honest amounts (M6 Ruling 12, `amounts.ts`). A blocked ingredient is never something to buy: a ⛔ dish adds nothing,
// and a line with a rules-checked swap lists the swap.
import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { PantryItem } from '../mentor/cards';
import { pantryMatcher } from '../mentor/route';
import { check } from '../rules/check';
import { listAmounts, type Amount } from './amounts';
import { itemDate, type Plan, type PlanContext } from './plan';

/** The content/market stall ids plus 'general' (C11); there is no 'dairy' stall. */
export type StallId = 'wen' | 'bram' | 'okafor-sato' | 'spice' | 'general';
export const STALL_IDS: readonly StallId[] = Object.freeze(['wen', 'bram', 'okafor-sato', 'spice', 'general']);
/** data/stalls.json: ingredient or category id → stall (Step 4). */
export type StallMap = Readonly<Record<string, StallId>>;

export interface ListItem {
  /** Stable across recomputes (C20): the ingredient id, else `name:` + the normalised name. */
  key: string;
  name: string;
  ingredientId: string | null;
  stall: StallId;
  /** Plan dish slugs that need it, in plan order, each once. */
  forDishes: string[];
  /** Dish slugs for which this is the rules engine's swap: shown as "for {dish}, swapped". Absent when none. */
  swappedFor?: string[];
  /** The rules engine can't verify it (unresolved, or check the label): Step 10 badges it ❓. Absent otherwise. */
  unverified?: true;
  /**
   * M6 Ruling 12: the amounts to buy, scaled to the plan's servings, summed only within one unit family. Absent when no
   * line had a quantity (the row shows no amount, never "0") and on a row with a rules-engine swap (the swap's note
   * gives its amount, so no total would be honest).
   */
  amounts?: Amount[];
  /** M6 Ruling 11: the stall was out of it (`markOutOfStock`); never ticked while set. */
  outOfStock?: true;
  /** M6 Ruling 11: a stall swap's row (`takeStockSwap`), standing in for the row keyed `from`. */
  stockSwap?: { from: string };
  ticked: boolean;
}

/** C40: the one shape of a market run, for the API (Step 6) and the device (Step 10 local-week.ts). */
export interface MarketRunView {
  id: string;
  weekStart: string;
  items: ListItem[];
  doneAt: string | null;
}

/** Ingredients nobody buys at a market. */
const NEVER_LISTED: ReadonlySet<string> = new Set(['water']);

const isStall = (v: unknown): v is StallId => typeof v === 'string' && (STALL_IDS as readonly string[]).includes(v);

/**
 * The stall that sells an ingredient: its own `stallOf` entry, else the nearest `isA` ancestor's (breadth first),
 * else 'general'. An unresolved ingredient (null) is 'general'.
 */
export function stallFor(ingredientId: string | null, graph: IngredientGraph, stallOf: StallMap): StallId {
  if (ingredientId === null) return 'general';
  const own = Object.hasOwn(stallOf, ingredientId) ? stallOf[ingredientId] : undefined;
  if (isStall(own)) return own;
  if (!graph.has(ingredientId)) return 'general';
  const seen = new Set([ingredientId]);
  const queue = [...(graph.get(ingredientId).isA ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    const s = Object.hasOwn(stallOf, cur) ? stallOf[cur] : undefined;
    if (isStall(s)) return s;
    if (graph.has(cur)) queue.push(...(graph.get(cur).isA ?? []));
  }
  return 'general';
}

const keyOf = (ingredientId: string | null, name: string): string => ingredientId ?? `name:${normalizeName(name)}`;
const pushOnce = (list: string[], v: string): void => {
  if (!list.includes(v)) list.push(v);
};

/**
 * The market list for a plan's dish items (lessons add nothing). Each dish is checked on its own date: a ⛔ dish (or
 * one the canon doesn't hold) adds nothing, and shows in the plan with `plan.blocked_dish` instead (Step 10). A line
 * the rules hit but that has a rules-checked swap lists the swap, labelled with `swappedFor`, never the hit one.
 * What the pantry already has (`pantryMatcher`, by name or ingredient id) is left off. A sacred dish adds nothing
 * (spec §10: it is never planned, and a stored plan holding one still lists nothing for it). Each row's `amounts` are
 * its lines' quantities scaled by the item's servings ÷ the recipe's (`listAmounts`). Sorted by stall (STALL_IDS
 * order), then name. Every row starts unticked.
 */
export function marketList(plan: Plan, ctx: PlanContext, pantry: readonly PantryItem[], stallOf: StallMap): ListItem[] {
  const rows = new Map<string, ListItem>();
  const lines = new Map<string, { quantity: number | null; unit: string | null; servingsFactor: number }[]>();
  const inPantry = (name: string): boolean => {
    const has = pantryMatcher([name], [], ctx.graph);
    return pantry.some((p) => has({ id: '', name: p.name, ingredientId: p.ingredientId }));
  };
  for (const item of plan.items) {
    if (item.kind !== 'dish') continue;
    const r = ctx.recipes.get(item.slug);
    if (!r || r.meta.sacred) continue;
    const servingsFactor = item.servings / r.meta.servings;
    const result = check(r, ctx.rules, ctx.graph, ctx.subs, itemDate(plan, item));
    if (result.status === 'blocked') continue;
    for (const line of r.ingredients) {
      const hits = result.findings.filter((f) => f.ingredient === line.name && f.kind === 'match');
      const swap = hits.find((f) => f.swap)?.swap;
      // Never list a line the rules hit unless every hit carries the swap (defence in depth: the dish would be ⛔).
      if (hits.length > 0 && (swap === undefined || hits.some((f) => f.swap?.toId !== swap.toId))) continue;
      const name = swap ? swap.toName : line.name;
      const ingredientId = swap ? swap.toId : ctx.graph.resolve(line.name);
      if ((ingredientId !== null && NEVER_LISTED.has(ingredientId)) || inPantry(name)) continue;
      const key = keyOf(ingredientId, name);
      const row = rows.get(key) ?? {
        key,
        name,
        ingredientId,
        stall: stallFor(ingredientId, ctx.graph, stallOf),
        forDishes: [],
        ticked: false,
      };
      pushOnce(row.forDishes, item.slug);
      if (swap) pushOnce((row.swappedFor ??= []), item.slug);
      // A listed swap is itself rules-checked; any other line with a ❓ finding is marked.
      const unsure = result.findings.some((f) => f.ingredient === line.name && (f.kind === 'label' || f.kind === 'unresolved'));
      if (!swap && unsure) row.unverified = true;
      lines.set(key, [...(lines.get(key) ?? []), { quantity: line.quantity, unit: line.unit, servingsFactor }]);
      rows.set(key, row);
    }
  }
  for (const [key, row] of rows) {
    // A rules-engine swap's amount is not the hit line's (the swap's note says how much), so a row with one shows no
    // total at all: a partial sum would understate it.
    if (row.swappedFor !== undefined) continue;
    const amounts = listAmounts(lines.get(key) ?? []);
    if (amounts.length > 0) row.amounts = amounts;
  }
  const order = (s: StallId): number => STALL_IDS.indexOf(s);
  const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  return [...rows.values()].sort((a, b) => order(a.stall) - order(b.stall) || byText(normalizeName(a.name), normalizeName(b.name)) || byText(a.key, b.key));
}
