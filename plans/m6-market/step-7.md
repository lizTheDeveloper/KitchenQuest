# Step 7 — API: the progress snapshot cache (m12) and the ROADMAP id test (N3)

Two M5 carries, both API-side:
- **m12, the server half.** `loadHistory` reads the whole uncompacted ledger on every `POST /progress/events` and `GET /progress` (`apps/api/src/progress/store.ts`). This step adds a **sealed** `progress_snapshots` cache (Ruling 18). It holds core's `ProgressSnapshot` of the fold up to a sequence number. It has the same `base` semantics as the device compaction (M5 C15), it is in the export, and it is deleted with the account. A database trigger drops it whenever any progress event is deleted, so an erased meal-log event (FK cascade), a `health_data` delete or a sealed stall round's erase can never leave a stale cache behind.
- **N3, the ROADMAP id test** (Ruling 20).

**Eval hash (Ruling 22):** `progress/store.ts` and `progress/service.ts` are eval-hashed; same milestone-branch skip.

**Files:**
- Create:
  - `apps/api/src/progress/snapshot.ts`: `loadHistoryWithSnapshot`, `maybeWriteSnapshot`, `catalogueHash`;
  - the next generated migration (`drizzle-kit`, C6):
    - the table, with `user_id → users on delete cascade`;
    - the trigger `progress_events_drop_snapshot` (`AFTER DELETE ON progress_events FOR EACH ROW` → `DELETE FROM progress_snapshots WHERE user_id = OLD.user_id`);
  - `apps/api/test/snapshot.test.ts`.
- Modify:
  - `packages/core/src/progress/derive.ts` and `index.ts`: export `SNAPSHOT_EVERY = 500` (the constant lives in core, README constants);
  - `apps/api/src/db/schema.ts`: `progressSnapshots`;
  - `apps/api/src/progress/store.ts`: `loadHistory` becomes the snapshot-aware read (the full read is kept as `loadFullHistory` for the export and for rebuilds);
  - `apps/api/src/progress/service.ts`: after recording, `maybeWriteSnapshot` under the same `progress:` lock and transaction;
  - `apps/api/src/account/routes.ts`: export `progress.snapshot` (decrypted, or null);
  - `apps/api/src/consent/health-data.ts`: no code change needed (the trigger covers it). A test pins it;
  - `apps/api/test/inventory.test.ts`: the N3 widening;
  - `apps/api/test/never-take-back.test.ts`: the snapshot rebuild property;
  - `docs/compliance/data-inventory.md`: a new U-6 row, §6 columns (N-8), and lock order;
  - `docs/compliance/ROADMAP.md`:
    - the m12 note;
    - any C-table entries N3 needs: C-46, C-47 and C-48 either get rows in `2026-11-09-health-data-compliance.md` §6 or go in `ALLOWED_ROADMAP_ONLY` with a reason;
    - whatever id fixes the widened test finds, each listed in the report;
  - `docs/compliance/2026-11-09-health-data-compliance.md` (only if N3 needs the C-table rows).

**Table:** `progress_snapshots(user_id uuid pk → users cascade, upto_seq bigint not null, catalogue_hash text not null, sealed bytea not null, created_at timestamptz not null)`.
- `sealed` holds core's `ProgressSnapshot` (`{ view, facts }`), with AAD `{ table: 'progress_snapshots', userId, rowId: userId }`. It is sealed because the view holds dish slugs (`cookedOn`), `marketAnswered` (which can include Protein Counter question ids, Ruling 17) and trust per cook.
- `catalogue_hash` is sha256 over the canonical JSON of the `Catalogue` ids, `data/rewards.yaml` and the freshness thresholds. A different hash means the snapshot is ignored and rebuilt. A retune can never be "baked in" by a stale fold, and since grants are fixed when made, a rebuild never lowers a value (§6).

**Interfaces:**
- Consumes: `ProgressHistory` (`base`), `ProgressSnapshot`, `foldHistory`, `snapshotOf`, `compactHistory`, `deriveProgress` (M5 core, C15); `loadHistory` / `insertEvents` (M5 Step 5, Step 6's sealed bodies); `sealFor`/`openFor`; `lockUserProgress`.
- Produces:
```ts
export const SNAPSHOT_EVERY = 500;   // core progress/ (README constants); imported here
/**
 * The history grantsFor needs, from the snapshot when it is usable: base = the snapshot (events with seq ≤ upto_seq,
 * and every grant whose event row is among them or no longer exists at snapshot time), events = seq > upto_seq in
 * order, grants = those for the tail's events. No usable snapshot (none, hash differs, unseal fails) → the full read
 * (base: null), exactly M5's behaviour. A snapshot that fails to unseal is deleted and logged as a content-free warning.
 */
export async function loadHistoryWithSnapshot(db: Reader, keyring: Keyring, userId: string, cat: Catalogue, hash: string): Promise<ProgressHistory>;
/** Under progress: — when the tail since the snapshot (or since the start) exceeds SNAPSHOT_EVERY events, fold and upsert. */
export async function maybeWriteSnapshot(tx: Tx, keyring: Keyring, userId: string, cat: Catalogue, hash: string): Promise<void>;
export function catalogueHash(cat: Catalogue, rewards: RewardsData, thresholds: FreshnessThresholds): string;
```
- **Invalidation (Ruling 18):** the trigger is the rule. The tests prove each erase path drops the row: `DELETE /meals/:id` (FK cascade on `progress_events.meal_log_id`), a `health_data` withdraw-with-delete (the `meal_logged` erase and Step 6's sealed rounds), and account delete (the cascade on `user_id`). There is no code path that deletes an event without the trigger firing. A test greps `apps/api/src` for `delete(progressEvents)` and asserts each hit is in a transaction that relies on the trigger. No `ALTER TABLE … DISABLE TRIGGER` appears anywhere.
- **Equivalence:** for any history, the view from snapshot + tail equals the view from the full read. This is a fast-check property over random event sequences, erasures and rewards retunes, run through `grantsForBatch` and `deriveProgress`.
- **N3 (Ruling 20).** `ROADMAP item ids` in `inventory.test.ts`:
  - matches `^- \[[ x~]\] (?:\*\*)?([CN]-\d+[a-z]?)(?:\*\*)?` and `(… part)` forms;
  - asserts whole-item ids are unique;
  - asserts every "(x part)" names an existing whole id and that its x values under one id are distinct;
  - asserts every ROADMAP `C-n` is in the compliance doc's §6 table, and vice versa, except `ALLOWED_ROADMAP_ONLY` (each with a reason).

  The current file must pass. Fixing it is a doc change, listed in the report.

- [ ] **7.1 Write the failing tests:**
```ts
// snapshot.test.ts
test('after SNAPSHOT_EVERY+1 events a sealed snapshot exists; progress_snapshots.sealed holds no slug or question id in plaintext', ...);
test('GET /progress with a snapshot reads only the tail (spy on the select) and returns the same view as a full read', ...);
test('DELETE /meals/:id (cascade) drops the snapshot in the same transaction; the next read rebuilds; XP unchanged', ...);
test('health_data withdraw-with-delete drops the snapshot; sealed stall rounds erased; view ≥ before', ...);
test('a rewards.yaml retune changes catalogue_hash → snapshot ignored and rebuilt; no derived value drops', ...);
test('a snapshot that fails to unseal is deleted and the full read is used', ...);
test('export has progress.snapshot decrypted; DELETE /me leaves no progress_snapshots row', ...);
test('concurrent POST /progress/events (two connections) → one consistent snapshot, lock order holds', ...);
// never-take-back.test.ts
test('property: view(snapshot + tail) == view(full) over random histories with erasures (fast-check)', ...);
// inventory.test.ts
test('ROADMAP ids: suffixed (C-10b) and non-bold (C-36) ids are seen; whole ids unique; parts name a base; C-table cross-check', ...);
test('progress_snapshots columns are in data-inventory §6 (U-6)', ...);
```
- [ ] **7.2 Run** `MENTOR_EVAL_GATE=skip-no-network npm test -w @kitchenquest/api -- snapshot never-take-back inventory progress meals consent account` → FAIL.
- [ ] **7.3 Implement.** Generate the migration (with the trigger SQL in it) and keep its number.
- [ ] **7.4 Run** `MENTOR_EVAL_GATE=skip-no-network npm test -w @kitchenquest/api` (milestone branch) → PASS.
- [ ] **7.5 Commit** `feat(api): a sealed progress snapshot that any erase drops, and full-coverage ROADMAP id checks`
