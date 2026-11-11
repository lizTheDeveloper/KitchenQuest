// Test support for week/ and book/ tests only (not exported from the package). The real ingredient graph plus the
// frame ingredients Step 4 will add (C12) and a few test-only foods, the canon recipes, a handful of small test
// dishes, and the three seed frames of Ruling 13 in the shape Step 4 will ship them.
import ingredients from '../../../../data/ingredients.json';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import type { ParsedRecipe, RecipeIngredient } from '../recipe/types';
import { recipes as canon, subs } from '../quests/fixtures';
import type { Rule } from '../rules/types';
import type { Frame } from './frames';
import type { KeepsMap } from './use-it-up';
import type { StallMap } from './market-list';
import type { FoodGroups, PlanContext } from './plan';

export { subs };

const EXTRA: IngredientNode[] = [
  { id: 'spinach', name: 'spinach' },
  { id: 'baby_spinach', name: 'baby spinach', isA: ['spinach'] },
  { id: 'tomato', name: 'tomato' },
  { id: 'lime', name: 'lime' },
  { id: 'herb', name: 'fresh herbs', aliases: ['herb'] },
  { id: 'coriander', name: 'coriander', aliases: ['cilantro'], isA: ['herb'] },
  { id: 'parsley', name: 'parsley', isA: ['herb'] },
  { id: 'cooked_rice', name: 'cooked rice', aliases: ['leftover rice', 'cold rice'], isA: ['rice'] },
  { id: 'chickpea', name: 'chickpea' },
  { id: 'lentil', name: 'lentil' },
  { id: 'peanut_butter', name: 'peanut butter', contains: ['peanut'] },
];

export const graph = IngredientGraph.fromData({ ingredients: [...ingredients.ingredients, ...EXTRA] });

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
  kale: 'veg_fruit', // not in the graph: counts for nothing
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

/** The three seed frames of Ruling 13 (draft, credited to the Bureau's editors). */
export const FRAMES: Frame[] = [
  {
    id: 'fried-rice',
    title: 'Fried rice from what you have',
    technique: 'stir-fry',
    status: 'draft',
    credit: "The Bureau's editors",
    slots: [
      { key: 'rice', accepts: ['cooked_rice', 'rice'], optional: false },
      { key: 'oil', accepts: ['neutral_oil', 'coconut_oil'], optional: false },
      { key: 'veg', accepts: ['spinach', 'onion', 'herb'], optional: true },
      { key: 'egg', accepts: ['egg'], optional: true },
      { key: 'sauce', accepts: ['soy_sauce', 'tamari'], optional: true },
    ],
    steps: ['Heat {oil} until it shimmers.', 'Add {veg} and toss.', 'Add {rice}, break it up and fry hard.', 'Push aside and scramble {egg}.', 'Season with {sauce}.'],
    rescues: ['cooked_rice', 'spinach'],
  },
  {
    id: 'green-sauce',
    title: 'Green sauce',
    technique: 'emulsion',
    status: 'draft',
    credit: "The Bureau's editors",
    slots: [
      { key: 'herb', accepts: ['herb'], optional: false },
      { key: 'acid', accepts: ['lime'], optional: false },
      { key: 'oil', accepts: ['neutral_oil'], optional: false },
      { key: 'nut', accepts: ['nut'], optional: true },
    ],
    steps: ['Chop {herb} fine.', 'Squeeze in {acid}.', 'Beat in {oil} slowly.', 'Crush {nut} and stir it through.'],
    rescues: ['herb'],
  },
  {
    id: 'quick-tomato-sauce',
    title: 'Quick tomato sauce',
    technique: 'quick-sauce',
    status: 'draft',
    credit: "The Bureau's editors",
    slots: [
      { key: 'tomato', accepts: ['tomato'], optional: false },
      { key: 'oil', accepts: ['neutral_oil', 'coconut_oil'], optional: false },
      { key: 'allium', accepts: ['allium'], optional: true },
    ],
    steps: ['Warm {oil}.', 'Soften {allium}.', 'Add {tomato} and cook down.'],
    rescues: ['tomato'],
  },
];
