// Use-It-Up Rescue (audit M-4 / M-14, Ruling 12): at most one gentle nudge a day, only for food the player actually
// bought at the market, only from a curated keep time, never a guessed spoil date, never tied to money and never a
// countdown. Pure: `today` is passed in.
import type { IngredientGraph } from '../ingredients/graph';
import type { PantryItem } from '../mentor/cards';
import { addDays } from '../progress/week';
import type { ParsedRecipe } from '../recipe/types';
import { isValidDate } from '../rules/active';
import { check, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';
import type { Plan } from './plan';

/** data/keeps.json: ingredient id → days it keeps once bought (Step 4). An id with no entry is never nudged. */
export type KeepsMap = Readonly<Record<string, number>>;

/** At most one rescue nudge a day (Global Constraints). */
export const RESCUE_NUDGES_PER_DAY = 1;
/** A bought item is a candidate when it has this many days left, or fewer. */
export const RESCUE_DAYS_LEFT = 2;

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/**
 * The days a bought item has left (keep time minus days since it was bought; below 0 means past its keep time), or
 * null when that can't be known: not from the market, no valid `addedOn` on or before today, unresolved, or no own
 * `keeps` entry. Shared by the rescue and frame filling (fix round 1, I1): neither ever uses food past its keep time.
 */
export function daysLeftOf(item: PantryItem, today: string, keeps: KeepsMap): number | null {
  const { source, addedOn, ingredientId } = item;
  if (source !== 'market' || typeof addedOn !== 'string' || !isValidDate(addedOn) || !isValidDate(today) || addedOn > today || ingredientId === null) return null;
  const keep = Object.hasOwn(keeps, ingredientId) ? keeps[ingredientId] : undefined;
  if (typeof keep !== 'number' || !Number.isFinite(keep) || keep <= 0) return null;
  return keep - daysBetween(addedOn, today);
}

/** The item alone, checked by the rules engine (a one-line dish). */
function aloneStatus(item: PantryItem, rules: Rule[], graph: IngredientGraph, subs: Substitution[], today: string): string {
  const meta: ParsedRecipe['meta'] = {
    title: item.name, country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 1,
    license: 'CC-BY-SA-4.0', status: 'draft', sacred: false, contributors: [],
  };
  const dish: ParsedRecipe = { meta, ingredients: [{ name: item.name, displayName: null, quantity: null, unit: null, note: null }], timers: [], steps: [], source: '' };
  return check(dish, rules, graph, subs, today).status;
}

/** `a` and `b` are the same ingredient, or one is a kind of the other (spinach and baby spinach). */
function sameFood(a: string, b: string, graph: IngredientGraph): boolean {
  if (a === b) return true;
  if (!graph.has(a) || !graph.has(b)) return false;
  return graph.ancestors(a).includes(b) || graph.ancestors(b).includes(a);
}

/**
 * The one bought item worth rescuing today, or null. Only items with `source: 'market'`, a valid `addedOn` not after
 * today, a resolved ingredient and a `keeps` entry count; told food never does (C9). `daysLeft` is the keep time
 * minus the days since it was bought, and it must be 0–2: past its keep time the item is no longer suggested for cooking
 * (food safety; the player's own judgement and the compost acknowledgement stay theirs). An item a planned dish
 * still to come this week (on or after today) will use is left alone. The closest to its keep time wins, then the
 * one bought first, then id. `nudgedToday` → null (RESCUE_NUDGES_PER_DAY).
 *
 * The item itself must pass the player's rules today, ✅ only (fix round 1, I2): never one they block, one that needs
 * a swap, or one that can't be verified (❓). `ctx` holds the canon recipes (which ingredients a planned dish needs),
 * the graph, and the player's rules and substitutions.
 */
export function rescueCandidate(
  pantry: readonly (PantryItem & { id: string })[],
  plan: Plan | null,
  today: string,
  keeps: KeepsMap,
  nudgedToday: boolean,
  uses: { recipes: ReadonlyMap<string, ParsedRecipe>; graph: IngredientGraph; rules: Rule[]; subs: Substitution[] },
): { item: PantryItem & { id: string }; daysLeft: number } | null {
  if (nudgedToday || !isValidDate(today)) return null;
  const planned: string[] = [];
  if (plan !== null && isValidDate(plan.weekStart)) {
    for (const p of plan.items) {
      if (p.kind !== 'dish' || addDays(plan.weekStart, p.day) < today) continue;
      for (const line of uses.recipes.get(p.slug)?.ingredients ?? []) {
        const id = uses.graph.resolve(line.name);
        if (id !== null) planned.push(id);
      }
    }
  }
  let best: { item: PantryItem & { id: string }; daysLeft: number } | null = null;
  for (const item of pantry) {
    const daysLeft = daysLeftOf(item, today, keeps);
    if (daysLeft === null || daysLeft < 0 || daysLeft > RESCUE_DAYS_LEFT) continue;
    const ingredientId = item.ingredientId!;
    const addedOn = item.addedOn!;
    if (planned.some((id) => sameFood(id, ingredientId, uses.graph))) continue;
    if (aloneStatus(item, uses.rules, uses.graph, uses.subs, today) !== 'ok') continue;
    if (
      best === null ||
      daysLeft < best.daysLeft ||
      (daysLeft === best.daysLeft && (addedOn < best.item.addedOn! || (addedOn === best.item.addedOn && item.id < best.item.id)))
    ) {
      best = { item, daysLeft };
    }
  }
  return best;
}
