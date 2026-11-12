import { describe, expect, test } from 'vitest';
import type { PantryItem } from '../mentor/cards';
import { avoid, graph, MONDAY, planCtx, PORK, STALLS } from './fixtures';
import { marketList, STALL_IDS, stallFor } from './market-list';
import type { Plan, PlanItem } from './plan';

const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const plan = (items: PlanItem[]): Plan => ({ weekStart: MONDAY, items, hard: false, slot: 'unanswered' });
const dishOn = (day: number, slug: string): PlanItem => ({ day, kind: 'dish', slug, servings: 2 });
const told = (name: string): PantryItem => ({ name, ingredientId: graph.resolve(name) });

describe('marketList', () => {
  test('marketList: pantry "Onion" removes onion; a swap ingredient is listed as the swap; ⛔ dish adds nothing; grouped by stall', () => {
    // A pork rule: frijoles' lard has the curated neutral-oil swap. A shallot rule: parippu is ⛔ (no swap).
    const ctx = planCtx({ rules: [PORK, avoid('shallot')] });
    const list = marketList(plan([dishOn(0, FRIJOLES), dishOn(1, PARIPPU)]), ctx, [told('Onion')], STALLS);
    const names = list.map((i) => i.name);
    expect(names).not.toContain('white onion');
    expect(names).not.toContain('lard');
    expect(list.find((i) => i.ingredientId === 'neutral_oil')).toEqual({
      key: 'neutral_oil',
      name: 'neutral oil',
      ingredientId: 'neutral_oil',
      stall: 'general',
      forDishes: [FRIJOLES],
      swappedFor: [FRIJOLES],
      ticked: false,
    });
    // Nothing from parippu, the ⛔ dish.
    for (const i of list) expect(i.forDishes).toEqual([FRIJOLES]);
    expect(names).not.toContain('shallots');
    expect(names).not.toContain('split moong dal');
    // Water is never something to buy.
    expect(list.some((i) => i.ingredientId === 'water')).toBe(false);
    // Grouped by stall in STALL_IDS order.
    const order = list.map((i) => STALL_IDS.indexOf(i.stall));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(list.find((i) => i.ingredientId === 'black_bean')?.stall).toBe('okafor-sato');
    expect(list.find((i) => i.ingredientId === 'garlic')?.stall).toBe('wen'); // through allium
    expect(list.find((i) => i.ingredientId === 'salt')?.stall).toBe('general');
  });

  test('one row per ingredient across dishes; lessons add nothing; every row starts unticked', () => {
    const list = marketList(plan([dishOn(0, FRIJOLES), dishOn(1, PARIPPU), { day: 2, kind: 'lesson', slug: 'japan/osaka/onigiri' }]), planCtx(), [], STALLS);
    const salt = list.filter((i) => i.ingredientId === 'salt');
    expect(salt).toHaveLength(1);
    expect(salt[0].forDishes).toEqual([FRIJOLES, PARIPPU]);
    expect(list.some((i) => i.forDishes.includes('japan/osaka/onigiri'))).toBe(false);
    expect(list.every((i) => !i.ticked && i.swappedFor === undefined)).toBe(true);
    // Garlic: "garlic cloves" and "garlic clove" are the same row.
    expect(list.filter((i) => i.ingredientId === 'garlic')).toHaveLength(1);
  });

  test('each dish is checked on its own day: a phased rule blocks only the later dish', () => {
    const ctx = planCtx({ rules: [avoid('shallot', { phase: { start: '2026-11-12' } })] });
    const early = marketList(plan([dishOn(2, PARIPPU)]), ctx, [], STALLS);
    const late = marketList(plan([dishOn(3, PARIPPU)]), ctx, [], STALLS);
    expect(early.length).toBeGreaterThan(0);
    expect(late).toEqual([]);
  });

  test('an unresolved line is listed by name at the general stall with a stable name key; an unknown slug adds nothing', () => {
    const recipes = new Map([['test/odd', { ...planCtx().recipes.get(PARIPPU)!, ingredients: [{ name: 'Jasmine-ish Rice', displayName: null, quantity: 1, unit: null, note: null }] }]]);
    const list = marketList(plan([dishOn(0, 'test/odd'), dishOn(1, 'not/a-dish')]), planCtx({ recipes }), [], STALLS);
    expect(list).toEqual([{ key: 'name:jasmine-ish rice', name: 'Jasmine-ish Rice', ingredientId: null, stall: 'general', forDishes: ['test/odd'], unverified: true, amounts: [{ quantity: 0.67, unit: null, text: '0.67' }], ticked: false }]);
  });

  test('a stored M4 pantry row (no addedOn, no source) still matches by name or id', () => {
    const m4Row = JSON.parse('{"name":"black beans","ingredientId":"black_bean"}') as PantryItem;
    const byName = JSON.parse('{"name":"Salt","ingredientId":null}') as PantryItem;
    const list = marketList(plan([dishOn(0, FRIJOLES)]), planCtx(), [m4Row, byName], STALLS);
    expect(list.some((i) => i.ingredientId === 'black_bean')).toBe(false);
    expect(list.some((i) => i.ingredientId === 'salt')).toBe(false);
  });
});

describe('stallFor', () => {
  test('own entry, else the nearest isA ancestor, else general; null and unknown ids are general', () => {
    expect(stallFor('black_bean', graph, STALLS)).toBe('okafor-sato');
    expect(stallFor('shallot', graph, STALLS)).toBe('wen');
    expect(stallFor('baby_spinach', graph, STALLS)).toBe('wen');
    expect(stallFor('bonito_flakes', graph, STALLS)).toBe('okafor-sato');
    expect(stallFor('lard', graph, STALLS)).toBe('general'); // contains pork, but contains is not isA
    expect(stallFor('salt', graph, STALLS)).toBe('general');
    expect(stallFor(null, graph, STALLS)).toBe('general');
    expect(stallFor('not_an_id', graph, STALLS)).toBe('general');
    expect(stallFor('salt', graph, { salt: 'dairy' as never })).toBe('general');
  });
});

describe('fix round 1, M1: a ❓ line is marked on the list', () => {
  test('unresolved and label-dependent lines carry unverified; a plain line does not', () => {
    const recipes = new Map([['test/odd', { ...planCtx().recipes.get(PARIPPU)!, ingredients: [
      { name: 'jasmine-ish rice', displayName: null, quantity: 1, unit: null, note: null },
      { name: 'salt', displayName: null, quantity: 1, unit: 'g', note: null },
    ] }]]);
    const odd = marketList(plan([dishOn(0, 'test/odd')]), planCtx({ recipes }), [], STALLS);
    expect(odd.find((i) => i.name === 'jasmine-ish rice')?.unverified).toBe(true);
    expect(odd.find((i) => i.name === 'salt')?.unverified).toBeUndefined();
    // Corn tortillas are store-bought: ❓ under any rule.
    const fr = marketList(plan([dishOn(0, FRIJOLES)]), planCtx({ rules: [PORK] }), [], STALLS);
    expect(fr.find((i) => i.ingredientId === 'corn_tortilla')?.unverified).toBe(true);
    expect(fr.find((i) => i.ingredientId === 'black_bean')?.unverified).toBeUndefined();
  });
});
