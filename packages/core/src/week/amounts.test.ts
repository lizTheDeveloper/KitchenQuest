import { describe, expect, test } from 'vitest';
import type { RecipeIngredient } from '../recipe/types';
import { formatAmounts, listAmounts } from './amounts';
import { canon, dish, graph, MONDAY, planCtx, PORK, STALLS, avoid } from './fixtures';
import { marketList } from './market-list';
import type { Plan, PlanItem } from './plan';

const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const plan = (items: PlanItem[]): Plan => ({ weekStart: MONDAY, items, hard: false, slot: 'unanswered' });
const dishOn = (day: number, slug: string, servings: number): PlanItem => ({ day, kind: 'dish', slug, servings });
const l = (quantity: number | null, unit: string | null, servingsFactor = 1) => ({ quantity, unit, servingsFactor });
const ing = (name: string, quantity: number | null, unit: string | null): RecipeIngredient => ({ name, displayName: null, quantity, unit, note: null });

describe('listAmounts (Ruling 12)', () => {
  test('2 servings of a 4-serving recipe halves; g + kg sum; tsp + tbsp sum; tbsp + cup and g + oz listed side by side; null quantity → shown as written', () => {
    expect(listAmounts([l(900, 'g', 2 / 4)])).toEqual([{ quantity: 450, unit: 'g', text: '450 g' }]);
    expect(listAmounts([l(500, 'g'), l(1, 'kg')])).toEqual([{ quantity: 1500, unit: 'g', text: '1500 g' }]);
    expect(listAmounts([l(1, 'kg'), l(0.5, 'kg')])).toEqual([{ quantity: 1.5, unit: 'kg', text: '1.5 kg' }]);
    expect(listAmounts([l(1, 'tbsp'), l(1, 'tsp')])).toEqual([{ quantity: 4, unit: 'tsp', text: '4 tsp' }]);
    // Spellings fold: case, spaces and a plural "s".
    expect(listAmounts([l(1, 'Tbsp'), l(2, 'tbsps ')])).toEqual([{ quantity: 3, unit: 'tbsp', text: '3 tbsp' }]);
    const sideBySide = listAmounts([l(2, 'tbsp'), l(1, 'cup')]);
    expect(formatAmounts(sideBySide)).toBe('2 tbsp + 1 cup');
    expect(formatAmounts(listAmounts([l(200, 'g'), l(4, 'oz')]))).toBe('200 g + 4 oz');
    expect(formatAmounts(listAmounts([l(1, 'lb'), l(8, 'oz')]))).toBe('24 oz');
    expect(formatAmounts(listAmounts([l(2, 'cups'), l(1, 'l'), l(250, 'ml')]))).toBe('2 cups + 1250 ml');
    // Nothing converts between volume and mass, ever.
    expect(formatAmounts(listAmounts([l(100, 'g'), l(100, 'ml')]))).toBe('100 g + 100 ml');
    // Counts sum with counts; another unit sums only with the same spelling.
    expect(formatAmounts(listAmounts([l(1, null), l(2, null), l(200, 'g')]))).toBe('3 + 200 g');
    expect(formatAmounts(listAmounts([l(2, 'cloves'), l(1, 'clove'), l(1, 'Clove')]))).toBe('2 cloves + 2 clove');
    // Fuzzy amounts are shown as written, once, after the sums.
    expect(listAmounts([l(null, 'a handful'), l(3, null), l(null, 'A handful'), l(null, 'to taste')])).toEqual([
      { quantity: 3, unit: null, text: '3' },
      { quantity: null, unit: 'a handful', text: 'a handful' },
      { quantity: null, unit: 'to taste', text: 'to taste' },
    ]);
    // Thirds round to two places; a tiny amount is never "0".
    expect(formatAmounts(listAmounts([l(1, 'tsp', 1 / 3)]))).toBe('0.33 tsp');
    expect(formatAmounts(listAmounts([l(1, 'g', 1 / 1000)]))).toBe('0.001 g');
    expect(formatAmounts([])).toBe('');
  });

  test('a line with no quantity in any dish → no amounts field (never "0")', () => {
    expect(listAmounts([l(null, null), l(null, null)])).toEqual([]);
    // Zero, negative, non-finite quantities and unusable servings factors count as no quantity.
    expect(listAmounts([l(0, 'g'), l(-1, 'g'), l(Number.NaN, 'g'), l(2, 'g', 0), l(2, 'g', Number.POSITIVE_INFINITY)])).toEqual([{ quantity: null, unit: 'g', text: 'g' }]);
    expect(listAmounts([l(0, null)])).toEqual([]);
    const recipes = new Map([...canon, ['test/salt', dish('leela', ['salt', 'black pepper'], { servings: 2 })]]);
    const vague = recipes.get('test/salt')!;
    recipes.set('test/salt', { ...vague, ingredients: [ing('salt', null, null), ing('black pepper', 1, 'tsp')] });
    const list = marketList(plan([dishOn(0, 'test/salt', 2)]), planCtx({ recipes }), [], STALLS);
    const salt = list.find((i) => i.ingredientId === 'salt')!;
    expect(salt).toBeDefined();
    expect('amounts' in salt).toBe(false);
    expect(list.find((i) => i.name === 'black pepper')?.amounts).toEqual([{ quantity: 1, unit: 'tsp', text: '1 tsp' }]);
  });

  test('marketList scales each dish by its own servings and sums rows across dishes', () => {
    // Parippu serves 3: 6 servings doubles it. Frijoles' salt is added in its own scale.
    const list = marketList(plan([dishOn(0, PARIPPU, 6), dishOn(1, FRIJOLES, 2)]), planCtx(), [], STALLS);
    const dal = list.find((i) => i.ingredientId === 'moong_dal')!;
    expect(dal.amounts).toEqual([{ quantity: 200, unit: 'g', text: '200 g' }]);
    const turmeric = list.find((i) => i.ingredientId === 'turmeric')!;
    expect(turmeric.amounts).toEqual([{ quantity: 0.5, unit: 'tsp', text: '0.5 tsp' }]);
    const shallots = list.find((i) => i.ingredientId === 'shallot')!;
    expect(shallots.amounts).toEqual([{ quantity: 6, unit: null, text: '6' }]);
    const fr = canon.get(FRIJOLES)!;
    const saltLines = [
      ...canon.get(PARIPPU)!.ingredients.filter((x) => graph.resolve(x.name) === 'salt').map((x) => ({ ...x, f: 6 / canon.get(PARIPPU)!.meta.servings })),
      ...fr.ingredients.filter((x) => graph.resolve(x.name) === 'salt').map((x) => ({ ...x, f: 2 / fr.meta.servings })),
    ];
    const salt = list.find((i) => i.ingredientId === 'salt')!;
    expect(salt.amounts).toEqual(listAmounts(saltLines.map((x) => l(x.quantity, x.unit, x.f))));
  });

  test('a ⛔ dish adds no amounts; a sacred dish adds nothing (M5)', () => {
    // A shallot rule makes parippu ⛔ (no swap): its salt adds nothing to frijoles' salt row.
    const both = marketList(plan([dishOn(0, FRIJOLES, 2), dishOn(1, PARIPPU, 3)]), planCtx({ rules: [avoid('shallot')] }), [], STALLS);
    const alone = marketList(plan([dishOn(0, FRIJOLES, 2)]), planCtx({ rules: [avoid('shallot')] }), [], STALLS);
    expect(both).toEqual(alone);
    // A sacred dish in a stored plan lists nothing: no rows, no amounts.
    const recipes = new Map([...canon, ['test/sacred', dish('leela', ['salt', 'rice'], { title: 'Festival dish', sacred: true })]]);
    expect(marketList(plan([dishOn(0, 'test/sacred', 4)]), planCtx({ recipes }), [], STALLS)).toEqual([]);
    const withSacred = marketList(plan([dishOn(0, FRIJOLES, 2), dishOn(1, 'test/sacred', 4)]), planCtx({ recipes }), [], STALLS);
    expect(withSacred).toEqual(marketList(plan([dishOn(0, FRIJOLES, 2)]), planCtx({ recipes }), [], STALLS));
    // A rules-engine swap row shows no total: the swap's note gives its amount.
    const swapped = marketList(plan([dishOn(0, FRIJOLES, 2)]), planCtx({ rules: [PORK] }), [], STALLS).find((i) => i.ingredientId === 'neutral_oil')!;
    expect(swapped.swappedFor).toEqual([FRIJOLES]);
    expect('amounts' in swapped).toBe(false);
  });
});
