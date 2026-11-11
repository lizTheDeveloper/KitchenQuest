# Step 10 — Game: plan, market list, Use-It-Up Rescue and frames in cook mode

The week, on screen:
- **Plan:** the player plans by telling the Pan (plan cards from Step 8, or the scripted engine's own plan cards with the AI off) or on the Form 7-W fallback screen (`#/plan`). The plan shows each dish's rules status, the food-group flag, and, once a week at most, One More Technique.
- **Market list:** `#/market` is Form 12-M, grouped by stall. Ticking puts the item in the pantry with today's date.
- **Rescue:** the kitchen may offer one Use-It-Up Rescue a day (in-app only).
- **Frames:** cook mode runs Pantry Frames as well as recipes.

Signed out, the plan and the list live on the device. The writes go through `writer.ts` exactly like M4's local cards.

**Family Table mode** (`settings.familyTable`, spec §19; Ruling 25, C31): the plan and market screens show the plan, its checks and the list with their lines and chips, but write nothing: no plan save, no tick into the pantry, no "That's the shop done", no slot answer recorded and no rescue (compost removes a pantry row, so it is a write). The panel stays M4's Family Table panel (no text box, no cards). Nothing is kept.

**Files:**
- Create:
  - `apps/game/src/week/plan-screen.ts`: Form 7-W, day rows, add/remove dish, hard-week toggle, the weekly slot;
  - `apps/game/src/week/plan-view.ts`: a shared renderer for plan cards and the screen, with status chips ✅ / 🔁 / ❓ / ⛔ and the findings;
  - `apps/game/src/week/market-screen.ts`;
  - `apps/game/src/week/local-week.ts`: the device plan and run, with the same shapes as the API;
  - `apps/game/src/week/rescue.ts`: rescue offer, compost, nudge-per-day memory;
  - `apps/game/src/cook/frame-cook.ts`: slot picker, then generic steps through the cook-mode renderer.
- Modify:
  - `apps/game/src/shell/router.ts` (+ test): routes `plan`, `market`, `frame/<id>`;
  - `apps/game/src/shell/screens.ts`, `titles.ts`: lazy screens;
  - `apps/game/src/mentor/scripted.ts`: `planIntent` / `navIntent` → plan card or `go` chip (core, Step 8);
  - `apps/game/src/mentor/writer.ts`: replaces Step 8's minimal cases: the `plan` card → `PUT /plans` or `local-week`; undo restores; the `go` part → a chip item;
  - `apps/game/src/mentor/cards-view.ts`: the full plan card (7-W slip, rendered by `plan-view.ts`) and the `go` chip (a button with `nav.offer`; tapping navigates, nothing else does), replacing Step 8's minimal cases;
  - `apps/game/src/mentor/panel.ts`: render `go` parts as chips;
  - `apps/game/src/api/{client,types}.ts`: `getPlan`, `putPlan`, `deletePlan`, `openRun`, `tick`, `finishRun`;
  - `apps/game/src/state/store.ts`: `localWeek`; `settings.rescueNudges: boolean` (default on);
  - `apps/game/src/settings/settings-screen.ts`: the rescue nudges toggle (audit M-14 "can be turned off");
  - `apps/game/src/cook/cook-screen.ts`: accepts a frame source; finishing a frame emits `frame_cooked`;
  - `apps/game/src/kitchen/kitchen-screen.ts`: the rescue slot and the "This week" link.
- Test: unit tests beside each new module; `apps/game/e2e/week.e2e.test.ts` (new); extend `apps/game/e2e/mentor.e2e.test.ts`.

**Interfaces:**
- Consumes: `checkPlan`, `planFlags`, `marketList`, `MarketRunView`, `KeepsMap`, `rescueCandidate`, `fillFrame`, `Frame`, `FilledFrame` (Step 3); `weeklySlot` (Step 2); `planWeekStart` (Step 1); `buildPlanCard`, `PlanCard`, `planIntent`, `navIntent`, `NavTarget` (Step 8); Step 6 routes; Step 9 `record`; `ClientContent` `frames`, `keeps`, `foodGroups`, `stallOf`, `stallNames` (Step 4).
- Produces:
```ts
// week/local-week.ts
export interface WeekStore { plan(weekStart: string): Plan | null; savePlan(p: Plan): { previous: Plan | null };
  run(weekStart: string): MarketRunView | null; tick(key: string, ticked: boolean): void; finish(): void }
export function createWeekStore(deps: { store: PlayerStore; client: ApiClient | null; signedIn(): boolean }): WeekStore;
// week/rescue.ts
export function rescueOffer(state: PlayerState, plan: Plan | null, today: string, frames: Frame[], keeps: KeepsMap, rules: Rule[],
  graph: IngredientGraph, subs: Substitution[]):   // subs passed through to fillFrame (C41)
  { item: PantryItem & { id: string }; frame: Frame; filled: FilledFrame } | null;
  // null when settings.rescueNudges is off, settings.familyTable is on, already nudged today, or the filled frame is ⛔
// cook/frame-cook.ts
export function frameCook(el: HTMLElement, frame: Frame, deps): void;   // pick fillers (only passing ones selectable; ❓ ones selectable with the ❓ badge), then cook mode
```
- Plan screen and plan card (one renderer):
  - **Day rows:** each item shows the dish, its status chip and its findings.
    - A ⛔ item, from a rule added after saving, shows `plan.blocked_dish` and an adapted version if the engine has one. Its Cook button is disabled.
    - A ❓ item shows `plan.unverified_dish`.
  - **Food-group flag** below: `plan.gap_green`, `plan.gap_protein` or `plan.balanced`.
  - **The weekly slot:** `one_more.offer` or `one_more.refresh`, with "Yes, add it" and "Not this week". Declining shows `one_more.declined` and records the week. It is never shown in a hard week.
  - **Hard week** is a toggle on the form, and a phrase to the Pan.
  - **No counts** of meals planned versus a target, and no empty-day nagging.
- Market screen:
  - one section per stall, headed with `content.stallNames[stall]` (C11);
  - each row is a checkbox button with the dish it's for; a swap is shown labelled;
  - "That's the shop done" is a tap that finishes the run (`market.run_done`) and records `market_run` once a week;
  - no timer, no "items left" pressure copy;
  - the stall minigames are M6. The page says nothing about them.
- Rescue (kitchen):
  - at most `RESCUE_NUDGES_PER_DAY` (1), and only when the kitchen is open (no push, M9);
  - shows `rescue.offer` with "Cook the frame", "Compost it" and "Not now". Compost removes that pantry id and shows `rescue.compost`. "Not now" counts as today's nudge.
  - A frame whose filled result is ⛔ is never offered. A ❓ one is offered with `rescue.unverified` and the ❓ badge.
- Frames in cook mode:
  - the player picks each slot from candidates;
  - blocked candidates are absent, and unresolved ones carry ❓;
  - a required empty slot shows `frame.slot_empty`, and Cook stays disabled until it is filled;
  - the steps render with the chosen names. Timers and wake lock are M3's.
- AI off and signed out, the whole week works: "plan my week: parippu on Sunday" → scripted plan card → local save → list → tick → local pantry items with dates → rescue.

- [ ] **10.1 Write the failing tests:**
```ts
test('plan view: a blocked item has a disabled Cook and plan.blocked_dish; ❓ never renders ✅', ...);
test('weekly slot: offered once; declined → never again this week; hard week → none', ...);
test('scripted engine: "plan my week: parippu on Sunday" → plan card; tap → saved locally (signed out) / PUT /plans (signed in)', ...);
test('scripted engine: "dal on Sunday" → plan.dish_unknown, no card (C1)', ...);
test('Family Table: plan and market screens render with no save, tick, finish or rescue control; nothing written to the store (C31)', ...);
test('go chip: rendered as a button; nothing navigates until it is tapped; never beside child.grownup', ...);
test('market: ticked → local pantry item with addedOn today and source market; untick removes that id only', ...);
test('rescue: one a day; off in settings → none; compost removes the item and shows rescue.compost; subs reach fillFrame (a swap filler is offered with 🔁)', ...);
test('market: each stall section is headed by its stallNames entry; general has a name', ...);
test('frame cook: blocked candidates absent; unresolved shows ❓; required empty slot disables Cook', ...);
// e2e week.e2e.test.ts: AI off + signed out — plan → list → tick → cook a frame from a rescue; AI on (mocked) — plan card from /mentor/turn
```
- [ ] **10.2 Run** `npm test -w @kitchenquest/game -- week rescue frame scripted writer router` and `npm run test:e2e -w @kitchenquest/game -- week mentor` → FAIL.
- [ ] **10.3 Implement.** New screens are lazy and keep the first-paint budget. Every new HTML panel is axe-clean, keyboard-complete, and readable at 320 px.
- [ ] **10.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS.
- [ ] **10.5 Commit** `feat(game): the week — plan, market list, one weekly technique, use-it-up rescue and frames`
