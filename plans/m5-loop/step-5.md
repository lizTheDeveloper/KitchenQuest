# Step 5 — API: progress events and reward grants

The server half of Ruling 7. The game posts progress events, the content-free facts of play. The API validates each against the catalogue and computes the grants with core `grantsFor`, then stores both. Grants are append-only and nothing but account delete removes them (§6, never rule 6). The API is blind to entitlements by construction (never rule 3), and the step pins that with a test.

**Files:**
- Create:
  - `apps/api/src/progress/store.ts`: `loadHistory`, `insertEvents`;
  - `apps/api/src/progress/service.ts`: `recordEventsIn`;
  - `apps/api/src/progress/routes.ts`;
  - `apps/api/src/progress/catalogue.ts`: builds core's `Catalogue` from the `RecipeIndex`, the `content/` quests and frames, and `data/`;
  - `apps/api/src/recipes/recipe-index.ts` (C7): `RecipeIndex`, `createRecipeIndexSource`, consumed by Steps 6, 7 and 8;
  - the next generated migration (`drizzle-kit generate`; never a hand-picked number, C6).
- Modify:
  - `apps/api/src/db/schema.ts`: `progressEvents`, `rewardGrants`; `SELF_READ_RESOURCES` += `'progress'` (the migration updates its check);
  - `apps/api/src/db/advisory-locks.ts`: `progress: 5` (a new number, never reused; `plan: 4` is Step 6's);
  - `apps/api/src/catalog.ts` (C10): a new `loadLoopContent(catalog, dataDir?, contentDir?)` / `defaultLoopContent()` beside `loadCatalog`, loading and validating at boot `data/rewards.yaml` (`validateRewards`), `data/techniques.yaml` (`validateTechniques`, thresholds), the `content/cooks/*.yaml` quests and cook ids, the `content/market/*.yaml` stall ids, `content/frames/*.yaml` (`validateFrames`), `data/stalls.json` (`StallMap`), `data/food-groups.json` (`FoodGroups`) and `data/keeps.json` (`KeepsMap`), every id checked against `catalog.graph`; `validateQuests` runs with those cook and stall ids. The server refuses to start on bad data, naming the file, like rule terms. The existing `Catalog` interface is unchanged;
  - `apps/api/src/app.ts`: register the routes;
  - `apps/api/src/account/routes.ts`: export `progress: { events, grants, view }`;
  - `apps/api/test/architecture.test.ts`: `apps/api/src/progress/**` and core `progress/` import nothing from `entitlements`, `usage`, `rules` or `consent`; no route under `rules/` or `consent/` imports `progress`;
  - `docs/compliance/data-inventory.md`: U-5 becomes "built M5" with the real tables, plus §6 columns.
- Test: `apps/api/test/progress.test.ts`, and extend `apps/api/test/account.test.ts` and `apps/api/test/architecture.test.ts`.

**Tables:**
- `progress_events(id uuid pk, user_id → users cascade, client_id text not null, kind text not null check in PROGRESS_KINDS, at date not null, body jsonb not null, created_at)`, with a `unique (user_id, client_id)` and an index on `(user_id, at)`. The `body` holds only ids and numbers from the `ProgressEvent` shape: zod `.strict()`, strings checked against the catalogue, so no free text can land in it. It is plain, on the contract basis (U-5). The dish slugs reveal what was cooked, a [lawyer] question noted in the inventory row.
- `reward_grants(id uuid pk, user_id → users cascade, event_id → progress_events cascade, kind text not null check in GRANT_KINDS, body jsonb not null, created_at)`, with an index on `user_id`. There is no update path and no delete path except the cascade.

**Interfaces:**
- Consumes: `grantsFor`, `deriveProgress`, `validateQuests`, `validateRewards`, `validateTechniques`, `Catalogue`, `ProgressEvent`, `MAX_PROGRESS_EVENTS_PER_DAY` (Steps 1–2); `validateFrames`, `Frame`, `StallMap`, `FoodGroups`, `KeepsMap` (Step 3); `parseRecipe`, `ParsedRecipe` (M1); `lockLiveUser`, `audit`, `countSelfRead` (M2); the catalogue loader pattern (M4 C7).
- Produces:
```ts
// recipes/recipe-index.ts (C7)
export type RecipeIndex = ReadonlyMap<string, ParsedRecipe>;   // canon slug → parsed canon_recipes.source
export interface RecipeIndexSource { current(db: Db | Tx): Promise<RecipeIndex> }
export function createRecipeIndexSource(): RecipeIndexSource;
  // re-parses only when max(canon_recipes.synced_at) has changed since the last call, so a recipe sync is picked up without a restart;
  // buildApp creates one and passes `await source.current(tx)` as `deps.recipes` to Steps 6, 7 and 8; the progress Catalogue is rebuilt with it
// catalog.ts (C10)
export interface LoopContent { rewards: RewardsData; techniques: TechniqueNode[]; thresholds: FreshnessThresholds; quests: Quest[];
  cooks: ReadonlySet<string>; stalls: ReadonlySet<string>; frames: Frame[]; stallOf: StallMap; foodGroups: FoodGroups; keeps: KeepsMap }
export function loadLoopContent(catalog: Catalog, dataDir?: string, contentDir?: string): LoopContent;   // throws naming the file
export function defaultLoopContent(): LoopContent;
// progress/service.ts
export async function recordEventsIn(tx: Tx, deps: { catalogue: Catalogue; rewards: RewardsData; thresholds: FreshnessThresholds },
  userId: string, events: unknown[], today: string, at: Date, opts: { upload: boolean }, requestId?: string):
  Promise<{ accepted: { clientId: string; grants: RewardGrant[] }[]; duplicate: string[]; rejected: { clientId: string; problems: string[] }[]; view: ProgressView }>;
  // lockLiveUser → advisory progress: → load history (`base: null`; the account never compacts) → for each event in `at` order: duplicate client_id → skipped (idempotent replay);
  // grantsFor(problems) → rejected; else insert event + grants. The daily cap is per event (C14): grantsFor's `too_many_events`
  // problem rejects only the event over MAX_PROGRESS_EVENTS_PER_DAY for its `at`; the rest of the batch is still recorded.
  // Date window: a live post (upload: false) needs `at` within [today − 30, today + 1]; a sign-in upload (upload: true, Ruling 8)
  // accepts any valid `at` up to today + 1, still validated against the catalogue and still idempotent by client_id.
  // `imported` events are accepted only with upload: true, once per technique. audit 'progress.record' with counts only.
```
- Routes:
  - `GET /progress` → `{ view: ProgressView }`. It counts a self-read `'progress'`.
  - `POST /progress/events { events: ProgressEvent[], upload?: true }`, at most 100 per request (more → 400) → 200 `{ accepted, duplicate, rejected, view }`, also when some events are rejected by the daily cap. `upload: true` marks the sign-in upload of the device log (Step 9 `uploadDeviceLog`). No `confirmed` flag: events are not player data entry (README Global Constraints, §7.0). They are posted by the game's own flow, never by the mentor.
- No route lets the client name an amount, a level, trust or a grant. A body with any key outside the event shape is 400.
- Nothing calls `recordEventsIn` from `meals/`, `rules/`, `consent/`, `profile/` or `mentor/`. Meal-log nourishment comes from the client's `meal_logged` event after a confirmed log (Step 11), so a rule write can't even reach the reward code.

- `apps/api/src/errors.ts` gains no new code in this step: the daily cap is a per-event problem (`too_many_events` in `rejected[].problems`), not a 429 (C14).

- [ ] **5.1 Write the failing tests:**
```ts
test('a cooked event returns cook XP, Tried, and stores event + grants; GET /progress shows the view', ...);
test('replaying the same client_id is a duplicate: no second grant (offline replay, sign-in upload)', ...);
test('a forged quest_done without its steps, an unknown recipe, a future date → rejected, nothing stored', ...);
test('a body with { xp: 999 } or an unknown key → 400; no client-chosen amount is ever stored', ...);
test('201 events for one day → the 201st rejected with too_many_events; the other 200 and other dates stored (per event, C14)', ...);
test('a live post with at 40 days ago → rejected; the same event with upload: true → accepted and idempotent; imported without upload → rejected', ...);
test('a sign-in upload of a 2000-event device log spanning months → nothing lower than the device view (C14)', ...);
test('two concurrent posts of the same new event → exactly one grant (advisory lock + unique)', ...);
test('Guild entitlement vs free: identical events → identical grants and view (never rule 3)', ...);
test('deleting a meal log, withdrawing health_data with delete, and rule edits leave reward_grants untouched', ...);
test('imported M3 toolkit events rebuild tiers and grant nothing; a second import of the same technique is a duplicate', ...);
test('export has progress.events, progress.grants and view; DELETE /me leaves no progress_events or reward_grants row', ...);
test('C-9: a progress post leaves no recipe slug or quest id in the captured logs', ...);
test('boot refuses bad rewards.yaml, techniques.yaml, an invalid quest, frame, stalls.json or keeps.json, naming the file (C10)', ...);
test('a quest_step of a quest whose unlock.requires is not done → rejected (C4)', ...);
test('recipe index: a recipe synced after boot is in the next request\'s Catalogue (C7)', ...);
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/api -- progress account architecture inventory` → FAIL.
- [ ] **5.3 Implement.** Generate the migration with `drizzle-kit generate` and keep whatever number it is given. Build the catalogue from the `RecipeIndex` (rebuilt when the index changes) and the `LoopContent` loaded at boot. Use the M4 lock order with `progress:` last among the advisory locks.
- [ ] **5.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **5.5 Commit** `feat(api): progress events and append-only reward grants, computed by core, entitlement-blind`
