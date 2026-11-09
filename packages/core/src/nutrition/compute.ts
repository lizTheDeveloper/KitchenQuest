import type { IngredientGraph } from '../ingredients/graph';
import type { Nutrient } from '../ingredients/types';
import type { ParsedRecipe } from '../recipe/types';
import { toGrams } from './units';

export interface NutritionResult {
  perServing: Record<Nutrient, number>;
  estimated: boolean;
  missing: string[];
}

const NUTRIENTS: Nutrient[] = [
  'energy_kcal',
  'protein_g',
  'fat_g',
  'carb_g',
  'fiber_g',
  'sugars_g',
  'sodium_mg',
];

export function nutritionPerServing(recipe: ParsedRecipe, graph: IngredientGraph): NutritionResult {
  const totals = Object.fromEntries(NUTRIENTS.map((n) => [n, 0])) as Record<Nutrient, number>;
  const missing: string[] = [];
  let estimated = false;

  for (const ing of recipe.ingredients) {
    const id = graph.resolve(ing.name);
    const node = id === null ? null : graph.get(id);
    const per100g = node?.per100g;
    const weight = node ? toGrams(ing.quantity, ing.unit, node) : null;
    if (!node || !per100g || !weight) {
      missing.push(ing.name);
      estimated = true;
      continue;
    }
    if (weight.estimated) estimated = true;
    for (const n of NUTRIENTS) {
      const v = per100g[n];
      if (typeof v === 'number' && Number.isFinite(v)) totals[n] += (weight.grams * v) / 100;
    }
  }

  const servings = recipe.meta.servings;
  const divisor = Number.isFinite(servings) && servings > 0 ? servings : 1;
  const perServing = {} as Record<Nutrient, number>;
  for (const n of NUTRIENTS) {
    const r = Math.round((totals[n] / divisor) * 10) / 10;
    perServing[n] = Number.isFinite(r) ? r + 0 : 0; // +0 normalises -0
  }
  return { perServing, estimated, missing };
}
