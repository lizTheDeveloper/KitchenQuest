# Step 6 — API: meal plans, market runs and dated pantry

The week's records: one plan per plan week, the market run built from it, and pantry items that remember when they came home. Plans and runs are sealed like the pantry (H-11, Ruling 18). They are contract basis, not in `HEALTH_TABLES`, and deleted 8 weeks after their week ends. Every save needs `confirmed: true`, exactly like rules and meals. These routes are also the scripted engine's write path (Step 10) and the write behind Step 8's plan card.

**Files:**
- Create:
  - `apps/api/src/week/store.ts`, `apps/api/src/week/plan-service.ts`, `apps/api/src/week/market-service.ts`, `apps/api/src/week/routes.ts`;
  - a generated migration `apps/api/migrations/0013_week.sql`.
- Modify:
  - `apps/api/src/db/schema.ts`: `mealPlans`, `marketRuns`; `SELF_READ_RESOURCES` += `'plans'`;
  - `apps/api/src/db/advisory-locks.ts`: `plan: 4`;
  - `apps/api/src/pantry/service.ts`: `changePantryIn` accepts and seals `addedOn` and `source`, and validates `addedOn` within `[today − 60, today + 1]`;
  - `apps/api/src/jobs/retention.ts`: `registerRetention` for plans and runs (`PLAN_RETENTION_WEEKS`);
  - `apps/api/src/app.ts`;
  - `apps/api/src/account/routes.ts`: export `plans` and `marketRuns`, decrypted;
  - `apps/api/src/errors.ts`: `plan_invalid` (400), `run_closed` (409);
  - `docs/compliance/data-inventory.md`: H-11 becomes built M5 with the new tables, the §3.13 caps, the §6 columns, and the retention row.
- Test: `apps/api/test/week.test.ts`; extend `apps/api/test/pantry.test.ts`, `apps/api/test/retention.test.ts` and `apps/api/test/account.test.ts`.

**Tables:**
- `meal_plans(id uuid pk, user_id → users cascade, week_start date not null, sealed bytea not null, created_at, updated_at)`, with a `unique (user_id, week_start)`. The `sealed` field is core's `Plan` minus `weekStart`, with AAD `{ table: 'meal_plans', userId, rowId }`. `week_start` stays plain: it is needed for the query and the retention job, and it is a date only.
- `market_runs(id uuid pk, user_id → users cascade, plan_id → meal_plans cascade, sealed bytea not null, done_at timestamptz null, created_at)`, with a `unique (plan_id)`. The `sealed` field is `{ items: ListItem[], pantryIds: Record<key, pantryItemId> }`, with AAD `{ table: 'market_runs', userId, rowId }`.

**Interfaces:**
- Consumes: `validatePlan`, `checkPlan`, `marketList`, `Plan`, `ListItem`, `planWeekStart`, `MAX_PLAN_ITEMS` (Step 3); `changePantryIn`, `restorePantryIn`, `loadPantry` (M4); `getProfile` market days (M2); `sealFor`/`openFor`, `lockLiveUser`, `audit`.
- Produces:
```ts
// week/plan-service.ts
export async function savePlanIn(tx: Tx, deps: { keyring: Keyring; catalog: Catalog; recipes: RecipeIndex }, userId: string,
  plan: Plan, at: Date, requestId?: string): Promise<{ plan: Plan & { id: string }; previous: Plan | null }>;
  // lockLiveUser → advisory plan: → validatePlan (400 plan_invalid with problems) → upsert by week_start → audit 'plan.save'
  // the server re-runs checkPlan with the player's rules: a ⛔ dish, a sacred or unknown slug → 400 plan_invalid ('blocked: <slug>'),
  // so a stored plan never holds a dish that was blocked when it was saved
export async function restorePlanIn(tx: Tx, deps, userId: string, weekStart: string, previous: Plan | null, at: Date): Promise<void>; // undo (Step 8)
export async function loadPlan(db, keyring, userId: string, weekStart: string): Promise<(Plan & { id: string }) | null>;
// week/market-service.ts
export async function openRunIn(tx, deps, userId, weekStart, at): Promise<MarketRunView>;          // builds the list from plan − pantry; idempotent per plan
export async function tickIn(tx, deps, userId, runId, key: string, ticked: boolean, at: Date): Promise<MarketRunView>;
  // ticked → pantry add { name, ingredientId, addedOn: today, source: 'market' } (Ruling 16), id remembered in the run;
  // unticked → removes exactly that pantry id (never a same-name item, M4 undo rule); after done_at → 409 run_closed
export async function finishRunIn(tx, deps, userId, runId, at): Promise<MarketRunView>;            // sets done_at once; the client then posts `market_run`
export interface MarketRunView { id: string; weekStart: string; items: ListItem[]; doneAt: string | null }
```
- Routes (all JSON bodies; nothing about food in a URL, P-5):
  - `GET /plans/current` → `{ plan | null, weekStart, checks: PlanItemCheck[] }`. `weekStart` comes from the profile's market days and the injected clock. The checks are computed now with the player's current rules, because a stored plan never stores a status. It counts a self-read `'plans'`.
  - `PUT /plans/:weekStart { plan, confirmed: true }` → 200 `{ plan, checks }`. Missing `confirmed` → 400 `confirmation_required`.
  - `DELETE /plans/:weekStart` → 204.
  - `POST /market-runs { weekStart }` → 200 `MarketRunView`.
  - `POST /market-runs/:id/ticks { key, ticked }` → 200. This is §7.0's "None (undoable)", so no `confirmed` flag; unticking is the undo.
  - `POST /market-runs/:id/finish { confirmed: true }` → 200.
- `PUT /plans` rejects, as `plan_invalid`:
  - a ⛔ item for the player's active rules on that item's date;
  - a sacred or unknown slug;
  - more than `MAX_PLAN_ITEMS` items;
  - a `weekStart` that isn't `planWeekStart` of itself for the player's market days.

  A ❓ dish may be saved (the player chose it knowing). The plan view always shows it as ❓, never ✅.
- A rule change after a plan was saved never edits the plan. `GET /plans/current` simply shows the item as ⛔ with `plan.blocked_dish`, and the market list for a newly blocked dish is rebuilt without it on the next `openRunIn`.
- Lock order: user → `pantry:` (for tick) → `plan:` → data rows, matching the README order (`pantry:` before `plan:`).

- [ ] **6.1 Write the failing tests:**
```ts
test('a plan round-trips sealed: meal_plans.sealed holds no slug in plaintext', ...);
test('PUT /plans needs confirmed: true; a blocked dish → 400 plan_invalid naming it; a ❓ dish saves and reads back as unverified', ...);
test('a rule added after saving shows the item as blocked in GET /plans/current; the stored plan is unchanged', ...);
test('weekStart must match the player\'s market day (Sat market → a Saturday)', ...);
test('market run: list = plan ingredients − pantry, by stall; ticking adds a dated market pantry item; unticking removes that id only', ...);
test('a pantry "milk" already there survives tick → untick of a listed milk', ...);
test('finish twice → one done_at; tick after finish → 409 run_closed', ...);
test('retention: plans and runs older than 8 weeks after week end are deleted; this week\'s stay', ...);
test('export has plans and market runs decrypted; DELETE /me leaves neither; health_data delete keeps them (not HEALTH_TABLES)', ...);
test('pantry addedOn outside [today−60, today+1] → 400; M4 rows without addedOn still load', ...);
test('C-9: plan and tick requests leave no ingredient or slug in captured logs', ...);
```
- [ ] **6.2 Run** `npm test -w @kitchenquest/api -- week pantry retention account inventory` → FAIL.
- [ ] **6.3 Implement.** Generate the migration. `openRunIn` uses core `marketList` and nothing else to decide the list.
- [ ] **6.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **6.5 Commit** `feat(api): sealed weekly plans and market runs, dated pantry, 8-week retention`
