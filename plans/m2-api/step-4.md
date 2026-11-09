# Step 4 — Profile

**Files:** Create `apps/api/src/profile/routes.ts`, `apps/api/test/profile.test.ts`

- `GET /profile` → the profile (created empty on first read): `{ marketDays: number[] (0=Sunday…6), mealsPerWeek: number|null, country: string|null, region: string|null, mealWindows: { name: string; start: "HH:MM"; end: "HH:MM" }[] }`.
- `PUT /profile` with the same shape (all fields optional; omitted fields unchanged) → the updated profile.
- Validation: `marketDays` unique integers 0–6; `mealsPerWeek` 0–42; `country`/`region` ≤ 80 chars; meal windows ≤ 8, times `HH:MM` 24h with `start < end`, names ≤ 40 chars.

- [ ] **4.1 Tests:** requires auth (401); first GET returns defaults; PUT then GET round-trips; each validation rule → 400 `bad_request` with the field named in details; users can't see each other's profile.
- [ ] **4.2 Run** → FAIL. **4.3 Implement.** **4.4 Run** → PASS.
- [ ] **4.5 Commit** `feat(api): player profile`
