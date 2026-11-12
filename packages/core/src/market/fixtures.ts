// Test support for market/ tests only (not exported from the package). The real ingredient graph plus a few test-only
// market foods (Step 4 adds the real market nodes), and small stall files shaped like content/market/*.yaml.
import ingredients from '../../../../data/ingredients.json';
import substitutions from '../../../../data/substitutions.json';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import type { Substitution } from '../rules/check';
import type { Rule } from '../rules/types';
import type { MarketCtx, StallFile, StallOption, StallQuestion } from './types';

/** Test-only market foods (not in data/ingredients.json yet). `tofu` is left out on purpose: an unknown id is ❓. */
const EXTRA: IngredientNode[] = [
  { id: 'beef', name: 'beef', isA: ['meat'] },
  { id: 'chuck', name: 'chuck', isA: ['beef'] },
  { id: 'chicken', name: 'chicken', isA: ['meat'] },
  { id: 'chicken_thigh', name: 'chicken thigh', isA: ['chicken'] },
  { id: 'lentil', name: 'lentil', aliases: ['dried lentils'] },
  { id: 'chickpea', name: 'chickpea' },
  { id: 'tempeh', name: 'tempeh', contains: ['soy'] },
  { id: 'paneer', name: 'paneer', contains: ['milk'] },
  { id: 'asafoetida', name: 'asafoetida', aliases: ['hing'], contains: ['wheat'] },
  { id: 'avocado', name: 'avocado' },
  { id: 'strawberry', name: 'strawberry' },
  { id: 'cabbage', name: 'cabbage' },
];

export const graph = IngredientGraph.fromData({ ingredients: [...ingredients.ingredients, ...EXTRA] });
export const subs: Substitution[] = substitutions;

export const DAY = '2026-11-12';
export const avoid = (...ids: string[]): Rule => ({ id: `r-${ids.join('-')}`, target: { kind: 'ingredient', ids }, type: 'avoid', severity: 'allergy' });
/** data/rule-terms.json's diets, as the rule cards build them. */
export const VEGETARIAN: Rule = { id: 'r-veg', target: { kind: 'category', ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid', severity: 'preference' };
export const VEGAN: Rule = { id: 'r-vegan', target: { kind: 'category', ids: ['meat', 'fish', 'shellfish', 'milk', 'egg', 'honey', 'gelatin'] }, type: 'avoid', severity: 'preference' };
export const NO_PORK: Rule = { id: 'r-pork', target: { kind: 'ingredient', ids: ['pork'] }, type: 'avoid', severity: 'preference' };

export const ctx = (rules: Rule[] = [], over: Partial<MarketCtx> = {}): MarketCtx => ({ rules, graph, subs, date: DAY, country: null, ...over });

const opt = (text: string, correct = false, extra: Partial<StallOption> = {}): StallOption => ({ text, correct, reaction: `${correct ? 'Right' : 'Not quite'}: ${text}.`, ...extra });

/** A question with a neutral first-correct option set, the shape most shipped questions have. */
export function question(id: string, over: Partial<StallQuestion> = {}): StallQuestion {
  return {
    id,
    game: 'cut_match',
    prompt: `Question ${id}?`,
    options: [opt('The first answer', true), opt('A second answer'), opt('A third answer')],
    explain: 'One plain sentence, true on its own.',
    ...over,
  };
}

const trigger = (...lines: string[]) => ({ ai: 'never' as const, lines });

export const MEDICAL_LINE = "That one's for a doctor or a dietitian. I sell food, not diagnoses.";
export const ALLERGEN_LINE = 'Spice blends can hide allergens. Please check every label, and choose single spices where you can.';

export const BRAM: StallFile = {
  id: 'bram',
  name: 'Big Bram',
  stall: 'butcher',
  art: 'butcher',
  persona: ['A big-hearted, precise butcher.'],
  triggers: { greet: { ai: 'allowed', lines: ['Morning!'] }, medical: trigger(MEDICAL_LINE) },
  games: { cut_match: 'Match a cut.', value: 'Chalkboard maths.', label: 'Decode a label.', safety: 'Temperatures.' },
  questions: [
    question('bram-braise-cut', { contains: ['beef'], prompt: 'A three-hour braise. Which cut?', options: [opt('Chuck', true), opt('Tenderloin'), opt('Strip steak')] }),
    question('bram-curry-chicken', { contains: ['chicken'], prompt: 'A 45-minute curry. Which part of the bird?', options: [opt('Thighs', true), opt('Breast'), opt('Wings')] }),
    question('bram-pork-shoulder', { contains: ['pork'], prompt: 'Pulled pork. Which cut?', options: [opt('Shoulder', true), opt('Tenderloin'), opt('Chop')] }),
    question('bram-lard-pastry', { prompt: 'Flaky pastry the old way. What fat?', options: [opt('Lard', true), opt('Water'), opt('Nothing')] }),
    question('bram-usda-label', { game: 'label', countries: ['United States'], prompt: "A label says 'USDA Prime'. What does it grade?", options: [opt('Marbling', true), opt('Price'), opt('Age')] }),
    question('bram-thermometer', { game: 'safety', prompt: 'Where does the thermometer go?', options: [opt('The thickest part', true), opt('The surface'), opt('The bone')] }),
  ],
  variants: {
    protein_counter: {
      name: "Big Bram's Protein Counter",
      persona: ['Same Bram, new sign.'],
      triggers: { greet: { ai: 'allowed', lines: ['Welcome to the Protein Counter!'] } },
      questions: [
        question('bram-pc-lentils', { game: 'value', prompt: 'Cheapest protein per serving?', options: [opt('Dried lentils', true), opt('Tempeh'), opt('A block of cheese')] }),
        question('bram-pc-eggs', { game: 'label', prompt: 'What does a free-range egg box promise?', contains: ['egg'] }),
        question('bram-pc-paneer', { game: 'cut_match', prompt: 'Which holds its shape in a hot pan?', options: [opt('Paneer', true), opt('Ricotta'), opt('Cottage cheese')] }),
        question('bram-pc-tofu', { game: 'cut_match', prompt: 'Which block for frying?', contains: ['tofu'] }),
        question('bram-pc-chickpeas', { game: 'value', prompt: 'One cup of dried chickpeas cooks up to about…', contains: ['chickpea'] }),
      ],
      item_tips: {
        lentil: { pick: 'Whole, unbroken, no dust.', store: 'Airtight, dark, a year or more.' },
        paneer: { pick: 'Firm and milky-white.', store: 'Fridge, in water, two days.' },
      },
      faq: [
        { q: ['what does fermenting do', 'fermented'], a: 'Yes: tempeh is soybeans bound by a friendly mould.', a_if_blocked: 'Ask me about chickpeas instead: they keep for a year.' },
        { q: ['how much protein do i need'], a: 'Enough, from a variety of foods.' },
        { q: ['is soy safe'], a: 'For most people, yes: a legume eaten for centuries.' },
        { q: ['is tempeh gluten free'], a: 'Plain tempeh is; flavoured ones vary, so read the label.' },
      ],
    },
  },
  item_tips: {
    chuck: { pick: 'Good marbling and seams of connective tissue.', store: 'Fridge, bottom shelf, 3–5 days.' },
    chicken_thigh: { pick: 'Plump, pink, no strong smell.', store: 'Fridge 1–2 days.' },
    pork: { pick: 'Good marbling and a fat cap.', store: 'Fridge 3–5 days.' },
    cabbage: { pick: 'Heavy for its size.', store: 'Fridge, wrapped, rendered with lard if you like.' },
  },
  faq: [
    { q: ['how much meat per person'], a: 'About 150–225 g of raw meat per person.' },
    { q: ['is pink pork safe', 'pork pink inside'], a: 'Whole cuts of pork are safe at 63°C with a rest.', a_if_blocked: 'Use a thermometer for any whole cut.' },
    { q: ['what fat for pastry'], a: 'Lard makes it flaky.' },
  ],
};

export const SPICE: StallFile = {
  id: 'spice',
  name: 'The Spice Merchant',
  stall: 'spice',
  art: null,
  triggers: { greet: { ai: 'allowed', lines: ['Sniff first.'] }, allergen_note: trigger(ALLERGEN_LINE) },
  games: { sniff: 'Blind sniff.', freshness: 'Is it still good?', substitute: 'Substitution riddles.' },
  questions: [
    question('spice-hing', { game: 'sniff', prompt: 'A pinch of this replaces onion and garlic in many Jain kitchens. What is it?', options: [opt('Asafoetida', true), opt('Cumin'), opt('Turmeric')] }),
    question('spice-cumin', { game: 'sniff', prompt: 'Earthy, warm, ridged seeds. What are they?', contains: ['cumin_seed'], options: [opt('Cumin', true), opt('Caraway'), opt('Fennel')] }),
  ],
  item_tips: {
    asafoetida: { pick: 'A small tin; a pinch goes far.', store: 'Airtight, away from everything else.' },
    cumin_seed: { pick: 'Whole seeds, ridged, earthy.', store: 'Airtight, dark, cool.' },
  },
  faq: [
    { q: ['spice blend allergens'], a: 'Asafoetida usually has wheat flour in it.' },
    { q: ['how long do spices last'], a: 'They fade; they rarely spoil.' },
  ],
};

export const WEN: StallFile = {
  id: 'wen',
  name: 'Old Wen',
  stall: 'produce',
  art: 'grocer',
  triggers: { medical: trigger(MEDICAL_LINE) },
  games: { ripeness: 'Ripe or not?', storage: 'Where does it keep?', seasonal: 'Seasonal or well-travelled?' },
  questions: [
    question('wen-avocado-ripe', { game: 'ripeness', contains: ['avocado'], prompt: 'Which avocado is for tonight?' }),
    question('wen-garlic-store', { game: 'storage', prompt: 'Where do you keep a head of garlic?', options: [opt('A cool, dry, dark cupboard', true), opt('The fridge'), opt('A sunny sill')] }),
    question('wen-soy-sauce', { game: 'storage', prompt: 'An opened bottle of soy sauce: fridge or cupboard?', options: [opt('Either; the fridge keeps it brighter', true), opt('Freezer'), opt('Bin it')] }),
    question('wen-berries', { game: 'storage', prompt: 'Berries from the market: wash now or later?', options: [opt('Just before eating', true), opt('Straight away'), opt('Never')] }),
  ],
  item_tips: { avocado: { pick: 'Gentle give.', store: 'Counter to ripen.' } },
  faq: [],
};

/** A seasonal question, as Step 2 would supply it for a region and month. */
export const SEASONAL_STRAWBERRY = question('wen-pnw-6-strawberry', { game: 'seasonal', contains: ['strawberry'], prompt: 'June. Wen holds up a punnet of strawberries. Where have they been?', options: [opt('In season here, now', true), opt('Stored from the autumn harvest'), opt('Well-travelled')] });
