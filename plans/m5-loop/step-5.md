# Step 5 — API: progress events and reward grants

The server half of Ruling 7. The game posts progress events, the content-free facts of play. The API validates each against the catalogue and computes the grants with core `grantsFor`, then stores both. Grants are append-only and nothing but account delete removes them (§6, never rule 6). The API is blind to entitlements by construction (never rule 3), and the step pins that with a test.

**Files:**
- Create:
  - `apps/api/src/progress/store.ts`: `loadHistory`, `insertEvents`;
  - `apps/api/src/progress/service.ts`: `recordEventsIn`;
  - `apps/api/src/progress/routes.ts`;
  - `apps/api/src/progress/catalogue.ts`: builds core's `Catalogue` from `canon_recipes`, `content/` quests and `data/`;
  - a generated migration `apps/api/migrations/0012_progress.sql`.
- Modify:
  - `apps/api/src/db/schema.ts`: `progressEvents`, `rewardGrants`;
  - `apps/api/src/db/advisory-locks.ts`: `progress: 5` (a new number, never reused; `plan: 4` is Step 6's);
  - `apps/api/src/catalog.ts`: `rewards`, `techniques` and `quests` loaded and validated at boot; the server refuses to start on bad data, like rule terms;
  - `apps/api/src/app.ts`: register the routes;
  - `apps/api/src/errors.ts`: `too_many_events` (429);
  - `apps/api/src/account/routes.ts`: export `progress: { events, grants, view }`;
  - `apps/api/test/architecture.test.ts`: `apps/api/src/progress/**` and core `progress/` import nothing from `entitlements`, `usage`, `rules` or `consent`; no route under `rules/` or `consent/` imports `progress`;
  - `docs/compliance/data-inventory.md`: U-5 becomes "built M5" with the real tables, plus §6 columns.
- Test: `apps/api/test/progress.test.ts`, and extend `apps/api/test/account.test.ts` and `apps/api/test/architecture.test.ts`.

**Tables:**
- `progress_events(id uuid pk, user_id → users cascade, client_id text not null, kind text not null check in PROGRESS_KINDS, at date not null, body jsonb not null, created_at)`, with a `unique (user_id, client_id)` and an index on `(user_id, at)`. The `body` holds only ids and numbers from the `ProgressEvent` shape: zod `.strict()`, strings checked against the catalogue, so no free text can land in it. It is plain, on the contract basis (U-5). The dish slugs reveal what was cooked, a [lawyer] question noted in the inventory row.
- `reward_grants(id uuid pk, user_id → users cascade, event_id → progress_events cascade, kind text not null check in GRANT_KINDS, body jsonb not null, created_at)`, with an index on `user_id`. There is no update path and no delete path except the cascade.

**Interfaces:**
- Consumes: `grantsFor`, `deriveProgress`, `validateQuests`, `validateRewards`, `Catalogue`, `ProgressEvent` (Steps 1–2); `lockLiveUser`, `audit`, `countSelfRead` (M2); the catalogue loader pattern (M4 C7).
- Produces:
```ts
// progress/service.ts
export async function recordEventsIn(tx: Tx, deps: { catalogue: Catalogue; rewards: RewardsData; thresholds: FreshnessThresholds },
  userId: string, events: unknown[], today: string, at: Date, requestId?: string):
  Promise<{ accepted: { clientId: string; grants: RewardGrant[] }[]; duplicate: string[]; rejected: { clientId: string; problems: string[] }[]; view: ProgressView }>;
  // lockLiveUser → advisory progress: → load history → for each event in `at` order: duplicate client_id → skipped (idempotent replay);
  // grantsFor(problems) → rejected; else insert event + grants. Over MAX_PROGRESS_EVENTS_PER_DAY for its `at` → 429 too_many_events (whole batch).
  // `at` must be within [today − 30, today + 1] for live events; `imported` events (Ruling 8) may be older, once per technique.
  // audit 'progress.record' with counts only.
```
- Routes:
  - `GET /progress` → `{ view: ProgressView }`. It counts a self-read `'progress'` (`SELF_READ_RESOURCES` += `'progress'`, migration updates the check).
  - `POST /progress/events { events: ProgressEvent[] }`, at most 100 per request → 200 `{ accepted, duplicate, rejected, view }`. No `confirmed` flag: events are not player data entry (README Global Constraints, §7.0). They are posted by the game's own flow, never by the mentor.
- No route lets the client name an amount, a level, trust or a grant. A body with any key outside the event shape is 400.
- Nothing calls `recordEventsIn` from `meals/`, `rules/`, `consent/`, `profile/` or `mentor/`. Meal-log nourishment comes from the client's `meal_logged` event after a confirmed log (Step 11), so a rule write can't even reach the reward code.

- [ ] **5.1 Write the failing tests:**
```ts
test('a cooked event returns cook XP, Tried, and stores event + grants; GET /progress shows the view', ...);
test('replaying the same client_id is a duplicate: no second grant (offline replay, sign-in upload)', ...);
test('a forged quest_done without its steps, an unknown recipe, a future date → rejected, nothing stored', ...);
test('a body with { xp: 999 } or an unknown key → 400; no client-chosen amount is ever stored', ...);
test('201 events for one day → 429 too_many_events; nothing from that batch stored', ...);
test('two concurrent posts of the same new event → exactly one grant (advisory lock + unique)', ...);
test('Guild entitlement vs free: identical events → identical grants and view (never rule 3)', ...);
test('deleting a meal log, withdrawing health_data with delete, and rule edits leave reward_grants untouched', ...);
test('imported M3 toolkit events rebuild tiers and grant nothing; a second import of the same technique is a duplicate', ...);
test('export has progress.events, progress.grants and view; DELETE /me leaves no progress_events or reward_grants row', ...);
test('C-9: a progress post leaves no recipe slug or quest id in the captured logs', ...);
test('boot refuses bad rewards.yaml or an invalid quest file, naming the file', ...);
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/api -- progress account architecture inventory` → FAIL.
- [ ] **5.3 Implement.** Generate the migration with `drizzle-kit generate`. Build the catalogue once at boot from `canon_recipes` (re-read after a recipe sync) and the content files. Use the M4 lock order with `progress:` last among the advisory locks.
- [ ] **5.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **5.5 Commit** `feat(api): progress events and append-only reward grants, computed by core, entitlement-blind`
