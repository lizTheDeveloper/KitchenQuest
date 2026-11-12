# Step 5 — Build: stall schema and validation, the lazy market bundle and the stall voice scan

The content build already reads `content/market/*.yaml`. It strips them from the client module, because nothing used them (M4 Step 12B; `content-plugin.ts` `load()`; `ClientContent = Omit<GameContent, 'stalls'>`). This step does three things:
- it validates the stall files strictly, with core's checks;
- it ships them as their own **lazy** module, `virtual:kq-market`, which only the market screens import;
- it puts every stall line under the voice scan, which `content/README.md` promised "when M6 gives them a screen".

First paint must stay ≤ 352 KB (README constraint).

**Files:**
- Create:
  - `apps/game/src/market/content.ts`: `loadMarket(): Promise<MarketContent>`, the one dynamic `import('virtual:kq-market')`, memoised;
  - `apps/game/build/content/market.ts`: `compileMarket(files, graph): MarketContent`, the client shape of each stall;
  - tests: `apps/game/build/content/market.test.ts`, `apps/game/src/market/content.test.ts`.
- Modify:
  - `apps/game/build/content/schemas.ts`: `stallFile` becomes strict:
    - `games` (record);
    - `questions`, `variants.protein_counter.{persona, triggers, questions, item_tips, faq}`;
    - `seasonal` (record of region → record of month → questions);
    - `item_tips` (record of `{ pick, store }`);
    - `faq` (`{ q, a, a_if_blocked?, tags? }`);
    - per question `countries?` and `chalkboard?`;
    - `art`, `stall` (strings).

    Unknown keys fail, as cook files do;
  - `apps/game/build/content/compile.ts`:
    - run `validateStallFile` on each stall, `validateSeasonTable` on `data/seasonality.yaml`, `seasonalAgrees` on Wen, and `validateRewards` with `market_game`;
    - fail naming the file and the key path;
    - pin option order (below);
    - require the new Pan triggers;
  - `apps/game/build/content/read.ts`: `DATA_FILES` += `data/seasonality.yaml`;
  - `apps/game/build/content-plugin.ts`: resolve and load `virtual:kq-market` (the market module) next to `virtual:kq-content`, and keep `stalls` out of `virtual:kq-content` as now;
  - `apps/game/src/virtual.d.ts`: declare `virtual:kq-market`;
  - `apps/game/src/content/types.ts`:
    - `StallFile`, `StallVariantFile`, `StallQuestion` and `StallOption` re-export core's (C33 pattern; core's `StallFile` carries `triggers`, `persona?`, `art` and `stall`, Step 1);
    - `MarketContent`;
    - `GameContent` gains `seasonality`;
    - `ClientContent` becomes `Omit<GameContent, 'stalls' | 'seasonality'>`: still no stalls, and the seasonal table ships only in `virtual:kq-market` (`MarketContent.seasonality`). Step 10's list and plan-view season notes read it from `loadMarket()` and appear once it resolves; nothing waits on it;
  - `apps/game/src/content/required.ts` (+ `required.test.ts`): the Step 4 Pan triggers, each with its `ai` value; the stall safety triggers pinned `ai: never` with their first lines, per stall as the files have them today: `out_of_stock` and `out_of_stock_none` at all four; `medical` at Wen, Bram and Okafor-Sato; `religious_rules` at Bram; `allergen_note` at the Spice Merchant (which has no `medical`);
  - `apps/game/src/content/voice-scan.test.ts`: scan `MarketContent` too (every stall line, prompt, option text, reaction, explain, tip, FAQ answer and the variant's content);
  - `apps/game/src/content/voice-allowlist.ts`: entries for legitimate stall teaching lines the patterns catch (below);
  - `apps/game/build/budget-plugin.ts` (+ `budget-plugin.test.ts`): `checkFirstPaintBudget` also fails when a chunk containing the market module's marker is among first paint's static imports, and the build logs the market chunk's size;
  - `content/README.md`: "The voice scan" paragraph says the stalls are scanned now.

**`MarketContent`** (the client shape, built by `compileMarket`):
```ts
export interface MarketContent {
  stalls: Record<StallId /* not 'general' */, ClientStall>;
  seasonality: SeasonTable;
  /** sha256 of the canonical stall JSON: the content version for the service worker cache name (sw-plugin). */
  version: string;
}
/** A stall as shipped: `persona` and writers' `when`/`notes` dropped (no model reads them in M6, Ruling 21). */
export type ClientStall = Omit<StallFile, 'persona'> & { variants?: { protein_counter?: Omit<StallVariantFile, 'persona'> } };
```
- **Option-order pin (Ruling 2).** `apps/game/build/content/market-pins.json` (generated, committed) maps each shipped question id to a hash of its option texts in order. The build fails when an existing id's options change order or text, with "give the question a new id". A deliberate text fix updates the pin in the same commit, and the pin diff is reviewed. New ids are added automatically on `npm run content:pin -w @kitchenquest/game` (a new script), never by the build itself.
- **Voice scan of the stalls.** No pattern is weakened (M5 Ruling 24). Lines the patterns catch that are legitimate teaching go in `VOICE_ALLOWLIST` by file, key path and exact text, each with a reason. Expected entries:
  - Bram's "price per pound lies; price per serving tells the truth" lines;
  - the value questions' "price" prompts (§3.5 teaches cost per serving);
  - Wen's "Sold out of {item}" (stock, not urgency).

  Everything else the scan catches is reworded in Step 4's style and flagged for content review. The scan also fails on "smuggled" and on any currency symbol (`$ £ € ¥ ₹ ₩ ₦ ₱ ¢`) in stall text, as two new patterns. "version of" and "exotic" were already patterns.
- **Size.** The market chunk is expected around 110–130 KB minified (the stall JSON minus personas and writer notes). It is precached by `sw-plugin.ts` (every bundle file), so practice works offline. First paint gains nothing from this step except the `loadMarket` stub, which is itself only imported by lazy screens.

- [ ] **5.1 Write the failing tests:**
```ts
// build/content/market.test.ts
test('compileMarket strips persona and writer notes; keeps questions, variants, seasonal, item_tips, faq', ...);
test('a stall file with an unknown key / a contains id not in the graph / two correct options → ContentError naming file and path', ...);
test('Wen seasonal disagreeing with data/seasonality.yaml → ContentError naming the question id', ...);
test('an existing question with re-ordered options → fails with "give the question a new id"', ...);
test('the client content module still has no stalls; virtual:kq-market has all four', ...);
// budget-plugin.test.ts
test('a bundle whose first-paint chunks include the market module fails the budget check', ...);
test('the real build: first paint ≤ 352 KB and no first-paint chunk carries stall content', ...);
// voice-scan.test.ts
test('every MarketContent string passes the voice scan; "smuggled" and currency symbols are patterns', ...);
// required.test.ts
test('the Step 4 Pan triggers exist with their ai values; stall safety triggers are ai: never with pinned first lines', ...);
// src/market/content.test.ts
test('loadMarket imports once and memoises; a failed import rejects (the screen shows its offline line), never a partial bank', ...);
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/game -- market budget voice-scan required compile` → FAIL.
- [ ] **5.3 Implement.** Then run `npm run build -w @kitchenquest/game`, read the logged first-paint and market-chunk sizes, and put them in the report.
- [ ] **5.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS. Existing screens are untouched.
- [ ] **5.5 Commit** `build(game): strict stall content, a lazy market bundle, and the voice scan over every stall line`
