# Step 6 — Recipe cards against the player's rules

The recipe shelf (`#/recipes`) and the recipe card (`#/recipe/<slug>`). Status comes only from core `check`, and nutrition only from `nutritionPerServing`. Both run in the browser on the build-time-parsed recipes, using the player's rules: device rules for now, and account rules once Step 11 fills `accountRules`.

**Files:**
- Create: `apps/game/src/recipes/rules.ts` (+ `rules.test.ts`), `apps/game/src/recipes/card-model.ts` (+ `card-model.test.ts`), `apps/game/src/recipes/card-view.ts`, `apps/game/src/recipes/recipes-screen.ts`, `apps/game/src/recipes/recipe-screen.ts`
- Test: `apps/game/e2e/recipes.e2e.test.ts`

**Interfaces:**
- Consumes: `content`, `graph` (Step 4); `PlayerState` (Step 3); `statusChip` (Step 3); `check`, `nutritionPerServing`, `validateRules`, `DISCLAIMER` from `@kitchenquest/core/engine`.
- Produces:
```ts
// recipes/rules.ts
export type RulesState =
  | { status: 'ready'; rules: Rule[]; source: 'device' | 'account' }
  | { status: 'error'; message: string };
export function activeRules(state: PlayerState, graph: IngredientGraph): RulesState;   // accountRules ?? localRules, then validateRules; problems → error
export function localDate(now: Date): string;                                          // the LOCAL calendar date, YYYY-MM-DD
// recipes/card-model.ts
export interface NutritionRow { nutrient: Nutrient; label: string; value: string }   // value e.g. '12 g', '480 mg', '310 kcal'
export interface RecipeCard {
  slug: string; title: string; country: string; region: string; credit: string; license: string;
  cook: { id: string; name: string }; skills: { id: string; name: string }[];
  draft: boolean; sacred: boolean;
  status: CheckStatus; findings: CardFinding[]; severe: boolean; disclaimer: string | null;
  rulesChecked: number; rulesError: string | null;
  cookable: boolean; notCookableReason: 'blocked' | 'sacred' | null;
  nutrition: { rows: NutritionRow[]; estimated: boolean; missing: string[] };
}
export interface CardFinding { ingredient: string; status: Exclude<CheckStatus, 'ok'>; path: string | null /* names joined ' → ' */; ruleNote: string | null; swapLabel: string | null /* 'swapped: neutral oil for ghee' */ }
export function buildRecipeCard(input: { slug: string; content: GameContent; graph: IngredientGraph; rules: RulesState; today: string; showCalories: boolean }): RecipeCard;
export function renderRecipeCard(card: RecipeCard, opts: { onCook(): void; headingLevel: 1 | 2 }): HTMLElement;   // card-view.ts
```
- Rules: `cookable = !sacred && status !== 'blocked'`. When `rules.status === 'error'`, `check` is not called. Instead: `status: 'unverified'`, `rulesError: message`, `findings: []`, `cookable: !sacred`, and the card shows: "Couldn't check this dish against your rules. Treat it as unchecked." (§2.2).
- The finding path maps each id through `graph.get(id).name`. `ruleNote` is the rule's `note`, the player's own words.
- Nutrition rows follow the order energy, protein, fat, carbohydrate, fiber, sugars, sodium. Energy is **omitted** unless `showCalories` (§5). Values are rounded to whole numbers. The "≈ estimate" label shows when `estimated` is true. When `missing` is non-empty, show "Not counted: …".
- Card view, in order:
  - title (h1 or h2) and "{region}, {country}"
  - "Taught by {cook name}" and the credit line
  - draft label "Draft — awaiting review by cooks from this tradition" when draft
  - status chip with a text label
  - "Checked against your {n} rule(s)", or when `n = 0`: "You haven't told the Bureau about any allergies or diet rules yet."
  - findings list
  - for severe: the disclaimer (always visible, not collapsible), plus `bureau.disclaimers.cross_contact`
  - for any `label` finding: `bureau.disclaimers.unverified`
  - nutrition `<table>` with `<caption>` "Per serving"
  - skills and license
  - the cook button
- The cook button "Cook it ▶" calls `onCook` and is enabled only when `cookable`. Blocked → a disabled button plus the text "This dish isn't cookable with your rules. It stays on your map." Sacred → no button, and "Shared as a story only."
- Shelf `#/recipes`: h1 "Recipe shelf". One entry per canon recipe (title, place, chip) linking to its card. The order is country then title.
- Card screen `#/recipe/<slug>`: an unknown slug → the not-found screen. Cook → `navigate({ name: 'cook', slug })`.

- [ ] **6.1 Tests:**
```ts
// rules.test.ts
test('localDate uses the local calendar date', () => {
  process.env.TZ = 'America/Los_Angeles';   // Node honours runtime TZ changes; restore it in afterEach
  expect(localDate(new Date('2026-03-02T07:30:00Z'))).toBe('2026-03-01');   // 23:30 local on 1 March
});
test('account rules win over device rules when present', ...);
test('rules core rejects → error state', ...);   // localRules: [{ target: { ids: ['not_an_id'] }, ... }] → status 'error', message includes 'not_an_id'
// card-model.test.ts: real content + graph, today '2026-11-09'
const coconutSevere = { id: 'r1', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
test('no rules: parippu ok and cookable', ...);              // status 'ok', rulesChecked 0, disclaimer null, cookable true, draft true
test('severe coconut: parippu blocked', ...);                // status 'blocked', cookable false, notCookableReason 'blocked', severe true, disclaimer === DISCLAIMER
test('ghee intolerance: parippu swap', ...);                 // status 'swap', cookable true, a finding with swapLabel 'swapped: <neutral_oil name> for ghee'
test('rules error: unverified, not blocked, not ok', ...);
test('calories hidden by default', ...);                     // showCalories false → no row 'energy_kcal'; true → first row is energy_kcal
test('sacred dish is never cookable', ...);                  // clone a recipe with meta.sacred = true → cookable false, reason 'sacred'
test('finding path uses names', ...);                        // coconut severe: grated coconut finding path contains ' → '
```
`recipes.e2e.test.ts`:
  - `#/recipes` lists 3 recipes, each with a chip.
  - Seed the severe coconut rule. On `#/recipe/india/kerala/parippu`: the chip text contains "blocked"; the page contains the exact disclaimer string; "Cook it" is disabled; "isn't cookable" is shown.
  - Without rules: "Cook it" is enabled and clicking it routes to `#/cook/india/kerala/parippu`.
  - "kcal" is absent by default and present after enabling Show calories in settings.
  - Seed rules with a bad id: "Couldn't check this dish" is shown and the chip is ❓.
  - `#/recipe/nope/nope` → not-found.
  - `expectNoA11yViolations` on the shelf and on the card.
  - `apps/game/dist` contains no `.wasm` file (`readdirSync` recursive).
- [ ] **6.2 Run** `npm test -w @kitchenquest/game -- recipes` and `npm run test:e2e -w @kitchenquest/game -- e2e/recipes.e2e.test.ts` → FAIL.
- [ ] **6.3 Implement**, and register the two screens.
- [ ] **6.4 Run** both → PASS.
- [ ] **6.5 Commit** `feat(game): recipe shelf and recipe cards checked against the player's rules`
