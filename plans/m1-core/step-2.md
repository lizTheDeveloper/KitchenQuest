# Step 2 — Recipe parsing and front-matter validation

**Files:**
- Create: `packages/core/src/recipe/types.ts`, `packages/core/src/recipe/parse.ts`, `packages/core/src/recipe/parse.test.ts`
- Modify: `packages/core/src/index.ts` (re-export)

**Interfaces:**
- Produces:
```ts
export type RecipeStatus = 'draft' | 'reviewed';
export interface RecipeMeta {
  title: string; country: string; region: string; credit: string; cook: string;
  difficulty: 1 | 2 | 3 | 4 | 5; skills: string[]; servings: number;
  license: string; status: RecipeStatus; sacred: boolean;
}
export interface RecipeIngredient { name: string; quantity: number | null; unit: string | null; note: string | null; }
export interface RecipeTimer { name: string | null; quantity: number | null; unit: string | null; }
export interface ParsedRecipe { meta: RecipeMeta; ingredients: RecipeIngredient[]; timers: RecipeTimer[]; source: string; }
export class RecipeError extends Error { problems: string[] }
export function parseRecipe(source: string): ParsedRecipe;   // throws RecipeError
```

**Parser facts (verified 2026-11-09 against `@cooklang/cooklang@0.19.1`):** `new CooklangParser().parse(text)` returns a tuple `[recipe, report]`. YAML front matter arrives typed in `recipe.rawMetadata` (a `Map`; arrays and numbers keep their types). `getFlatIngredients(recipe)` gives `{name, quantity, unit, displayText, note}`; `@salt{}` yields `quantity: null`. `getFlatTimers(recipe)` gives `{name, quantity, unit}` with `unit` as written (e.g. `"minutes"`). Create one parser per module, not per call.

- [ ] **2.1 Write failing tests** in `parse.test.ts`:
  - `parses front matter and ingredients`: a source with all required keys and the body `Rinse @moong dal{100%g}. Add @water{500%ml} and @salt{}. Simmer ~{20%minutes}.` → `meta.title === 'Parippu'`, `meta.skills` deep-equals the YAML list, `meta.sacred === false`, ingredients deep-equal `[{name:'moong dal',quantity:100,unit:'g',note:null},{name:'water',quantity:500,unit:'ml',note:null},{name:'salt',quantity:null,unit:null,note:null}]`, `timers[0]` equals `{name:null,quantity:20,unit:'minutes'}`.
  - `reports every missing key at once`: front matter with only `title` → throws `RecipeError` whose `problems` contains one entry each for `country, region, credit, cook, difficulty, skills, servings, license, status`.
  - `rejects bad values`: `difficulty: 7` → problem mentioning `difficulty`; `status: final` → problem mentioning `status`; `servings: 0` → problem mentioning `servings`; `skills: knife` (not a list) → problem mentioning `skills`.
  - `keeps the source`: `parseRecipe(src).source === src`.
- [ ] **2.2 Run** `npm test -w @kitchenquest/core`. Expected: FAIL (module not found).
- [ ] **2.3 Implement `parseRecipe(source: string): ParsedRecipe`** in `parse.ts`: parse with the official parser, validate `rawMetadata` against the Global Constraints list, collect all problems, then throw one `RecipeError` or return. Drop `displayText` from ingredients.
- [ ] **2.4 Run** tests. Expected: PASS.
- [ ] **2.5 Commit** `feat(core): parse Cooklang recipes and validate front matter`
