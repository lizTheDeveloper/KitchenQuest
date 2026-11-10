# Step 5 — API: meal logs and pantry

The Pan's `propose_meal_log` and `propose_pantry_change` need somewhere real to write. These tables are pulled forward from M9 (`meal_logs`, C-23) and M5/M9 (`pantry_items`, H-11) in their minimal form: no nutrition numbers yet. They are sealed per user and row (C-3/C-4), meal logs need `health_data` consent, and both are in export and delete from day one. The REST routes are also the scripted engine's write path (Step 9), so they need `confirmed: true` exactly like rules.

**Files:**
- Create: `apps/api/src/meals/store.ts`, `apps/api/src/meals/service.ts`, `apps/api/src/meals/routes.ts`, `apps/api/src/pantry/store.ts`, `apps/api/src/pantry/service.ts`, `apps/api/src/pantry/routes.ts`, a generated migration `apps/api/drizzle/00NN_meals_pantry.sql`
- Modify: `apps/api/src/db/schema.ts`, `apps/api/src/app.ts` (register routes), `apps/api/src/consent/health-data.ts` (`HEALTH_TABLES` += `mealLogs`), `apps/api/src/db/schema.ts` `SELF_READ_RESOURCES` += `'meals'`, `'pantry'` (migration updates the check), `apps/api/src/account/routes.ts` (export `meals` and `pantry`, decrypted), `apps/api/test/architecture.test.ts` (`HEALTH_SCHEMA_EXPORTS` += `mealLogs`, `HEALTH_SQL_TABLES` += `meal_logs`), `docs/compliance/data-inventory.md` (H-7 and H-11 → "built M4", columns in §6, caps in §3.13)
- Test: `apps/api/test/meals.test.ts`, `apps/api/test/pantry.test.ts`, extend `apps/api/test/account.test.ts`

**Tables:**
- `meal_logs(id uuid pk, user_id → users cascade, eaten_on date not null, slot text not null check in MEAL_SLOTS, sealed bytea not null, created_at)`, with an index on `(user_id, eaten_on)`. `sealed` = `MealItem` (core), with context `{ table: 'meal_logs', userId, rowId }`. Date and slot stay plain (C-23 allows it; they are needed for queries).
- `pantry_items(id uuid pk, user_id → users cascade, sealed bytea not null, created_at)`. `sealed` = `PantryItem` (core), with context `{ table: 'pantry_items', userId, rowId }`. It is sealed although its basis is contract (H-11: contents can imply a diet; **[lawyer]** whether it needs `health_data`).

**Interfaces:**
- Consumes: `MealEntry`, `MealItem`, `PantryItem`, `MEAL_SLOTS` (Step 1); `lockLiveUser`, `lockConsentIn`, `sealFor`/`openFor`, `audit`, `countSelfRead` (M2).
- Produces:
```ts
// meals/service.ts
export const MEAL_DESCRIPTION_MAX = 200;
export async function createMealLogIn(tx: Tx, deps: { keyring: Keyring }, userId: string, meal: MealEntry, at: Date, requestId?: string): Promise<MealEntry & { id: string }>;
  // live user (401) → health_data consent (403) → validate (400) → seal → insert → audit 'meals.create'
export async function deleteMealLogIn(tx: Tx, userId: string, id: string, at: Date, requestId?: string): Promise<void>;   // 404 when not theirs; no consent needed (as rules)
export function validateMeal(meal: unknown, today: string, recipeSlugs: ReadonlySet<string>): string[];
// pantry/service.ts
export async function changePantryIn(tx: Tx, deps: { keyring: Keyring; catalog: Catalog }, userId: string,
  change: { add: PantryItem[]; removeNames: string[] }, at: Date, requestId?: string): Promise<{ items: (PantryItem & { id: string })[]; removed: (PantryItem & { id: string })[] }>;
  // removeNames match case-insensitively on name, or on ingredientId when the name resolves; unmatched names are ignored and reported as removed: []
export async function restorePantryIn(tx: Tx, deps, userId: string, removed: PantryItem[], addedIds: string[], at: Date): Promise<void>;   // for undo (Step 8)
```
- Routes:
  - `GET /meals?from=YYYY-MM-DD&to=YYYY-MM-DD` → `{ meals: (MealEntry & { id })[] }`. The range is at most 31 days, `from ≤ to`. Counts a self-read `'meals'`. Needs no consent (kept data stays readable after a "keep" withdrawal, as rules).
  - `POST /meals { meal: MealEntry, confirmed: true }` → 201 `{ meal }`. Missing or false `confirmed` → 400 `confirmation_required`.
  - `DELETE /meals/:id` → 204.
  - `GET /pantry` → `{ items }`. Counts a self-read `'pantry'`.
  - `POST /pantry/changes { add: PantryItem[], removeNames: string[], confirmed: true }` → 200 `{ items, removed }`. Light confirmation per §7.0, but still an explicit flag.
- Meal validation, returning problem strings:
  - `eatenOn` is a valid date within `[today − 7, today + 1]`, where `today` comes from the injected clock as in M2's ±1 day ruling.
  - `slot` ∈ `MEAL_SLOTS`.
  - A dish `slug` exists in `canon_recipes`, and `servings` is a finite number in `[0.25, 10]`.
  - A free `description` is 1–200 characters after trim.
  - A pantry `name` is 1–80 characters. `ingredientId` is null or `graph.has(id)`. At most `MAX_PANTRY_ITEMS` (300) items per user.
- Lock order for pantry: `lockLiveUser` → `pg_advisory_xact_lock(hashtextextended('pantry:' || userId, 0))`, so the cap is strict, as Step 3 does for rules.
- Withdrawing `health_data` with "delete" deletes meal logs (via `HEALTH_TABLES`). Pantry stays.

- [ ] **5.1 Write the failing tests:**
```ts
test('a meal log round-trips sealed: the column holds no plaintext', async () => {
  // POST free meal 'toast with peanut butter' → 201; GET /meals today → it; raw meal_logs.sealed bytes contain no 'peanut'
});
test('meal needs confirmed: true and health_data consent', ...);   // missing → 400 confirmation_required; no consent → 403 consent_required; nothing stored
test('meal validation', ...);   // unknown slug, servings 0 / 11, description 201 chars, eatenOn today+2 → 400 with problems; nothing stored
test('another user\'s meal id → 404 on delete', ...);
test('withdraw health_data with delete removes meal logs, keeps pantry', ...);
test('pantry add, remove by name, cap at 300 under concurrency', ...);   // 299 items + two concurrent adds of 1 → one 200, one 400 too_many_items; final 300
test('"milk" removes the item named Milk; an unmatched name changes nothing', ...);
test('export includes meals and pantry decrypted; delete leaves no meal_logs or pantry_items row', ...);
test('C-9: a meal POST leaves no "peanut" in the captured logs', ...);
test('inventory test passes with the new columns', ...);   // existing N-8 test; fails until data-inventory.md §6 lists them
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/api -- meals pantry account inventory architecture` → FAIL.
- [ ] **5.3 Implement.** Generate the migration with `drizzle-kit generate`. Add `too_many_items` (400) beside `too_many_rules` in `errors.ts`'s documentation comment.
- [ ] **5.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **5.5 Commit** `feat(api): sealed meal logs and pantry, consented, confirmed, exported and deleted`
