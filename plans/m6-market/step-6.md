# Step 6 — API: stall rounds, sealed health-revealing events, amounts and stock swaps

The server side of the market:
- **Stall rounds:** `POST /progress/events` accepts `stall_round`, validated and rewarded by core against the stall files loaded at boot.
- **Sealed Protein Counter rounds** (Ruling 17): they reveal a meat-excluding rule, so their body is sealed per row, they need `health_data`, and a withdraw-with-delete erases them (the grants stay, as M5's `meal_logged`).
- **Market runs** gain amounts and a stock route for stall swaps, decided by core and re-checked on every call, exactly as M5's ticks are.

**Eval hash (Ruling 22):** `catalog.ts`, `progress/*` and `week/*` are eval-hashed; same milestone-branch skip.

**Files:**
- Create:
  - `apps/api/src/progress/seal.ts`: `sealEventBody`, `openEventBody`, both with AAD `{ table: 'progress_events', userId, rowId }`;
  - the next generated migration (`drizzle-kit generate`, never a hand-picked number, C6): `progress_events.sealed bytea null`, `PROGRESS_KINDS` += `stall_round` (the check constraint), and a check that `sealed` is null unless `kind = 'stall_round'`;
  - `apps/api/test/market.test.ts`.
- Modify:
  - `apps/api/src/catalog.ts`: `loadLoopContent` also returns `market: { stalls: Map<id, StallFile>, seasonality: SeasonTable }`. It reads the stall files whole (today it reads only their ids) and `data/seasonality.yaml`, and refuses to boot on `validateStallFile`, `validateSeasonTable` or `seasonalAgrees` problems, naming the file;
  - `apps/api/src/progress/catalogue.ts`: `catalogueFor` builds `Catalogue.market` (Step 3);
  - `apps/api/src/progress/store.ts`: `insertEvents` seals the body of an event for which core `isHealthRevealing` is true. The plain `body` then holds `{}`, and `sealed` holds the whole body. `loadHistory` opens sealed bodies (it takes the keyring now; every caller is updated);
  - `apps/api/src/progress/service.ts`: `recordEventsIn` rejects a health-revealing event `consent_required` (per event, in `rejected`) without `health_data`, and passes the player's rules to `grantsForBatch` (M5);
  - `apps/api/src/progress/routes.ts`: unchanged routes; the body schema accepts `stall_round` (strict: `stall` ≤ 40, ≤ `MAX_ROUND_ANSWERS` answers, `q` ≤ 80, `pick` an integer 0–3, no other key);
  - `apps/api/src/consent/health-data.ts`: a withdraw-with-delete also erases every `progress_events` row with `sealed is not null` (after `HEALTH_TABLES`, with the existing `meal_logged` erase; grants kept, M5 I2);
  - `apps/api/src/week/market-service.ts`:
    - `openRunIn` and `tickIn` return rows with `amounts` (core `marketList` fills them);
    - the new `stockIn`;
    - recompute keeps `outOfStock` and the `stock:` rows exactly, as ticked rows are kept (C20);
  - `apps/api/src/week/routes.ts`: `POST /market-runs/:id/stock`;
  - `apps/api/src/db/schema.ts`: `progressEvents.sealed`; `PROGRESS_KINDS`;
  - `apps/api/src/account/routes.ts`: the export opens sealed event bodies (`progress.events` shows the whole event, decrypted);
  - `apps/api/src/errors.ts`: `stock_invalid` (400);
  - `docs/compliance/data-inventory.md`: U-5 (the new kind, the sealed column, the health gate and the erase), H-11 (market-run rows carry amounts and stock swaps), §3.13 caps, §6 columns (N-8).
- Test: `apps/api/test/market.test.ts`; extend `progress.test.ts`, `week.test.ts`, `consent.test.ts`, `account.test.ts`, `inventory.test.ts`.

**Interfaces:**
- Consumes: `validateStallFile`, `validateSeasonTable`, `seasonalAgrees`, `StallFile`, `SeasonTable` (Steps 1–2); `stall_round`, `isHealthRevealing`, `Catalogue.market`, `stockSwaps`, `markOutOfStock`, `takeStockSwap`, `undoStock`, `MAX_STOCK_SWAPS_PER_RUN`, `ListItem.amounts` (Step 3); `recordEventsIn`, `loadHistory`, `insertEvents` (M5 Step 5); `openRunIn`, `tickIn`, `changePantryIn`, `restorePantryIn`, `localToday` (M5 Step 6); `sealFor`/`openFor`, `lockLiveUser`, `lockUserPantry`, `lockUserPlan`, `hasConsent`, `audit`.
- Produces:
```ts
// week/market-service.ts
export async function stockIn(tx: Tx, deps: WeekDeps, userId: string, runId: string,
  body: { key: string; action: 'out' | 'take'; toId?: string } | { key: string; action: 'undo' }, at: Date, today: string): Promise<MarketRunView>;
  // lockLiveUser → pantry: → plan: → health_data required (403) → run open (409 run_closed after done_at) → recompute rows (C20)
  // 'out': markOutOfStock (a ticked row is unticked first, removing its pantry id, M5 rule)
  // 'take': toId must be one of core stockSwaps(row, plan, ctx) computed NOW with the player's rules → else 400 stock_invalid;
  //         takeStockSwap; the added row is ticked into the pantry { name, ingredientId, addedOn: today, source: 'market' }, id remembered
  // 'undo': undoStock; the added row's pantry id is removed (by id, never by name)
  // at most MAX_STOCK_SWAPS_PER_RUN stock rows a run (400 stock_invalid); audit 'market_run.stock' (content-free: row count only)
```
- Route: `POST /market-runs/:id/stock { key, action, toId?, today }` → 200 `MarketRunView` (no `confirmed`: it is a tap like a tick, §7.0 "None (undoable)"; `undo` is the undo). Nothing about food is in the URL (P-5).
- The stock swaps a client may *offer* are computed on the device with the same core function. The server never trusts the client's list: `take` re-runs `stockSwaps`.
- Lock order: user → `pantry:` → `plan:` → `progress:` (events) → consent row → data rows (README).
- C-9: no stall id, question id, item name or pick in any log line; the request log stays route patterns only.

- [ ] **6.1 Write the failing tests:**
```ts
// market.test.ts
test('stall_round: a correct first answer → 5 XP and the weekly stall stamp; the same again → nothing more; wrong → stamp only', ...);
test('a forged correct flag / an unknown question / a question the player\'s rules hide → rejected bad_event, nothing stored', ...);
test('Protein Counter round: stored with body {} and sealed non-null; progress_events has no plaintext "protein_counter" or question id', ...);
test('Protein Counter round without health_data → rejected consent_required; with it → accepted', ...);
test('health_data withdraw-with-delete erases sealed stall rounds; XP, level and stamps unchanged (grants kept)', ...);
test('export shows the sealed round decrypted; DELETE /me leaves no progress_events row', ...);
test('boot refuses a stall file with an unknown contains id and names the file', ...);
// week.test.ts
test('open run rows carry amounts scaled by plan servings; a null-quantity line shows no amounts', ...);
test('stock out → row outOfStock and unticked (pantry id removed); take an offered swap → a ticked stock row + a dated market pantry item', ...);
test('take a swap core does not offer now (e.g. a rule added since) → 400 stock_invalid, nothing changed', ...);
test('undo removes exactly the swap\'s pantry id; a same-name pantry item survives', ...);
test('recompute after a rule change keeps outOfStock and stock rows; stock after finish → 409 run_closed', ...);
test('stock without health_data → 403 consent_required; C-9: no item or question id in captured logs', ...);
// inventory.test.ts
test('progress_events.sealed is in data-inventory §6', ...);
```
- [ ] **6.2 Run** `MENTOR_EVAL_GATE=skip-no-network npm test -w @kitchenquest/api -- market progress week consent account inventory` → FAIL.
- [ ] **6.3 Implement.** Generate the migration and keep whatever number it is given.
- [ ] **6.4 Run** `MENTOR_EVAL_GATE=skip-no-network npm test -w @kitchenquest/api` (milestone branch) → PASS, and `npm run typecheck`.
- [ ] **6.5 Commit** `feat(api): stall rounds rewarded by core, sealed Protein Counter rounds, list amounts and rules-checked stall swaps`
