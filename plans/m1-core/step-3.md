# Step 3 — Ingredient graph

**Files:**
- Create: `packages/core/src/ingredients/types.ts`, `packages/core/src/ingredients/graph.ts`, `packages/core/src/ingredients/graph.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Produces:
```ts
export type Nutrient = 'energy_kcal' | 'protein_g' | 'fat_g' | 'carb_g' | 'fiber_g' | 'sugars_g' | 'sodium_mg';
export interface IngredientNode {
  id: string;                 // snake_case, unique
  name: string;
  aliases?: string[];
  isA?: string[];             // e.g. cashew → ['tree_nut']
  contains?: string[];        // e.g. soy_sauce → ['wheat', 'soy']
  labelDependent?: boolean;   // store-bought compound; contents vary by brand
  per100g?: Partial<Record<Nutrient, number>>;
  densityGPerMl?: number;     // for volume units
  gramsPerUnit?: number;      // for unitless counts ("2 eggs")
  defaultGrams?: number;      // for "to taste" / no quantity
  fdcId?: number;             // USDA FoodData Central id (provenance)
}
export interface IngredientData { ingredients: IngredientNode[] }
export class IngredientGraph {
  static fromData(data: IngredientData): IngredientGraph;   // throws on bad data
  resolve(name: string): string | null;                      // id or null
  get(id: string): IngredientNode;                            // throws on unknown id
  has(id: string): boolean;
  pathTo(fromId: string, targetId: string): string[] | null; // ids from→target inclusive, via isA ∪ contains; [fromId] when equal
}
```

- [ ] **3.1 Write failing tests** with a small inline fixture (`green_onion` with aliases `scallion, spring onion`; `cashew` isA `tree_nut`; `tree_nut` isA `nut`; `soy_sauce` contains `wheat, soy`; `worcestershire` contains `anchovy`; `anchovy` isA `fish`):
  - `resolves names people actually write`: `'Spring Onions '`, `'SCALLION'`, `'green onions'` → `'green_onion'`; `'tomatoes'` resolves when the fixture has `tomato`; `'dragon fruit'` → `null`.
  - `finds paths through isA and contains`: `pathTo('cashew','nut')` → `['cashew','tree_nut','nut']`; `pathTo('worcestershire','fish')` → `['worcestershire','anchovy','fish']`; `pathTo('cashew','fish')` → `null`; `pathTo('soy_sauce','soy_sauce')` → `['soy_sauce']`.
  - `fails loudly on bad data` (Review Focus 2): a cycle (`a` isA `b`, `b` isA `a`) throws a message containing `cycle` and `a`; an `isA` to an unknown id throws containing that id; the same alias on two ingredients throws containing the alias; a duplicate id throws containing the id.
- [ ] **3.2 Run.** Expected: FAIL.
- [ ] **3.3 Implement `IngredientGraph`.** Normalize names as lowercase, trimmed, with internal whitespace collapsed. Look up exact name or alias first, then retry with a trailing `es`, then `s`, removed. `pathTo` is BFS over `isA ∪ contains`. Detect cycles at load with DFS over the same edges.
- [ ] **3.4 Run.** Expected: PASS.
- [ ] **3.5 Commit** `feat(core): ingredient graph with alias resolution and path finding`
