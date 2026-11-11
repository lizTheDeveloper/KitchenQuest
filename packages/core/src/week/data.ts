// Checks for the week's curated data files (M5 Step 4): data/keeps.json, data/stalls.json and data/food-groups.json.
// Shared by the game build and the API catalogue (Step 5), so neither refuses or accepts what the other wouldn't. Data
// in, problems out; never throws.
import type { IngredientGraph } from '../ingredients/graph';
import { STALL_IDS } from './market-list';
import type { FoodGroup } from './plan';

const FOOD_GROUPS: readonly FoodGroup[] = ['veg_fruit', 'protein', 'grain'];
/** The longest keep time the file may claim: a year. Anything longer is a typo, not a keep time. */
const MAX_KEEP_DAYS = 365;

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every key must be an ingredient id in the graph; `value` checks each value and names what it expected. */
function mapProblems(d: unknown, graph: IngredientGraph, what: string, value: (v: unknown) => string | null): string[] {
  if (!isMap(d)) return [`${what} must be a mapping of ingredient id to value`];
  const p: string[] = [];
  for (const [id, v] of Object.entries(d)) {
    if (!graph.has(id)) p.push(`${what}: "${id}" is not an ingredient id in the graph`);
    const bad = value(v);
    if (bad !== null) p.push(`${what}: "${id}" ${bad}`);
  }
  return p;
}

/**
 * data/keeps.json (`KeepsMap`): ingredient id → whole days it keeps once bought, 1 to 365. The lookup is by the
 * item's own id with no isA ancestry (Ruling 12), so the keys name concrete ingredients; an id with no entry is never
 * nudged.
 */
export function validateKeeps(d: unknown, graph: IngredientGraph): string[] {
  return mapProblems(d, graph, 'keeps', (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_KEEP_DAYS ? null : `must keep a whole number of days from 1 to ${MAX_KEEP_DAYS}`,
  );
}

/** data/stalls.json (`StallMap`): ingredient or category id → a stall id (the content/market ids, or 'general'; C11). */
export function validateStallMap(d: unknown, graph: IngredientGraph, stalls: ReadonlySet<string> = new Set(STALL_IDS)): string[] {
  return mapProblems(d, graph, 'stalls', (v) =>
    typeof v === 'string' && stalls.has(v) && (STALL_IDS as readonly string[]).includes(v) ? null : `names "${String(v)}", which is not a stall (${[...stalls].join(', ')})`,
  );
}

/** data/food-groups.json (`FoodGroups`): ingredient or category id → veg_fruit, protein or grain. */
export function validateFoodGroups(d: unknown, graph: IngredientGraph): string[] {
  return mapProblems(d, graph, 'food-groups', (v) =>
    typeof v === 'string' && (FOOD_GROUPS as readonly string[]).includes(v) ? null : `names "${String(v)}", which is not a food group (${FOOD_GROUPS.join(', ')})`,
  );
}
