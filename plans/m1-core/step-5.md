# Step 5 — Recipe check and swaps

**Files:**
- Create: `packages/core/src/rules/check.ts`, `packages/core/src/rules/check.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `ParsedRecipe` (Step 2), `IngredientGraph` (Step 3), `Rule`, `isActive`, `SEVERE` (Step 4).
- Produces:
```ts
export type CheckStatus = 'ok' | 'swap' | 'blocked' | 'unverified';
export interface Substitution { from: string; to: string; note?: string }   // ingredient ids
export interface Finding {
  ingredient: string;                 // name as written in the recipe
  ingredientId: string | null;
  kind: 'match' | 'unresolved' | 'label';
  status: Exclude<CheckStatus, 'ok'>;
  ruleId?: string; severity?: Severity;
  path?: string[];                    // e.g. ['worcestershire','anchovy','fish']
  swap?: { toId: string; toName: string; note?: string };
}
export interface CheckResult { status: CheckStatus; findings: Finding[]; severe: boolean; disclaimer: string | null; }
export const DISCLAIMER = "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.";
export function check(recipe: ParsedRecipe, rules: Rule[], graph: IngredientGraph, subs: Substitution[], date: string): CheckResult;
```

**Behavior (decided here; the tests pin it):**
- Only active rules count. `prefer` never produces findings.
- An `avoid` rule matches ingredient id X when `graph.pathTo(X, t)` is non-null for some target `t`.
- A `limit` rule matches like `avoid` only when the per-serving quantity (`quantity / meta.servings`) is above `limit.amount` and the ingredient's unit equals `limit.unit`. If the units differ or the quantity is null, it gives a `label`-kind `unverified` finding. `per: 'day'` is ignored in M1 because it needs the meal log.
- Swap: for a matched ingredient, take `subs` with `from === X` in order. Offer the first whose `to` would itself produce no findings under the same rules (it neither matches any active rule nor is label-dependent while any rule is active). Matched with a swap → finding status `swap`; without one → `blocked`.
- An unresolved ingredient name → `unresolved` finding, status `unverified` (always, even with no rules).
- A `labelDependent` ingredient → `label` finding, status `unverified`, only when at least one active `avoid`/`limit` rule exists and it didn't already match.
- Overall status is the worst finding by `blocked` > `unverified` > `swap`; otherwise `ok`.
- `severe` and `disclaimer` (= `DISCLAIMER`) are set when any active rule has a severe severity, whatever the outcome.

- [ ] **5.1 Write failing tests** using the Step 3 fixture plus `tamari` (contains `soy`), `coconut_milk` isA `coconut`, `curry_paste` (`labelDependent`), and substitutions `soy_sauce→tamari`, `soy_sauce→coconut_aminos`:
  - `ok with no rules`: a resolved recipe → `status 'ok'`, `findings []`, `disclaimer null`.
  - `blocks through hidden ingredients`: a severe `fish` avoid rule + Worcestershire → `blocked`, finding path `['worcestershire','anchovy','fish']`, `disclaimer === DISCLAIMER`.
  - `offers a passing swap`: a wheat avoid rule + soy sauce → `swap` to `tamari`.
  - `never offers a swap that breaks another rule` (Review Focus 4): wheat **and** soy avoid rules + soy sauce → swap is `coconut_aminos`, not `tamari`; remove `coconut_aminos` from subs → `blocked`.
  - `unknown ingredient is never ok`: no rules + `@dragon fruit{1}` → `unverified`, kind `unresolved`.
  - `label-dependent only matters under rules`: curry paste with no rules → `ok`; with any active avoid rule that doesn't match it → `unverified`, kind `label`.
  - `inactive phase is ignored`: a fish rule whose phase ended yesterday + Worcestershire → `ok`.
  - `precedence`: one blocked and one unresolved ingredient → `blocked`; one swap and one unresolved → `unverified`.
  - `limit per serving`: `limit {amount:5, unit:'g', per:'serving'}` on salt, servings 2: `@salt{8%g}` → no finding; `@salt{12%g}` → `blocked`; `@salt{1%tsp}` → `unverified` (unit mismatch).
- [ ] **5.2 Run.** Expected: FAIL.
- [ ] **5.3 Implement `check`** per the behavior above. Keep swap search in a private `findSwap` helper in the same file.
- [ ] **5.4 Run.** Expected: PASS.
- [ ] **5.5 Commit** `feat(core): deterministic recipe check with re-checked swaps`
