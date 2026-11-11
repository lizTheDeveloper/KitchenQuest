# Step 9 — Game: the market scene and the stall minigames

The market as a place:
- **The hub, `#/stalls`.** The `bg_market` backdrop has the four keepers as Phaser hotspots (`grocer`, `butcher`, `tofu`, `spice_merchant`), over an HTML list of stalls that carries everything without the canvas (§3.4, Ruling 15).
- **Each stall, `#/stall/<id>`.** It opens with the keeper's greeting, a short round of their questions (`ROUND_SIZE`), their item tips and their FAQ chips.

Every question shown comes from core `stallBank`, already rules-checked (Step 1). Wen's seasonal round appears only when the player's own region has a table (Step 2), and correctness comes from core `scoreAnswer`. Finishing or leaving a round records one `stall_round` event (Step 3) through M5's progress service.

There is no timer, no score, no lives and no "in a row". Practice runs any day. Nothing here touches the shopping list (Step 10 owns market day).

**Family Table mode** (§19, M5 Ruling 25):
- rounds play by tapping, with the keepers' written lines;
- nothing is recorded: no event and no stamp;
- no FAQ chips, and the mentor panel is M4's Family Table panel;
- Bram's chalkboard numbers keep their example-price footnote.

**Files:**
- Create:
  - `apps/game/src/market/stalls-screen.ts`: the hub (backdrop plus HTML list, one button per stall with its keeper's name and the round's games);
  - `apps/game/src/market/stall-screen.ts`: one stall (greeting, round, tips, FAQ chips, leave);
  - `apps/game/src/market/round-view.ts`: one question at a time;
  - `apps/game/src/market/stall-context.ts`: `marketCtxFor(store, profile, today)` and `seasonFor(profile, table, today)`;
  - `apps/game/src/market/record.ts`: `recordRound`;
  - `apps/game/src/scenes/MarketScene.ts`: hotspots that `emitAction('stall:<id>')` (bridge);
  - unit tests beside each; `apps/game/e2e/market.e2e.test.ts`.
- Modify:
  - `apps/game/src/shell/router.ts` (+ `router.test.ts`): `{ name: 'stalls' }` and `{ name: 'stall'; id: StallId }`, the id checked against the closed stall set;
  - `apps/game/src/shell/screens.ts`, `titles.ts`: lazy screens; the titles "The Market" and the keeper's name;
  - `apps/game/src/scenes/phaser-host.ts` (`SceneKey` += `'Market'`), `phaser-game.ts` (register `MarketScene`; Phaser stays lazy);
  - `apps/game/src/kitchen/kitchen-screen.ts`: a "The Market" link (first-paint cost: one route entry);
  - `apps/game/src/week/market-screen.ts`: a "Visit the stalls" link (it costs nothing; the list never waits on it);
  - `apps/game/src/progress/announce.ts`: `stamp_earned.market_game`, its `{stall}` from the event's `stall` through `content.stallNames`;
  - `apps/game/src/progress/catalogue.ts`, `service.ts`: the device `Catalogue` gains `market` (core `Catalogue.market`, built from `MarketContent.stalls`) once `loadMarket` resolves. `ClientContent` has no stalls, and `catalogueOf` is built once from it today, so without this the device's `grantsFor` would reject every `stall_round` (`bad_event`) instead of judging it as the API does (C14);
  - `apps/game/e2e/screens.ts`: `#/stalls`, `#/stall/<id>` for the never-rules and a11y sweeps.

**Interfaces:**
- Consumes:
  - `loadMarket`, `MarketContent` (Step 5);
  - `stallBank`, `stallVariant`, `nextRound`, `optionOrder`, `scoreAnswer`, `tipFor`, `faqFor`, `ROUND_SIZE` (Step 1);
  - `seasonRegionFor`, `monthOf`, `seasonalQuestions` (Step 2);
  - `stall_round`, `ProgressView.marketAnswered` (Step 3);
  - `progressService().record`, `newEventId` (M5 Step 9); `rulesOf` (M5 `week/context.ts`);
  - `mountBackdrop` (M3); `writtenLine` / the dialogue picker (M3/M4); `content.bureau.forms.stall` (Form 14-S, Step 4);
  - the device profile or `GET /profile` (M2/M4) for country and region.
- Produces:
```ts
// market/stall-context.ts
export function marketCtxFor(rules: Rule[] | null, profile: { country: string | null; region: string | null }, today: string,
  graph: IngredientGraph, subs: Substitution[]): MarketCtx | null;   // null while rules can't be read → market.stall_wait
export function seasonFor(profile, table: SeasonTable, today: string): { regionId: string | null; month: number };
// market/record.ts
/** One stall_round per round (finished or left with ≥ 1 answer). Never in Family Table. Never with a correct flag. */
export function recordRound(deps: { store: PlayerStore; record: ProgressService['record'] }, stall: StallId, answers: { q: string; pick: number }[], today: string): void;
```
- **Round view:**
  - the keeper's prompt is shown, then the options as buttons in `optionOrder(q.id, n)`;
  - after a tap: the stall's `correct` or `wrong` line (or the Pan's `market.cheer` / `market.wrong`), then that option's `reaction`, then `explain`, then "Next" and "Leave the stall";
  - the answer is final: no re-pick on that question in this round;
  - the round ends with `market.round_done`; leaving mid-round says `market.leave_round`.

  It never shows a number of questions answered, right or left. A visible "Question 2" heading is allowed for orientation only. It has no total and no progress bar: no "x/5".
- **Ripeness:** when `art/items/<ingredient>.png` exists in the assets manifest for an option's `contains`, it is shown beside the option text (alt text is the option text). Text always carries the whole hint (Ruling 15).
- **Value (chalkboard):** the `chalkboard` renders as a small table (option, price, servings), with Form 14-S's footnote "Example prices in no particular currency" right under it, in every mode. There is no currency symbol and no "buy".
- **Bank states:**
  - rules can't be read → `market.stall_wait`;
  - the bank had drops → `market.bank_small` (never which);
  - an empty bank → that line plus "visit another stall";
  - no region table → `market.no_calendar` once, and Wen runs ripeness and storage only.
- **Variant:** the Protein Counter has its own name, greeting and art. Its sign says "Protein Counter", and nothing calls it a lesser stall.
- **FAQ chips** (Ruling 21): the first `q` of each entry, answered from `faqFor`. No text box.
- Each screen is axe-clean, keyboard-complete (options in a radiogroup-free button list, focus moved to the reaction after an answer), readable at 320 px, and works with reduced motion and with no canvas.

- [ ] **9.1 Write the failing tests:**
```ts
test('stallBank output only: a soy rule shows no tofu question at Okafor-Sato\'s; a vegetarian sees the Protein Counter', ...);
test('options render in optionOrder; pick sent is the FILE index; the event has no correct flag', ...);
test('a wrong answer shows its reaction and explain and records nothing negative; XP never shown as lost', ...);
test('no timer, countdown, progress bar, "x/5", "in a row" or score element exists in the round DOM', ...);
test('leaving mid-round records the answers so far once; leaving with none records nothing', ...);
test('Family Table: rounds play, no event recorded, no FAQ chips, no text box', ...);
test('no region / an unmatched region → market.no_calendar, no seasonal question; pnw-usa in November → seasonal questions', ...);
test('rules null → market.stall_wait, no questions', ...);
test('questions with a chalkboard show it and the example-price footnote; no currency symbol in the DOM', ...);
test('signed out, a finished round is judged by the device catalogue with market loaded: a first correct answer earns xp.market_game', ...);
test('router: #/stall/<unknown> → notFound; #/stalls and #/stall/wen parse', ...);
// e2e market.e2e.test.ts (mocked /api/**; 400 px and 1280 px; canvas on and off)
//   signed out + AI off: kitchen → The Market → Wen → a 5-question round → stamp line once → Bram as Protein Counter for a vegetarian device rule
//   signed in: the round posts one stall_round; the mocked grants show XP; a second identical round earns no XP and no second stamp that ISO week
//   axe on #/stalls and #/stall/<each>, standard and Family Table
```
- [ ] **9.2 Run** `npm test -w @kitchenquest/game -- market router announce` and `npm run test:e2e -w @kitchenquest/game -- market` → FAIL.
- [ ] **9.3 Implement.** All of `market/` and `MarketScene` load lazily, and the build log shows first paint ≤ 352 KB.
- [ ] **9.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS. Check that no `EVAL_FILES` path changed (`git diff --stat` against Step 8's commit, Ruling 22).
- [ ] **9.5 Commit** `feat(game): the market — four stall keepers, rules-checked rounds, no clock and nothing to lose`
