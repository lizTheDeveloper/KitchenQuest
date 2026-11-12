// Test support for season tests only (not exported from the package). A synthetic two-region Season's Table: one
// temperate region with now / stored / travelled, one tropical region with now / monsoon / all_year / travelled.
// The region names and phrases are made up, and the months are invented: none of this is a claim about any real
// place's seasons (Ruling 9). The real table is data/seasonality.yaml (Step 4).
import ingredients from '../../../../data/ingredients.json';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import type { ParsedRecipe } from '../recipe/types';
import type { SeasonRegion, SeasonTable } from './season';
import type { StallFile, StallOption, StallQuestion } from './types';

/** Test-only produce (not in data/ingredients.json yet). `butternut` is a kind of `winter_squash`, a kind of `squash`. */
const EXTRA: IngredientNode[] = [
  { id: 'squash', name: 'squash' },
  { id: 'winter_squash', name: 'winter squash', isA: ['squash'] },
  { id: 'butternut', name: 'butternut', isA: ['winter_squash'] },
  { id: 'cranberry', name: 'cranberry' },
  { id: 'strawberry', name: 'strawberry' },
  { id: 'mango', name: 'mango' },
  { id: 'jackfruit', name: 'jackfruit' },
  { id: 'kale', name: 'kale' },
];

export const graph = IngredientGraph.fromData({ ingredients: [...ingredients.ingredients, ...EXTRA] });

export const NOW = 'In season here, now';
export const STORED = 'Local, stored from the autumn harvest';
export const TRAVELLED = 'Shipped in from far away';
export const MONSOON = 'A rainy-season crop here';
export const ALL_YEAR = 'Grown here all year';

/** Temperate, synthetic: three categories, three months written, the rest left empty (no note, never a guess). */
export const VALE: SeasonRegion = {
  id: 'test-vale',
  name: 'Test Vale (synthetic)',
  status: 'draft',
  sources: ['Synthetic test fixture; no real calendar'],
  match: { countries: ['Canada'], regions: ['test vale', 'vale of tests'] },
  categories: [
    { id: 'now', label: NOW },
    { id: 'stored', label: STORED },
    { id: 'travelled', label: TRAVELLED },
  ],
  months: {
    '6': { now: ['strawberry'] },
    '11': { now: ['cranberry', 'kale'], stored: ['winter_squash'], travelled: ['strawberry', 'mango'] },
    '12': { now: ['kale'], stored: ['winter_squash', 'cranberry'], travelled: ['strawberry'] },
  },
};

/** Tropical, synthetic, the whole country (`regions: []`): its own categories, and no "stored" one at all. */
export const COAST: SeasonRegion = {
  id: 'test-coast',
  name: 'Test Coast (synthetic)',
  status: 'draft',
  sources: ['Synthetic test fixture; no real calendar'],
  match: { countries: ['Sri Lanka'], regions: [] },
  categories: [
    { id: 'now', label: NOW },
    { id: 'monsoon', label: MONSOON },
    { id: 'all_year', label: ALL_YEAR },
    { id: 'travelled', label: TRAVELLED },
  ],
  months: {
    '11': { now: ['jackfruit'], monsoon: ['kale'], all_year: ['coconut'], travelled: ['strawberry'] },
  },
};

export const TABLE: SeasonTable = Object.freeze({ 'test-vale': VALE, 'test-coast': COAST });

/** A same-country child of the Vale: its own month 11 only, so month 12 comes from the Vale. */
export const EAST_VALE: SeasonRegion = {
  id: 'test-east-vale',
  name: 'East Test Vale (synthetic)',
  status: 'draft',
  sources: ['Synthetic test fixture; no real calendar'],
  match: { countries: ['Canada'], regions: ['east dale'] },
  parent: 'test-vale',
  categories: VALE.categories,
  months: { '11': { now: ['winter_squash'] } },
};

export const WITH_CHILD: SeasonTable = Object.freeze({ ...TABLE, 'test-east-vale': EAST_VALE });

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const opt = (text: string, correct = false): StallOption => ({ text, correct, reaction: `${correct ? 'Right' : 'Not quite'}: ${text}.` });

/** A seasonal question in Wen's shape: one ingredient, the region's labels as options. */
export function seasonal(id: string, ingredient: string, labels: readonly string[], correct: string): StallQuestion {
  return {
    id,
    game: 'seasonal',
    prompt: `Wen holds up some ${ingredient}. Where has it been?`,
    contains: [ingredient],
    options: labels.map((l) => opt(l, l === correct)),
    explain: 'One plain sentence, true on its own.',
  };
}

const VALE_LABELS = [NOW, STORED, TRAVELLED];
const COAST_LABELS = [NOW, MONSOON, ALL_YEAR, TRAVELLED];

/** Wen with seasonal blocks that agree with TABLE. */
export const WEN: StallFile = {
  id: 'wen',
  name: 'Old Wen',
  stall: 'produce',
  art: 'grocer',
  triggers: {},
  games: { seasonal: 'Seasonal or well-travelled?', storage: 'Where does it keep?' },
  questions: [
    {
      id: 'wen-garlic-store',
      game: 'storage',
      prompt: 'Where do you keep a head of garlic?',
      options: [opt('A cool, dry, dark cupboard', true), opt('The fridge'), opt('A sunny sill')],
      explain: 'Garlic keeps in the dry and the dark.',
    },
  ],
  seasonal: {
    'test-vale': {
      '11': [
        seasonal('wen-vale-11-cranberry', 'cranberry', VALE_LABELS, NOW),
        seasonal('wen-vale-11-squash', 'winter_squash', VALE_LABELS, STORED),
        seasonal('wen-vale-11-strawberry', 'strawberry', VALE_LABELS, TRAVELLED),
      ],
      '12': [seasonal('wen-vale-12-kale', 'kale', VALE_LABELS, NOW)],
    },
    'test-coast': {
      '11': [seasonal('wen-coast-11-jackfruit', 'jackfruit', COAST_LABELS, NOW)],
    },
  },
  item_tips: {},
  faq: [],
};

/** A dish of bare lines, as the parser would give it (names only matter here). */
export function dish(names: readonly string[], sacred = false): ParsedRecipe {
  return {
    meta: { title: 'test dish', country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 2, license: '', status: 'draft', sacred, contributors: [] },
    ingredients: names.map((name) => ({ name, displayName: null, quantity: null, unit: null, note: null })),
    timers: [],
    steps: [],
    source: '',
  };
}
