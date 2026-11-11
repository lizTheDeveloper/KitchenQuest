# Step 9 — Game: progress, quests, trust and the knife roll

The game becomes a game. Visiting a cook runs their quest through core's engine. Quest, lesson, drill, cook and market events go into one progress log: on the device when signed out, posted to `/progress/events` when signed in, and uploaded once on sign-in (Ruling 8). The kitchen shows the apprentice level and stamps quietly, with no bar to the next level, no streak and no daily target. The toolkit gains certificates. Trust lines play on return visits. Reward lines (`levelup`, `trust_up`, `stamp_earned`, `skill_up` → `certificate.technique`) come from grants, never from guesses on the client.

**Files:**
- Create:
  - `apps/game/src/progress/log.ts`: the device event log, ids, cap;
  - `apps/game/src/progress/sync.ts`: post, replay, sign-in upload, M3 toolkit import;
  - `apps/game/src/progress/view.ts`: `deriveProgress` for the device, `/progress` for the account;
  - `apps/game/src/progress/announce.ts`: grants → Pan lines and toasts;
  - `apps/game/src/quests/quest-runner.ts`: drives a quest's steps in the visit screen with the existing dialogue box;
  - `apps/game/src/kitchen/apprentice-card.ts`: level, stamps, the Shared Table tally later (Step 11).
- Modify:
  - `apps/game/src/state/store.ts` (+ test): `PlayerState.progress = { events: ProgressEvent[]; grants: RewardGrant[]; base: ProgressSnapshot | null; pendingUpload: string[] }` (the device's own `ProgressHistory` plus the ids not yet uploaded); `MAX_DEVICE_EVENTS`; `mergeProgress` (union by id over the events still held; never drops one, and never lowers `base`); on parse, M3 `toolkit` records with no matching `imported` event become `imported` events once;
  - `apps/game/src/api/{client,types}.ts`: `getProgress()`, `postProgressEvents(events)`;
  - `apps/game/src/world/visit-screen.ts`: intro → quest runner (when the quest is `open` or `in_progress`) → card → cook; a `waiting` quest (its `unlock.requires` not done, C4) is not started: the visit goes intro → card, and the cook stays visitable and cookable; on later visits, the `trust_lines[level]` line, then the card;
  - `apps/game/src/world/map-screen.ts` and `pins.ts`: pin states "expecting you" (introduced) and "awaiting an introduction" + "Travel anyway" (Ruling 3); the quest-offered letter; no locked pins;
  - `apps/game/src/kitchen/kitchen-screen.ts`: the apprentice card; the toolkit from progress;
  - `apps/game/src/kitchen/toolkit-view.ts` (+ test): Yours rows show the 51-T certificate; a Rusty row keeps M3's invitation (no new warning, no red);
  - `apps/game/src/cook/finish.ts`: emits a `cooked` progress event (`planned` from the current plan) instead of writing `toolkit` directly;
  - `apps/game/src/cook/cook-screen.ts`: calls the progress log; a sacred recipe stays refused (M3).
- Test: `apps/game/src/progress/*.test.ts`, `apps/game/src/quests/quest-runner.test.ts`, and `apps/game/e2e/quests.e2e.test.ts` (new).

**Interfaces:**
- Consumes: `advance`, `StepContext`, `currentStep`, `questStatus`, `recognizedFrom`, `grantsFor`, `deriveProgress`, `compactHistory`, `ProgressSnapshot`, `MAX_PROGRESS_EVENTS_PER_DAY`, `trustLevel` (Steps 1–2); `GET /progress`, `POST /progress/events` (Step 5); content triggers (Step 4); `showDialogue`, `openModal`, `bureauSlip`, `announce` (M3/M4 UI).
- Produces:
```ts
// progress/log.ts
export function newEventId(): string;   // crypto.randomUUID
export function appendEvents(store: PlayerStore, events: ProgressEvent[], grants: RewardGrant[]): void;
  // over MAX_DEVICE_EVENTS, core compactHistory folds the oldest events and their grants into `progress.base` (a totals snapshot,
  // C15); no derived value ever drops, and the next event's grants are the same as without compaction
// progress/sync.ts
export function createProgressSync(deps: { store: PlayerStore; client: ApiClient; online(): boolean }): {
  record(events: ProgressEvent[]): Promise<RewardGrant[]>;   // signed in: POST (accepted grants returned); signed out: grantsFor locally,
                                                              // the same core checks as the server, the daily cap included (C14)
  uploadDeviceLog(): Promise<void>;                           // on sign-in: post every held device event once, in order, 100 per request,
                                                              // with upload: true (Step 5: older dates accepted); duplicates fine
  stop(): void;
};
// progress/view.ts
export function currentProgress(state: PlayerState, account: ProgressView | null, cat: Catalogue): ProgressView;
  // signed out: deriveProgress of the device history. Signed in: the field-wise max of the account view and the device view (XP, level,
  // stamps, each cook's trust, each technique's tier, quests done and steps, dates as a union), so nothing shown ever drops — also when
  // compacted device events never reached the account (C14, C15)
// quests/quest-runner.ts
export function runQuest(slot: HTMLElement, q: Quest, deps: { progress: ProgressView; record: (e: ProgressEvent[]) => Promise<RewardGrant[]>;
  pantry: () => PantryItem[]; rules: () => Rule[]; graph: IngredientGraph; subs: Substitution[]; today: () => string;
  signal: AbortSignal }): Promise<'done' | 'paused'>;   // builds advance's StepContext from rules/graph/subs/today (C5)
```
- Grants arriving from the server or computed locally become lines through `announce.ts`:
  - `level` → `levelup`;
  - `trust` → `trust_up`, and the introduction letter at level 3 (`introduction_received`, which changes the friend's pin to "expecting you"; no new country opens, Ruling 3);
  - `certificate` → `certificate.technique`;
  - `stamp` → `stamp_earned`, with `{stamp}` from `bureau.stamp_names[grant.stamp]` (C13).

  At most two lines per event, in that order. Nourishment XP has **no line and no toast**: logging food is never applauded by a number (audit R4).
- Riddles: a wrong option shows its `reaction` and keeps the step, with no penalty. Riddle answers are buttons, keyboard-reachable, and axe-clean.
- Errands: the step shows "I've got it" (a tap), and passes on its own if the item is in the pantry or ticked on this week's list. A blocked item shows the cook's adapted line.
- The Travel step is satisfied on arrival.
- Recognize: on a known technique, the Pan says `quest.recognize`, the event is recorded, and the certificate line may follow.
- "Cook it anyway" is available on every canon dish card, whatever the trust or tier. The ⛔ status still disables Cook (M3 rule, Review Focus 1).
- Signed out, the same grants are computed by core on the device, so a signed-out player sees the same level-up a signed-in one would. On sign-in, the device log is uploaded with `upload: true`, and from then on `currentProgress` shows the field-wise max of the account view and the device view (no visible drop, before or after the upload completes).
- No streak counter, no "days in a row", no countdown, no "x of 9" anywhere (Step 12 scans).

- [ ] **9.1 Write the failing tests:**
```ts
test('store: M3 toolkit records become imported events once; a reload does not import twice', ...);
test('store: mergeProgress unions by id and never drops a held event; a 2001st event compacts into base and no derived value drops (C15)', ...);
test('sync: signed out → local grants; sign-in → device log uploaded once with upload: true; replay after offline → duplicates only, no double lines', ...);
test('sync: signed out, the 201st event of one day gets no grants, as on the server (C14)', ...);
test('view: signed in, an account view lower than the device view (compacted events) shows the device values (C14, C15)', ...);
test('quest runner: Leela\'s quest talk → errand → drill → riddle → recognize → cook, events in order; wrong riddle → reaction, same step', ...);
test('quest runner: an errand item blocked by the player\'s rules → blocked + the cook\'s adapted line (C5); a waiting quest is not started (C4)', ...);
test('trust lines: level 2 shows a trust_lines[2] line on return; level 0 never shows return lines', ...);
test('map: unintroduced cook → "Awaiting an introduction" + Travel anyway; introduced → "expecting you"; no locked pin', ...);
test('nourishment grants produce no line, no toast', ...);
test('toolkit view: Yours shows the certificate; Rusty row unchanged (no warning class, no red)', ...);
// e2e quests.e2e.test.ts (mocked /api): a signed-out quest to cook mode; sign in; upload; account view equal; no level drops
```
- [ ] **9.2 Run** `npm test -w @kitchenquest/game -- progress quests store toolkit` and `npm run test:e2e -w @kitchenquest/game -- quests` → FAIL.
- [ ] **9.3 Implement.** Keep the first-paint budget (M4 carry: ~290 KB). The quest runner and progress view load with the visit and kitchen screens, never in the shell chunk.
- [ ] **9.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS.
- [ ] **9.5 Commit** `feat(game): quests, trust and the apprentice ledger; one progress log on device and account`
