# Step 10 — Game: market day (amounts, stall swaps, Season's Table, errands, check-off, drill-first hint)

The shopping trip itself, on screen. Form 12-M (`#/market`, M5 Step 10) gains:
- amounts;
- an honest season note per produce row;
- an "Out of stock?" control that offers the stall keeper's rules-checked swap.

The plan view gains The Season's Table note per dish. A quest errand now plays its stall's question for the item before the step completes, and the step passes whatever is answered. The Pan's check-off card gets its full UI, and the scripted engine builds it with the AI off. The drill-first hint (Ruling 16) appears on recipe and cook screens. **None of this gates anything:** the list, ticks, the finish, errands and Cook work exactly as before for a player who ignores every new control.

**Family Table mode** (M5 Ruling 25, C31):
- the list shows amounts and season notes;
- no "Out of stock?" write, no swap and no check-off card;
- an errand's question plays but records nothing;
- no drill-first hint.

**Signed out:** stock swaps and check-off go through `local-week.ts` with the same core functions, as M5's ticks do.

**Files:**
- Create:
  - `apps/game/src/week/stock-view.ts`: the per-row "Out of stock?" control, swap chips and undo;
  - `apps/game/src/week/season-note.ts`: `seasonNoteFor(item, season, table, graph)` and `dishSeasonNote(...)`, rendering core `seasonOf` / `dishSeason` with `season.now` / `season.other`;
  - `apps/game/src/recipes/drill-first.ts`: `drillFirstFor(recipe, toolkit, techniques, quests)` (signature below). It lives game-side on purpose: only the game uses it, and core `toolkit/` is eval-hashed (Ruling 22);
  - `apps/game/src/mentor/check-off-card.ts`: the card renderer;
  - unit tests beside each; `apps/game/e2e/market-day.e2e.test.ts`.
- Modify:
  - `apps/game/src/week/market-screen.ts`: amounts (`formatAmounts`), the season note, and `stock-view` per row (not for ⛔, ❓ or rules-swapped rows: core offers none);
  - `apps/game/src/week/local-week.ts`, `source.ts`: `stock(key, action, toId?)` on the device and through the API;
  - `apps/game/src/week/plan-view.ts`: The Season's Table note under each dish (information only; no reorder, no badge colour);
  - `apps/game/src/api/{client,types}.ts`: `stock()`;
  - `apps/game/src/quests/quest-runner.ts` (+ test): the errand question;
  - `apps/game/src/mentor/scripted.ts`: `checkOffIntent` with the current run (device or account) → a local `check_off` card;
  - `apps/game/src/mentor/writer.ts`: replaces Step 8's minimal case; confirm → `tick` per key; undo → untick;
  - `apps/game/src/mentor/cards-view.ts`, `panel.ts`: the full card; `go` chips for `stalls` / `stall`;
  - `apps/game/src/cook/cook-screen.ts`: for a dish planned this week whose run has stock swaps, a label "swapped at the market: Y for X" and the check from `checkWithStockSwaps`. ⛔ disables Cook as everywhere;
  - `apps/game/src/recipes/card-view.ts`, `recipe-screen.ts`: the drill-first line and chip.

**Interfaces:**
- Consumes:
  - `listAmounts`, `formatAmounts`, `stockSwaps`, `markOutOfStock`, `takeStockSwap`, `undoStock`, `stockSwapsFor`, `checkWithStockSwaps` (Step 3);
  - `seasonOf`, `dishSeason`, `seasonRegionFor`, `monthOf` (Step 2); `stallBank`, `scoreAnswer`, `optionOrder` (Step 1); `round-view.ts`, `recordRound`, `marketCtxFor`, `seasonFor` (Step 9);
  - `POST /market-runs/:id/stock` (Step 6);
  - `checkOffIntent`, `buildCheckOffCard`, `CheckOffCard`, `NavTarget` `stalls`/`stall` (Step 8);
  - M5's `WeekSource`, `MarketRunView`, `runQuest`, `errandAllowed`, the toolkit view.
- Produces:
```ts
// week/stock-view.ts
export function stockControl(row: ListItem, deps: { swaps: StockSwap[]; act(a: StockAction): Promise<Result>; familyTable: boolean }): HTMLElement | null;
  // null in Family Table, for a ticked, ⛔, ❓ or rules-swapped row. Two taps: "Out of stock?" → the stall's out_of_stock line
  // with one chip per swap (each labelled with the dishes it is for) and "Skip it this week"; or out_of_stock_none / market.no_swap.
  // Taking a swap shows market.stock_swapped; an "Undo" puts both rows back.
// recipes/drill-first.ts
export function drillFirstFor(recipe: ParsedRecipe, toolkit: ToolkitState, techniques: TechniqueNode[], quests: Quest[]):
  { technique: string; cook: string; questId: string } | null;   // first skill (recipe order) with a prereq below Seen that a quest drill teaches
```
- **Errand question:** when an errand step's stall bank (rules-checked, Step 1) holds a question with a `contains` id that is the errand's item or one of its `isA` ancestors (Marisol's `black_bean` errand matches an Okafor-Sato `bean` question; Leela's `shallot` errand matches no question today, since Wen has no shallot question, so it shows none), `errand.question` plays that one question with `round-view`, and then the step goes on exactly as M5 (pantry or tap). If no question passes, nothing is shown. The answer is recorded as a one-answer `stall_round`, except in Family Table. **The step's completion never depends on the answer**, and a test pins that both a right and a wrong answer complete it with identical quest grants.
- **Check-off card:** it lists the matched rows by their list names, then "Tick these", "Not now", and for each missing row "Out of stock?", which scrolls `#/market` to that row's stock control. Nothing ticks before the tap. Undo unticks each.
- **Season notes** (the table comes from `loadMarket()`'s `MarketContent.seasonality`, Step 5; the notes appear once it resolves, and the list never waits on it):
  - "in season where you are: {item}" (`season.now`), or the region's own category word (`season.other`);
  - never a red, grey or warning style, never on a ❓ or ⛔ row, and never a countdown;
  - with no region, no notes at all; `market.no_calendar` is said once, on the stalls hub (Step 9), not on the list.
- **Drill-first** (only if Ruling 16 holds; else skip 10.3c): `cook.drill_first` beside the Cook button, plus a `go` chip `{ to: 'visit', cook }`. Cook stays enabled, and nothing shows in Family Table or for a sacred dish.

- [ ] **10.1 Write the failing tests:**
```ts
test('market rows show amounts; a fuzzy amount shows as written; no amounts → nothing (never "0")', ...);
test('Out of stock? offers only core stockSwaps; take → a ticked "stall swap" row and a dated pantry item; undo restores', ...);
test('no stock control on a ⛔, ❓, ticked or rules-swapped row, or in Family Table', ...);
test('cook mode for a dish with a stall swap shows the label and the checkWithStockSwaps status; a new rule → ⛔ and Cook disabled', ...);
test('season notes: pnw-usa November → "in season where you are" on squash; no region → none; never on a ❓ row', ...);
test('plan view season note is text only; plan order and suggestPlan output are unchanged (snapshot)', ...);
test('errand: right and wrong answers both complete the step with identical grants; no passing question → no question shown', ...);
test('scripted: "got the shallots" with an open device run → local check_off card; tap ticks; undo unticks; Family Table → no card', ...);
test('scripted: "no fennel" → health path ask, no card (Ruling 13)', ...);
test('drill-first: shown when a prereq is below Seen; Cook enabled; absent in Family Table and on sacred dishes', ...);
// e2e market-day.e2e.test.ts (mocked /api/**; AI off signed out; AI on signed in with a mocked check_off card)
//   plan parippu → #/market amounts → Out of stock? shallot → take onion → cook parippu shows "swapped at the market"
//   "got the moong dal" → card → tap → row ticked; Marisol's black_bean errand plays an Okafor-Sato bean question; a wrong answer still completes it;
//   Leela's shallot errand shows no question (no stall question names shallot) and completes as in M5
```
- [ ] **10.2 Run** `npm test -w @kitchenquest/game -- stock season drill-first quest-runner scripted writer cards-view cook-screen plan-view` and `npm run test:e2e -w @kitchenquest/game -- market-day week quests` → FAIL.
- [ ] **10.3 Implement:** (a) list, stock and season; (b) errand and check-off; (c) drill-first, if Ruling 16 holds. Every new panel is axe-clean, keyboard-complete and readable at 320 px. First paint stays ≤ 352 KB.
- [ ] **10.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS. Confirm that no `EVAL_FILES` path changed since Step 8 (Ruling 22).
- [ ] **10.5 Commit** `feat(game): market day — amounts, stall swaps, the Season's Table, errand questions and the spoken check-off`
