# Step 5 — Ingredient search and allergy/diet rules

**Files:**
- Modify: `packages/core/src/ingredients/graph.ts` (+ test) — add `search(query: string, limit = 10): { id: string; name: string; matched: string }[]` (normalized prefix match on names and aliases first, then substring; deterministic order: prefix before substring, then name asc; empty query → []).
- Create: `apps/api/src/catalog.ts` (loads `data/ingredients.json` + `data/substitutions.json` once, builds the graph, validates substitutions — boot fails loudly on bad data), `apps/api/src/rules/routes.ts`, `apps/api/test/rules.test.ts`

**Routes:**
- `GET /ingredients/search?q=` → `{ results: [...] }` (no auth needed).
- `GET /rules` → `{ rules: Rule[] }` (decrypted, `id` = row id).
- `POST /rules { rule: Omit<Rule,'id'>, confirmed: true }` → 201 `{ rule }`.
- `PUT /rules/:id { rule, confirmed: true }` → 200. `DELETE /rules/:id` → 204 (deleting needs no confirmation: it only makes the player less restricted in the app, and the UI asks; record this in the route comment).
- Validation: run core `validateRules([ {...rule, id} , ...otherRulesOfUser ], graph)`; any problems → 400 `bad_request` with `details.problems` = core's strings. Missing/false `confirmed` → 400 `confirmation_required`.
- Storage: `seal(ruleWithoutId, dataKey, dataKeyId)`.

- [ ] **5.1 Tests:** search (`'scal'` finds green onion via alias; `''` → []); CRUD round trip; `confirmed` missing → 400 `confirmation_required` and nothing stored; unknown target id, inverted phase, bad enum → 400 with core problems (Review Focus 4); the `rules.sealed` column contains no plaintext target id (search the raw bytes for `"peanut"`) (Review Focus 3); another user's rule id → 404 on GET-by-list absence, PUT and DELETE (Review Focus 1).
- [ ] **5.2 Run** → FAIL. **5.3 Implement.** **5.4 Run** → PASS (root).
- [ ] **5.5 Commit** `feat: ingredient search; encrypted, confirmed allergy and diet rules`
