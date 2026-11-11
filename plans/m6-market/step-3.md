# Step 3 — Core: stall rewards, market-list amounts and stall swaps

Three pieces of market-day logic, all in core so the device and the API decide the same thing:
- **Stall rewards** (Rulings 1 and 2): a new content-free progress event, `stall_round`, whose grants core computes from the stall file. The event says which option was picked; core decides whether it was right.
- **Amounts on Form 12-M** (Ruling 12), honest arithmetic only.
- **Stall swaps** (Ruling 11): out of stock → a curated substitute, offered only when every dish it serves still checks ✅ or 🔁 with it.

The check-off card and grammar are *not* here. They are mentor code, eval-hashed and decision-relevant, so they land in Step 8 with the eval run.

**Eval hash (Ruling 22):** core `progress/`, `week/` and `index.ts` change; same milestone-branch skip as Step 1.

**Files:**
- Create:
  - `packages/core/src/week/amounts.ts`: `Amount`, `listAmounts`, `formatAmounts`;
  - `packages/core/src/week/stock.ts`: `StockSwap`, `stockSwaps`, `markOutOfStock`, `takeStockSwap`, `undoStock`, `stockSwapsFor`, `checkWithStockSwaps`;
  - `packages/core/src/progress/market.test.ts`, `packages/core/src/week/amounts.test.ts`, `packages/core/src/week/stock.test.ts`.
- Modify:
  - `packages/core/src/progress/types.ts`: the `stall_round` event; `XpReason` += `'market_game'`; `StampId` += `'market_game'`; `Catalogue.market`; `ProgressView.marketAnswered`;
  - `packages/core/src/progress/rewards.ts`: `validateRewards` requires `xp.market_game` and `stamps.market_game`; `evaluate` validates and grants `stall_round`; a new exported `isHealthRevealing(event, cat)`;
  - `packages/core/src/progress/fold.ts`, `derive.ts`: fold `stall_round` into `marketAnswered`, `compactHistory` and `snapshotOf` keep it (C15 semantics unchanged);
  - `packages/core/src/week/market-list.ts`: `ListItem` gains `amounts`, `outOfStock` and `stockSwap`; `marketList` fills `amounts` (names-only comment removed);
  - `packages/core/src/week/index.ts`, `packages/core/src/index.ts`, `packages/core/src/engine.ts`;
  - `packages/core/src/progress/fixtures.ts`: a fixture catalogue with two stalls (one with a `protein_counter` variant).

**Interfaces:**
- Consumes: `StallFile`, `StallQuestion`, `scoreAnswer`, `questionStatus`, `stallVariant`, `MAX_ROUND_ANSWERS` (Step 1); `grantsFor`/`grantsForBatch`, `RulesContext`, `isoWeek`, `MAX_PROGRESS_EVENTS_PER_DAY` (M5); `marketList`, `ListItem`, `MarketRunView`, `Plan`, `PlanContext`, `itemDate` (M5); `checkWithNotes`, `MarginNote` swap ops (M5 `book/`); `toGrams`'s unit table (M1 `nutrition/units.ts`, for normalising unit spellings only); `Substitution` (M1).
- Produces:
```ts
// progress/types.ts
| { id: string; kind: 'stall_round'; at: string; stall: string; answers: { q: string; pick: number }[] }
// Catalogue
market: ReadonlyMap<string /* stall id */, {
  questions: ReadonlyMap<string /* question id */, { question: StallQuestion; variant: 'base' | 'protein_counter' | 'seasonal' }>;
  file: StallFile;            // for stallVariant / questionStatus with the player's rules
}>;
// ProgressView
marketAnswered: Record<string /* question id */, { correct: boolean; lastAt: string }>;

// progress/rewards.ts
/**
 * stall_round is accepted when: the stall is in cat.market; 1–MAX_ROUND_ANSWERS answers; each q is that stall's and
 * appears once; each pick is in range; and, with `rules`, each question's questionStatus is ok/swap for the player on
 * `at` (a hidden question can't be answered: the event is rejected `bad_event`, nothing stored). Without `rules` (the
 * device, signed out, before rules load) grantsFor rejects it `rules_unknown`, so the caller retries once rules load
 * (fail closed, M5 C5 pattern).
 * Grants: xp market_game per answer correct by scoreAnswer AND never correct before in history (Ruling 1);
 * stamp market_game once per stall per isoWeek(at), for any accepted round.
 */
export function isHealthRevealing(e: ProgressEvent, cat: Catalogue): boolean; // a stall_round with any 'protein_counter' question (Ruling 17)

// week/amounts.ts
export interface Amount { quantity: number | null; unit: string | null; text: string }   // text is the display form, e.g. "450 g", "a handful"
/** Ruling 12: per dish, scale each line by plan servings ÷ recipe servings; sum only when normalised units agree. */
export function listAmounts(lines: readonly { quantity: number | null; unit: string | null; servingsFactor: number }[]): Amount[];
export function formatAmounts(a: readonly Amount[]): string;   // "2 tbsp + 1 cup"; [] → ""

// week/stock.ts
export interface StockSwap { toId: string; toName: string; note: string; dishes: string[] }
export const MAX_STOCK_SWAPS_PER_RUN = 21;
/**
 * Ruling 11: candidates from `subs` whose `from` resolves to the row's ingredient (own id, not isA ancestors: a swap
 * is for a concrete item) and whose `unsafeFor` doesn't touch any active rule target; each kept only when, for every
 * slug in row.forDishes, checkWithNotes(recipe, [swap as a note op], rules, graph, subs, itemDate(plan, item)) is ok or
 * swap. A row already swapped by the rules engine (swappedFor) or ❓ (unverified) offers none.
 */
export function stockSwaps(row: ListItem, plan: Plan, ctx: PlanContext): StockSwap[];
export function markOutOfStock(run: MarketRunView, key: string): MarketRunView;                        // row.outOfStock = true, unticked
export function takeStockSwap(run: MarketRunView, key: string, swap: StockSwap): { run: MarketRunView; added: ListItem };
  // added: { key: swap.toId, name, ingredientId, stall: stallFor(..), forDishes: row.forDishes, stockSwap: { from: row.key }, ticked: true }
export function undoStock(run: MarketRunView, key: string): { run: MarketRunView; removedKey: string | null };   // clears outOfStock, removes the added row
/** For cook mode: the swaps a run made for one dish, as margin-note swap ops (labelled "swapped at the market"). */
export function stockSwapsFor(run: MarketRunView | null, slug: string): { from: string; to: string }[];
export function checkWithStockSwaps(recipe, swaps, rules, graph, subs, date): CheckResult;  // = checkWithNotes with synthetic notes
```
- `ListItem` additions: `amounts?: Amount[]` (absent when every line was a null quantity, so the row shows no amount, never "0"), `outOfStock?: true`, `stockSwap?: { from: string }`. `MarketRunView` is unchanged otherwise (C40: one shape for the API and the device).
- A row's key stays stable (C20). A stock swap's added row keys on `swap.toId` with a `stock:` prefix, so it never merges with a plan row for the same ingredient. That keeps it undoable on its own.
- `isHealthRevealing` is the only place that decides which events the API seals (Step 6) and the health-data delete erases.
- No function here counts consecutive days or weeks. `no-streak.test.ts` already scans `progress/` and `week/`.

- [ ] **3.1 Write the failing tests:**
```ts
// progress/market.test.ts
test('stall_round: a correct first answer earns xp.market_game; the same question correct again earns nothing', ...);
test('a wrong answer earns nothing and lowers nothing; the round still earns the stall stamp once per ISO week', ...);
test('two rounds at one stall in one ISO week → one stamp; different stalls → one each; next ISO week → again', ...);
test('the event carries picks, never a correct flag; a forged "correct" key → bad_event; an out-of-range pick → bad_event', ...);
test('a question the player\'s rules hide → bad_event, nothing stored; without rules → rules_unknown', ...);
test('more than MAX_ROUND_ANSWERS answers or a repeated q → bad_event', ...);
test('isHealthRevealing: true for any protein_counter question, false for base and seasonal', ...);
test('marketAnswered folds lastAt and ever-correct; compactHistory + snapshot keeps it (C15 property, fast-check)', ...);
test('Guild and free players get identical grants for identical stall rounds (no entitlements import, architecture test)', ...);
test('validateRewards requires xp.market_game and stamps.market_game', ...);
// week/amounts.test.ts
test('2 servings of a 4-serving recipe halves; g + kg sum; tbsp + cup listed side by side; null quantity → shown as written', ...);
test('a line with no quantity in any dish → no amounts field (never "0")', ...);
test('a ⛔ dish adds no amounts; a sacred dish adds nothing (M5)', ...);
// week/stock.test.ts
test('stockSwaps: shallot → onion offered for parippu with no rules; with an allium rule → none', ...);
test('a swap whose result is ❓ for any dish it serves is not offered', ...);
test('a rules-engine-swapped row and a ❓ row offer no stock swap', ...);
test('take → row outOfStock, a ticked stock: row labelled with its dishes; undo → both restored exactly', ...);
test('stockSwapsFor + checkWithStockSwaps: cook mode sees the swap; a rule added afterwards makes it ⛔, never ✅', ...);
```
- [ ] **3.2 Run** `npm test -w @kitchenquest/core -- market amounts stock rewards derive` → FAIL.
- [ ] **3.3 Implement.**
- [ ] **3.4 Run** `npm test -w @kitchenquest/core`, `npm test -w @kitchenquest/game`, `MENTOR_EVAL_GATE=skip-no-network npm test -w @kitchenquest/api` (milestone branch) → PASS. The game typechecks: `ListItem`'s new fields are optional.
- [ ] **3.5 Commit** `feat(core): stall-round rewards decided from the stall file, honest list amounts, rules-checked stall swaps`
