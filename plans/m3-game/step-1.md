# Step 1 — Core: recipe steps, timer durations, browser-safe entry

Cook mode needs the method one step at a time, with ingredients and timers in place. `ParsedRecipe` today has only flat `ingredients` and `timers`. The game must not ship the Cooklang WASM, because recipes are parsed at build time (Step 4). So core also needs an entry point that leaves `parseRecipe` out.

**Files:**
- Modify: `packages/core/src/recipe/types.ts`, `packages/core/src/recipe/parse.ts`, `packages/core/src/index.ts`, `packages/core/package.json` (add `"exports": { ".": "./src/index.ts", "./engine": "./src/engine.ts" }`)
- Create: `packages/core/src/recipe/timers.ts`, `packages/core/src/recipe/steps.ts`, `packages/core/src/engine.ts`
- Test: `packages/core/src/recipe/steps.test.ts`, `packages/core/src/recipe/timers.test.ts`, `packages/core/src/engine.test.ts`

**Interfaces:**
- Produces:
```ts
// recipe/types.ts
export type StepItem =
  | { type: 'text'; value: string }
  | { type: 'ingredient'; index: number }   // index into ParsedRecipe.ingredients
  | { type: 'cookware'; name: string }
  | { type: 'timer'; index: number };       // index into ParsedRecipe.timers
export interface RecipeStep { section: string | null; items: StepItem[] }
export interface ParsedRecipe { meta; ingredients; timers; steps: RecipeStep[]; source }   // + steps
// recipe/timers.ts
export function timerSeconds(timer: RecipeTimer): number;   // throws RecipeError naming the timer
// recipe/steps.ts
export function stepPlainText(recipe: ParsedRecipe, step: RecipeStep): string;
// engine.ts: re-exports everything index.ts exports EXCEPT parseRecipe (and nothing that imports @cooklang/cooklang)
```
- Timer units (case-insensitive): `s, sec, secs, second, seconds` ×1; `m, min, mins, minute, minutes` ×60; `h, hr, hrs, hour, hours` ×3600. A null quantity, a quantity ≤ 0 or any other unit throws.
- Steps come from `recipe.sections[].content` items of type `step`, in order. Text content blocks are dropped. An `inlineQuantity` item becomes a `text` item holding the quantity as written.
- `stepPlainText` joins the items. An ingredient renders as `displayName ?? name`, cookware as its name, a timer as `(20 minutes)`, or `(boil: 10 minutes)` when the timer has a name. Whitespace runs collapse to one space and the result is trimmed.

- [ ] **1.1 Tests** (`steps.test.ts`, on the real canon files read from `recipes/`):
```ts
test('parippu has 7 steps, onigiri 8', () => {
  expect(parse('india/kerala/parippu').steps).toHaveLength(7);
  expect(parse('japan/osaka/onigiri').steps).toHaveLength(8);
});
test('step items point at the flat lists', () => {
  const r = parse('india/kerala/parippu');
  const ing = r.steps[0].items.find((i) => i.type === 'ingredient')!;
  expect(r.ingredients[(ing as { index: number }).index].name).toBe('split moong dal');
  const tim = r.steps[1].items.find((i) => i.type === 'timer')!;
  expect((tim as { index: number }).index).toBe(0);
});
test('stepPlainText renders a step', () => {
  const r = parse('india/kerala/parippu');
  expect(stepPlainText(r, r.steps[1])).toBe(
    'Put the dal in a pot with water, turmeric and green chillies, slit lengthways. Simmer, part-covered, until soft enough to crush against the side with a spoon. Add a splash more water if it gets thick. (20 minutes)');
});
test('every ingredient and timer is referenced by exactly one step item', ...) // for all three canon recipes
```
`timers.test.ts`: `timerSeconds({name:null, quantity:30, unit:'seconds'}) === 30`; `{20,'minutes'} === 1200`; `{2,'hours'} === 7200`; `{1,'Min'} === 60`; `{5, null}` throws, with a message containing `timer`; `{3,'fortnight'}` throws; `{null,'minutes'}` throws; every timer in the three canon recipes converts.
`engine.test.ts`: `import * as engine from '../src/engine'`. Assert `'parseRecipe' in engine === false`, and that `check`, `nutritionPerServing`, `IngredientGraph`, `DISCLAIMER`, `validateRules`, `timerSeconds`, `stepPlainText` are present. Assert that `engine.ts` and every file it imports (walk the relative imports with a regex over the sources) never contain `@cooklang/cooklang`.
- [ ] **1.2 Run** `npm test -w @kitchenquest/core` → FAIL (steps undefined, modules missing).
- [ ] **1.3 Implement** `steps` in `parseRecipe` (map the WASM `Section`/`Step`/`Item` types), `timers.ts`, `steps.ts`, `engine.ts`. Export `timerSeconds`, `stepPlainText`, `RecipeStep` and `StepItem` from both `index.ts` and `engine.ts`.
- [ ] **1.4 Run** `npm test -w @kitchenquest/core && npm run typecheck -w @kitchenquest/core` → PASS. Also run `npm test -w @kitchenquest/api` if `TEST_DATABASE_URL` is set: the API must still build against the new `ParsedRecipe`.
- [ ] **1.5 Commit** `feat(core): recipe steps, timer durations, browser-safe engine entry`
