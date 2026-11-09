import { describe, expect, it } from 'vitest';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import { parseRecipe } from '../recipe/parse';
import { nutritionPerServing } from './compute';
import { toGrams } from './units';

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
