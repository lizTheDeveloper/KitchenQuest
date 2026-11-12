import { describe, expect, it } from 'vitest';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import { parseRecipe } from '../recipe/parse';
import { nutritionPerServing } from './compute';
import { toGrams, unitFamily, unitOf } from './units';

const node = (extra: Partial<IngredientNode> = {}): IngredientNode => ({ id: 'x', name: 'x', ...extra });

function recipe(body: string, servings = 2) {
  return parseRecipe(`---
title: Test Dish
country: Testland
region: Test Region
credit: Tester
cook: Tester
difficulty: 1
skills: [stirring]
servings: ${servings}
license: CC-BY-SA-4.0
status: draft
---

${body}
`);
}

const graph = IngredientGraph.fromData({
  ingredients: [
    { id: 'lentil', name: 'lentil', per100g: { protein_g: 24 } },
    { id: 'water', name: 'water', densityGPerMl: 1, per100g: { energy_kcal: 0, protein_g: 0 } },
    { id: 'salt', name: 'salt', per100g: { sodium_mg: 38758 } },
    { id: 'mystery', name: 'mystery', per100g: { protein_g: 5 } },
  ],
});

describe('toGrams', () => {
  it('converts mass units', () => {
    expect(toGrams(100, 'g', node())).toEqual({ grams: 100, estimated: false });
    expect(toGrams(2, 'KG', node())?.grams).toBe(2000);
    expect(toGrams(2, 'cups', node({ densityGPerMl: 1 }))?.grams).toBeCloseTo(473.176);
  });
  it('converts volume with density', () => {
    expect(toGrams(2, 'tbsp', node({ densityGPerMl: 0.92 }))?.grams).toBeCloseTo(27.21, 2);
  });
  it('returns null for volume without density', () => {
    expect(toGrams(1, 'cup', node())).toBeNull();
  });
  it('uses gramsPerUnit for counts', () => {
    expect(toGrams(2, null, node({ gramsPerUnit: 50 }))?.grams).toBe(100);
    expect(toGrams(2, null, node())).toBeNull();
  });
  it('uses defaultGrams, flagged estimated, when no quantity', () => {
    expect(toGrams(null, null, node({ defaultGrams: 2 }))).toEqual({ grams: 2, estimated: true });
    expect(toGrams(null, null, node())).toBeNull();
  });
  it('returns null for unknown units and bad quantities', () => {
    expect(toGrams(1, 'pinch', node({ defaultGrams: 1 }))).toBeNull();
    expect(toGrams(NaN, 'g', node())).toBeNull();
    expect(toGrams(-1, 'g', node())).toBeNull();
  });
});

describe('unitFamily (M6 Ruling 12)', () => {
  it('folds case, spaces and a plural "s"; families g/mg/kg, oz/lb, ml/l, tsp/tbsp, and the cup alone', () => {
    expect(['g', 'G', ' kg ', 'mgs', 'kgs'].map(unitFamily)).toEqual(['g', 'g', 'g', 'g', 'g']);
    expect(['oz', 'lb', 'lbs', 'ozs'].map(unitFamily)).toEqual(['oz', 'oz', 'oz', 'oz']);
    expect(['ml', 'l', 'L', 'mls'].map(unitFamily)).toEqual(['ml', 'ml', 'ml', 'ml']);
    expect(['tsp', 'tbsp', 'Tbsps', 'tsps'].map(unitFamily)).toEqual(['tsp', 'tsp', 'tsp', 'tsp']);
    expect(['cup', 'cups', 'Cups'].map(unitFamily)).toEqual(['cup', 'cup', 'cup']);
    // T and t differ by cooking convention: neither is guessed. Unknown units and no unit have no family.
    for (const u of ['T', 't', 'clove', 'pinch', 'handful', '', '  ', null]) expect(unitFamily(u), String(u)).toBeNull();
    expect(unitOf('Tbsps')).toEqual({ unit: 'tbsp', family: 'tsp', size: 14.787 });
  });

  it('is the toGrams tables: a unit has a family exactly when toGrams converts it (with a density for volumes)', () => {
    const n = node({ densityGPerMl: 1 });
    for (const u of ['g', 'mg', 'kg', 'oz', 'lb', 'ml', 'l', 'tsp', 'tbsp', 'cup', 'cups', 'clove', 'pinch', 'T', 'box']) {
      const grams = toGrams(2, u, n);
      expect(unitFamily(u) !== null, u).toBe(grams !== null);
      if (grams !== null) expect(grams.grams).toBeCloseTo(2 * unitOf(u)!.size);
    }
  });
});

describe('nutritionPerServing', () => {
  it('per serving math', () => {
    const r = nutritionPerServing(recipe('Simmer @lentil{200%g} in @water{500%ml}.'), graph);
    expect(r.perServing.protein_g).toBe(24.0);
    expect(r.estimated).toBe(false);
    expect(r.missing).toEqual([]);
    expect(Object.keys(r.perServing)).toHaveLength(7);
  });

  it('no NaN, ever', () => {
    const r = nutritionPerServing(
      recipe('Add @salt{} and @mystery{1%pinch} and @dragon fruit{1}.'),
      graph,
    );
    for (const v of Object.values(r.perServing)) expect(Number.isFinite(v)).toBe(true);
    expect(r.estimated).toBe(true);
    expect(r.missing).toEqual(['salt', 'mystery', 'dragon fruit']);
  });

  it('reports a resolved ingredient with no nutrient data as missing', () => {
    const g = IngredientGraph.fromData({ ingredients: [{ id: 'air', name: 'air' }] });
    const r = nutritionPerServing(recipe('Add @air{1%g}.'), g);
    expect(r.missing).toEqual(['air']);
    expect(r.estimated).toBe(true);
  });
});
