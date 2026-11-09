# Step 8 — Safety property test

**Files:**
- Create: `packages/core/test/safety.property.test.ts`

**Interfaces:**
- Consumes: `IngredientGraph` + seed data (Step 7), `check`, `Rule`, `Substitution` (Steps 4–5).

The spec's core promise (§12): **a recipe containing an ingredient under an active avoid rule can never come back `ok`.**

- [ ] **8.1 Write the property tests** with `fast-check` over the real seed graph:
  - `avoid rule never ok`: arbitrary non-empty subset of graph ingredient ids → a recipe built from them (generated Cooklang `@name{1%g}` lines with valid front matter); arbitrary target id picked from the ancestors of one included ingredient; arbitrary severity. Assert `check(...).status !== 'ok'`, and when the status is `swap`, every swap's `toId` has no `pathTo` any active target.
  - `severe always carries the disclaimer`: any recipe + any active rule with severity in `SEVERE` → `disclaimer === DISCLAIMER`.
  - `inactive rules change nothing`: for any recipe, adding a rule whose phase ended before the check date gives the same result as no rules.
  - Run with `numRuns: 500`.
- [ ] **8.2 Run** `npm test -w @kitchenquest/core`. Expected: PASS. If fast-check finds a counterexample, fix `check` (Step 5 code) and add the shrunk counterexample as a named example test in `check.test.ts`.
- [ ] **8.3 Final verification** from the repo root: `npm test && npm run typecheck && npm run build -w @kitchenquest/game`, all green.
- [ ] **8.4 Commit** `test(core): safety property tests for the rules engine`
