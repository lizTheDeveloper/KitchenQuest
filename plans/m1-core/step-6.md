# Step 6 — Nutrition

**Files:**
- Create: `packages/core/src/nutrition/units.ts`, `packages/core/src/nutrition/compute.ts`, `packages/core/src/nutrition/nutrition.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ParsedRecipe` (Step 2), `IngredientGraph`, `IngredientNode`, `Nutrient` (Step 3).
- Produces:
```ts
export function toGrams(quantity: number | null, unit: string | null, node: IngredientNode): { grams: number; estimated: boolean } | null;
export interface NutritionResult {
  perServing: Record<Nutrient, number>;   // every nutrient present, rounded to 1 decimal
  estimated: boolean;                      // any default/missing used
  missing: string[];                       // ingredient names that contributed nothing
}
export function nutritionPerServing(recipe: ParsedRecipe, graph: IngredientGraph): NutritionResult;
```

**Unit table (case-insensitive, singular/plural alike):** mass `g`, `kg`=1000, `mg`=0.001, `oz`=28.3495, `lb`=453.592. Volume (needs `densityGPerMl`): `ml`, `l`=1000, `tsp`=4.929, `tbsp`=14.787, `cup`=236.588. Unitless count → `gramsPerUnit`. Null quantity → `defaultGrams` with `estimated: true`. Anything else → `null`.

- [ ] **6.1 Write failing tests:**
  - `toGrams`: `(100,'g')` → `{grams:100, estimated:false}`; `(2,'tbsp')` with density 0.92 → grams ≈ 27.21; `(1,'cup')` with no density → `null`; `(2,null)` with `gramsPerUnit: 50` → 100; `(null,null)` with `defaultGrams: 2` → `{grams:2, estimated:true}`; `(1,'pinch')` → `null`.
  - `per serving math`: 200 g lentils (per100g protein 24) + 500 ml water (density 1, all zero), servings 2 → `protein_g` 24.0, `estimated: false`, `missing []`.
  - `no NaN, ever` (Review Focus 5): a recipe with `@salt{}` (no default), `@mystery{1%pinch}`, `@dragon fruit{1}` (unresolved) → every `perServing` value is a finite number, `estimated: true`, and `missing` lists all three names.
- [ ] **6.2 Run.** Expected: FAIL.
- [ ] **6.3 Implement** `toGrams` and `nutritionPerServing`. An ingredient that resolves but has no `per100g` goes in `missing`.
- [ ] **6.4 Run.** Expected: PASS.
- [ ] **6.5 Commit** `feat(core): per-serving nutrition with explicit estimates`
