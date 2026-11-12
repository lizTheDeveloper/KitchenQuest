// Test support for week/ and book/ tests only (not exported from the package). The real ingredient graph (with the
// frame ingredients Step 4 added, C12) plus a few test-only foods, the canon recipes, a handful of small test dishes,
// and the three seed frames of Ruling 13 as shipped in content/frames (copies pinned in shipped.fixture.ts).
import ingredients from '../../../../data/ingredients.json';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import type { ParsedRecipe, RecipeIngredient } from '../recipe/types';
import { recipes as canon, subs } from '../quests/fixtures';
import { SHIPPED_FRAMES } from '../quests/shipped.fixture';
import type { Rule } from '../rules/types';
import type { Frame } from './frames';
import type { KeepsMap } from './use-it-up';
import type { StallMap } from './market-list';
import type { FoodGroups, PlanContext } from './plan';

export { subs };

/** Test-only foods (not in data/ingredients.json). */
const EXTRA: IngredientNode[] = [
  { id: 'baby_spinach', name: 'baby spinach', isA: ['spinach'] },
  { id: 'coriander', name: 'coriander', aliases: ['cilantro'], isA: ['herb'] },
  { id: 'parsley', name: 'parsley', isA: ['herb'] },
  { id: 'chickpea', name: 'chickpea' },
  { id: 'lentil', name: 'lentil' },
  { id: 'peanut_butter', name: 'peanut butter', contains: ['peanut'] },
  // Plural forms (fix round 1, N2): -y → -ies, -f → -ves, -fe → -ves. "knife" stands in for any -fe label.
  { id: 'berry', name: 'berry' },
  { id: 'bay_leaf', name: 'bay leaf' },
  { id: 'loaf', name: 'loaf' },
  { id: 'test_knife', name: 'knife' },
];

/** Step 4 added real nodes with some of these ids: the real node wins, and the test-only one is dropped. */
const REAL_IDS = new Set(ingredients.ingredients.map((n) => n.id));
export const graph = IngredientGraph.fromData({ ingredients: [...ingredients.ingredients, ...EXTRA.filter((n) => !REAL_IDS.has(n.id))] });

const line = (name: string, quantity: number | null = 100, unit: string | null = 'g'): RecipeIngredient => ({ name, displayName: null, quantity, unit, note: null });
const base = canon.get('india/kerala/parippu')!;
/** A small test dish: `cook`, `skills`, ingredient names. */
export function dish(cook: string, names: string[], over: Partial<ParsedRecipe['meta']> = {}): ParsedRecipe {
  return {
    meta: { ...base.meta, title: `Test ${cook} ${names[0]}`, cook, skills: ['legumes'], servings: 2, ...over },
    ingredients: names.map((n) => line(n)),
    timers: [],
    steps: [{ section: null, items: names.map((_, index) => ({ type: 'ingredient' as const, index })) }],
    source: '',
  };
}

export { canon };

export const ALLIUM: Rule = { id: 'r-allium', target: { kind: 'category', ids: ['allium'] }, type: 'avoid', severity: 'allergy' };
export const PEANUT: Rule = { id: 'r-peanut', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
export const PORK: Rule = { id: 'r-pork', target: { kind: 'ingredient', ids: ['pork'] }, type: 'avoid', severity: 'preference' };
export const avoid = (id: string, extra: Partial<Rule> = {}): Rule => ({ id: `r-${id}`, target: { kind: 'ingredient', ids: [id] }, type: 'avoid', severity: 'allergy', ...extra });

const FOOD_GROUPS: FoodGroups = {
  allium: 'veg_fruit',
  spinach: 'veg_fruit',
  tomato: 'veg_fruit',
  lime: 'veg_fruit',
  herb: 'veg_fruit',
  moong_dal: 'protein',
  black_bean: 'protein',
  chickpea: 'protein',
  lentil: 'protein',
  egg: 'protein',
  fish: 'protein',
  rice: 'grain',
  corn_tortilla: 'grain',
  samphire: 'veg_fruit', // not in the graph: counts for nothing (kale was, until M6 Step 4 made it a node)
};

export const STALLS: StallMap = {
  allium: 'wen',
  spinach: 'wen',
  herb: 'wen',
  tomato: 'wen',
  lime: 'wen',
  epazote: 'wen',
  pork: 'bram',
  black_bean: 'okafor-sato',
  fish: 'okafor-sato',
  rice: 'okafor-sato',
  cumin_seed: 'spice',
  turmeric: 'spice',
  mustard_seed: 'spice',
  moong_dal: 'spice',
};

export const KEEPS: KeepsMap = { spinach: 4, herb: 5, tomato: 5, cooked_rice: 1 };

/** A Monday-start week (no market days): Mon 2026-11-09 … Sun 2026-11-15. */
export const MONDAY = '2026-11-09';
/** A Saturday-start week (market day Saturday): Sat 2026-11-07 … Fri 2026-11-13. */
export const SATURDAY = '2026-11-07';

export function planCtx(over: Partial<PlanContext> = {}): PlanContext {
  return { weekStart: MONDAY, recipes: canon, rules: [], graph, subs, existing: [], foodGroups: FOOD_GROUPS, ...over };
}

/** The three seed frames of Ruling 13 (draft, credited to the Bureau's editors), as shipped in content/frames. */
export const FRAMES: Frame[] = SHIPPED_FRAMES;
