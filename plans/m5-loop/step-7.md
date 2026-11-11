# Step 7 — API: margin notes, Cooked for Someone, consent subject reserve

The two most personal records the loop adds, plus the family-mode reservation the compliance roadmap asks of M5 (C-45). Margin notes are health data (Ruling 9): sealed, in `HEALTH_TABLES`, behind `health_data` consent, with the notice moving to v3. Cooked for Someone holds no names (Ruling 10): sealed, contract basis, fixed values only. Both are account-only, exported and deleted. This step also closes ROADMAP N-7's open note ("Cooked for Someone labels are decided with M5").

**Files:**
- Create:
  - `apps/api/src/book/notes-service.ts`, `apps/api/src/book/shared-table-service.ts`, `apps/api/src/book/routes.ts`;
  - `docs/compliance/notices/health_data-v3.md`;
  - the next generated migration (`drizzle-kit generate`; never a hand-picked number, C6).
- Modify:
  - `apps/api/src/db/schema.ts`: `marginNotes`, `sharedTable`; `consents.subjectKind` (`text not null default 'user'`, check `= 'user'`) and `consents.subjectId` (`uuid null`), Ruling 19; `SELF_READ_RESOURCES` += `'notes'`;
  - `apps/api/src/consent/health-data.ts`: `HEALTH_TABLES = [rules, mealLogs, marginNotes, messages, mentorProposals]`;
  - `apps/api/src/consent/notices.ts`: current `health_data` = v3, and `ACCEPTED_VERSIONS.health_data = ['v3']`, so a v2 grant no longer counts;
  - `apps/api/src/account/routes.ts`: export `marginNotes` and `sharedTable`, decrypted;
  - `apps/api/src/errors.ts`: `too_many_notes`;
  - `apps/api/test/architecture.test.ts`: `HEALTH_SCHEMA_EXPORTS` += `marginNotes`, `HEALTH_SQL_TABLES` += `margin_notes`;
  - `apps/api/test/consent.test.ts`: the current notice version;
  - `docs/compliance/data-inventory.md`: H-12 and H-13 built M5, K-4 "reserved M5 (subject columns)", the §6 columns, the §3.13 caps; H-12 also records that `GET /notes` takes no recipe in its URL and returns all the player's notes (at most 20 per recipe), filtered by the client (Ruling 26, C32); `docs/compliance/risk-register.md` R-19 control.
- Test: `apps/api/test/book.test.ts`, extend `apps/api/test/account.test.ts`, `apps/api/test/consent.test.ts` and `apps/api/test/architecture.test.ts`.

**Tables:**
- `margin_notes(id uuid pk, user_id → users cascade, recipe text not null, sealed bytea not null, created_at)`, with an index on `(user_id, recipe)`. The `sealed` field is core's `MarginNote` minus `recipe`, with AAD `{ table: 'margin_notes', userId, rowId }`. `recipe` (a canon slug) stays plain for the per-recipe query and cap. A slug alone reveals only "has a note on this dish", the same as the plain `progress_events`.
- `shared_table(id uuid pk, user_id → users cascade, cooked_on date not null, sealed bytea not null, created_at)`. The `sealed` field is `{ recipe: string | null, frame: string | null, cookedFor: CookedFor }`, with AAD `{ table: 'shared_table', userId, rowId }`.

**Interfaces:**
- Consumes: `validateNote`, `checkWithNotes`, `MarginNote`, `CookedFor`, `SharedEntry`, `SharedTally`, `shareTally`, `COOKED_FOR_COUNTS`, `COOKED_FOR_WHO`, `NOTE_TEXT_MAX`, `MAX_NOTES_PER_RECIPE` (Step 3); `RecipeIndex` (Step 5); `lockConsentIn`, `deleteHealthDataIn`, `sealFor`/`openFor` (M2/M4).
- Produces:
```ts
// book/notes-service.ts
export async function createNoteIn(tx, deps: { keyring; catalog; recipes: RecipeIndex }, userId: string, note: MarginNote, at: Date, requestId?): Promise<MarginNote & { id: string; check: CheckResult }>;
  // live user (401) → health_data consent (403) → validateNote (400; sacred → 400) → count per recipe (400 too_many_notes) → seal → insert → audit 'notes.create'
  // the returned `check` is checkWithNotes over ALL the player's notes on that recipe, today, with their rules — what "cook with my notes" will show
export async function deleteNoteIn(tx, userId: string, id: string, at: Date, requestId?): Promise<void>;   // 404 when not theirs; no consent needed
export async function loadNotes(db, keyring, userId: string, recipe?: string): Promise<(MarginNote & { id: string })[]>;
  // `recipe` is for the service's own use (the per-recipe cap, createNoteIn's check); the route never passes one (C32)
// book/shared-table-service.ts
export async function recordSharedIn(tx, deps, userId: string, entry: SharedEntry, at: Date): Promise<{ id: string }>;
  // zod: cookedFor.count ∈ COOKED_FOR_COUNTS, who ∈ COOKED_FOR_WHO | null — no other key, no string field at all beyond the slugs
export async function sharedTally(db, keyring, userId: string): Promise<SharedTally>;
  // core shareTally over the opened rows: { shared, byRecipe: Record<slug, number> } — counts only, never a list of entries or people (C21)
```
- Routes:
  - `GET /notes` → `{ notes }`: every note the player has (at most `MAX_NOTES_PER_RECIPE` per recipe), with no recipe in the URL (P-5, Ruling 26, C32); any query string → 400. The client filters by recipe and runs core `checkWithNotes` itself for "cook with my notes". It counts a self-read `'notes'`.
  - `POST /notes { note, confirmed: true }` → 201.
  - `DELETE /notes/:id` → 204.
  - `POST /shared-table { entry, confirmed: true }` → 201.
  - `GET /shared-table/tally` → `SharedTally` (`{ shared, byRecipe }`), which the book uses for its per-dish counts (Step 11).
  - `DELETE /shared-table/:id` → 204.
- Notes never feed a reward. Shared Table entries never feed a reward, a trust change or a gate (audit M-9: "never a requirement for trust or progress"). The architecture test asserts that `book/` imports nothing from `progress/` and `progress/` nothing from `book/`.
- The v3 notice adds "your own notes on recipes (margin notes), which can show what you can't or won't eat" to the `health_data` categories, keeping GDPR Art. 9's religious-rules wording from v1. It is marked draft pending lawyer review (C-30). A v2 grant no longer counts, and the game shows the 3-C/HEALTH card again (M4's re-consent path).
- `consents.subject_kind`: every existing and new row is `'user'`, and the check refuses anything else until M13. `subject_id` is null. Export lists the two columns. No other code reads them yet (knip: they are schema columns, not exports).

- [ ] **7.1 Write the failing tests:**
```ts
test('a margin note round-trips sealed: margin_notes.sealed holds no "oat milk"', ...);
test('note needs confirmed: true and health_data v3 consent; a v2 grant → 403 consent_required', ...);
test('note on a sacred recipe → 400; 21st note on one recipe → 400 too_many_notes; text 281 chars → 400', ...);
test('POST /notes returns checkWithNotes: "swap lentils → peanut" on a peanut-rule player → blocked with the finding', ...);
test('withdraw health_data with delete removes margin notes, keeps shared_table, plans and progress', ...);
test('shared-table rejects any string field: { who: "Sam" } and { name: … } → 400; nothing stored', ...);
test('tally counts meals shared in total and per recipe, ignores just_me, and exposes no list (C21)', ...);
test('GET /notes returns the notes on every recipe; a ?recipe= query → 400, so nothing about food is in the URL (C32)', ...);
test('notes and shared entries never create a progress_event or reward_grant', ...);
test('consents.subject_kind defaults to user; inserting child_profile fails the check', ...);
test('export includes marginNotes and sharedTable decrypted; DELETE /me leaves neither', ...);
test('C-9: a note POST leaves no note text in captured logs', ...);
```
- [ ] **7.2 Run** `npm test -w @kitchenquest/api -- book consent account architecture inventory` → FAIL.
- [ ] **7.3 Implement.** Generate the migration and keep whatever number it is given. Follow the M4 lock order: user → consent → `margin_notes` row. Record DPIA and N-11 follow-ups for Step 12, not here.
- [ ] **7.4 Run** `npm test -w @kitchenquest/api` → PASS.
- [ ] **7.5 Commit** `feat(api): sealed margin notes (health) and a name-free Shared Table; consent subject reserved (C-45)`
