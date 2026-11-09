# Step 8 — End-to-end safety test

**Files:** Create `apps/api/test/e2e.safety.test.ts`

One scripted journey through the real app with the real canon and seed data:
1. Request + verify sign-in (new user, `ageConfirmed: true`).
2. `PUT /profile` market day Saturday.
3. `GET /ingredients/search?q=coconut` → pick `coconut`.
4. `POST /rules` severe coconut avoid **without** `confirmed` → 400; with `confirmed: true` → 201.
5. `GET /recipes` → parippu `blocked` with disclaimer; for every recipe the API status equals core `check` run directly on the same recipe source with the same rules and date (the API adds no logic).
6. A second user sees none of user 1's rules and gets `ok` for parippu.
7. `GET /me/export` includes the rule; `DELETE /me` removes everything.
8. Free forever (spec §16): every step above runs for a user with **no** entitlements, and the test asserts `GET /me` shows `entitlements: []` at the start. No endpoint used above may consult entitlements.

- [ ] **8.1 Write it.** **8.2 Run** → PASS (it should, since Steps 3–7 exist; if not, fix the owning code and add a focused test there).
- [ ] **8.3 Final verification:** root `npm test`, `npm run typecheck`, `npm run build -w @kitchenquest/game`.
- [ ] **8.4 Commit** `test(api): end-to-end safety journey`

**Compliance amendments (C-11):** `POST /rules` without `health_data` consent → 403 `consent_required`, nothing stored; with consent → 201; withdrawing stops further writes; declining consent never blocks play (canon recipes and checks still work with no stored rules).
