# Step 4 — Data and content: market graph nodes, the seasonal table, stall content fixes and new lines

The stall files were written in M1 against an ingredient graph that has grown since. 38 of the 48 `contains` ids in `content/market/` are not graph nodes today: `beef`, `chicken`, `tofu`, `bean`, `avocado`, `cumin`, `asafoetida` and 31 more. So the rules engine can't check them. Step 1 makes such a question ❓, and Step 5 will fail the build on it. This step makes the content checkable and honest:
- **Graph nodes,** with only the allergen edges their sources state.
- **The seasonal table** for the one region that has sources.
- **Content fixes the rulings require:** example prices with no currency, chalkboard data, `countries:` scopes, the "well-travelled" rename, and the region-own seasonal options.
- **New lines** for the screens Steps 9–10 add.

Every new fact is `# REVIEW:`-flagged. JSON review flags go in `content/README.md`, because JSON has no comments.

**Side effect on the Pan.** New graph names ("bean", "pea", "chili", "tofu") feed the M4/M5 health detectors (`mentionsHealthTerm`, `leftoverNamedIngredients`) and the dish and pantry parsers. So the mentor's routing can change for messages that name them. That is the stricter side ("when in doubt, health"), and Step 8's eval run measures it. The implementer runs core's `route`, `intents` and `whole-message` tests and lists any changed expectation in the report. A changed expectation is fixed by data (an alias, `broad: true`), never by loosening a detector.

**Eval hash (Ruling 22, as overridden by the controller):** `data/ingredients.json` is eval-hashed. The eval gate is never skipped: run the API suite as is and report the `eval-gate.test.ts` failures as expected, as in Step 1. No PR.

**Files:**
- Create: `data/seasonality.yaml` (Ruling 9); `packages/core/test/market-content.test.ts` (runs Steps 1–2's validators over the real files with `node:fs` and `yaml`, like M5's `packages/core/test/quests-content.test.ts`; core `src/` is type-checked without Node's types, so it can't live in `src/market/`).
- Modify:
  - `data/ingredients.json`: the market nodes below;
  - `data/substitutions.json`: a reviewed handful of stall swaps for the launch dishes' market items (Ruling 11), e.g. `shallot → onion`, `green_chili → dried_red_chili`. Each has a `note`, and `unsafeFor` where the swap shares a rule target. An item with no honest swap (curry leaves) gets no entry, and the stall says `out_of_stock_none`;
  - `content/market/{wen,bram,okafor-sato,spice}.yaml`;
  - `content/dialogue/pan.yaml`: the new Pan triggers below; and `market.cheer`'s "Right again. I'm almost impressed. Almost." is reworded, because Step 9 plays `market.cheer` after any correct answer, the first included, and "again" counts a run of right answers (no-pressure rule; flagged for content review);
  - `content/bureau/forms.yaml` (`stamp_names.market_game` and the `rewards.yaml` amounts already landed in Step 3): Form 12-M's footnote "…per person. Example prices." loses "Example prices", since the list shows no prices (Ruling 5); a new Form 14-S/STALL for the minigame panel (title, `game` labels, the example-price footnote, "*No stall keeper will sell you anything. They are teachers with tables.");
  - `content/README.md`: the Market stall schema (new fields), Data files (`seasonality.yaml`, the new nodes), the review flags, and the founder review list.

**Graph nodes** (`data/ingredients.json`; `fdcId` and `per100g` from FDC where a record exists, else none; no edge beyond what the source states):
- **Meat, under `meat`** (so the vegetarian rule term already covers them): `beef`, `chicken`, `lamb`, plus `isA` children for cuts only where a question's `contains` needs them. `pork` exists.
- **Legumes:** `bean` (a category, `broad: true`, never a rule target, like `herb`; a category line still reaches a rule on any of its kinds through `check`'s `descendants` walk, so it needs no `labelDependent`); `kidney_bean`, `chickpea`, `pea` with `isA: [bean]`. `black_bean` is filed `isA: [bean]` too. `lentil` and `red_lentil` (`isA: [lentil]`). `pea` carries no lupin edge (`# REVIEW:` pea and lupin cross-reactivity is a clinical question, not a graph edge).
- **Soy:** `tofu` (`contains: [soy]`), with `silken_tofu`, `firm_tofu` and the other `item_tips` keys `isA: [tofu]`.
- **Produce** (no allergen edges): `avocado`, `apple`, `pear`, `banana`, `berry` (category), `strawberry`, `blueberry`, `cranberry` (`isA: [berry]`), `carrot`, `potato`, `winter_squash`, `zucchini`, `kale`, `leek` (`isA: [allium, fodmap_fructan]`, as `onion`, `shallot` and `garlic` are: `allium` alone doesn't reach a low-FODMAP rule's `fodmap_fructan` target; `# REVIEW:` leek fructans, green tops lower), `mushroom`, `lemon`, `mandarin`, `parsnip`, `asparagus`, `nettle`, `cilantro` (`isA: [herb]`), `chili` (category; `green_chili` and `dried_red_chili` filed under it).
- **Spices:** `cumin` (`cumin_seed isA cumin`), `cardamom`, `cinnamon`, `black_pepper`, `fennel` (the plant and bulb, under produce, no allergen edge) with `fennel_seed isA fennel` (so a "no fennel" rule reaches the seed; `fennel` is also the spec's §3.2 check-off example and Step 8's M03 case, which need a node), `saffron`, `oregano`.
- **Asafoetida:** `asafoetida` with `labelDependent: true` and `contains: [wheat]`. Compounded asafoetida is commonly cut with wheat flour, and a label can't be verified from here, so it is ❓ at best for a coeliac, never ✅. `# REVIEW:` against a food-allergen source.
- Any `item_tips` key in the stall files that isn't already a node (79 today, e.g. Bram's `chuck`, `tempeh`, `seitan`, `paneer`, Okafor-Sato's `yuba`, `miso`, the Spice Merchant's `garam_masala`, `furikake`) either becomes one as above, or the tip is re-keyed to an existing id (`eggs` → `egg`, `lentils` → `lentil`, `dried_chili` → `dried_red_chili`). No tip is dropped silently: the implementer lists any removals in the report.
- **A new node made from a tip carries the allergen edges its composition has, never fewer** ("can't verify" is never "safe"; a missing edge would show the item ✅): `tempeh`, `miso`, `edamame`, `yuba` and every `tofu` kind `contains: [soy]` (or `isA: [tofu]`); `seitan` `contains: [wheat]`; `paneer` and `greek_yogurt` `contains: [milk]`; `furikake` `contains: [sesame, fish]` and `labelDependent: true`; spice blends (`garam_masala`, `curry_powder`) `labelDependent: true`. Each such edge is `# REVIEW:`-flagged in `content/README.md`. A tip whose item can't be given honest edges is re-keyed or dropped, and listed.

**Seasonal table** (`data/seasonality.yaml`, Ruling 9): one region, `pnw-usa`:
- `status: draft`;
- the sources from `wen.yaml`'s header;
- `match: { countries: ["united states", "usa", "us", "united states of america"], regions: ["washington", "oregon", "pacific northwest", "pnw", "seattle", "portland"] }`;
- categories `now` "In season here, now", `stored` "Local, stored from the autumn harvest", `travelled` "Well-travelled: shipped in from far away", and `depends` "Depends: ask the farmer";
- months 11, 12, 1 and 2 only, built from Wen's existing seasonal answers.

No other region is written (Ruling 9). The `us-north` fallback line in `wen.yaml`'s header and data is removed, because `us-north` is not in the table. The header comment is rewritten to say how a region plugs in: the table entry first, with sources and a reviewer who shops there, then Wen's questions.

**Stall content changes:**
- **All four stalls:**
  - `persona:` stays in the file but is stripped from the client bundle (Step 5);
  - each stall gains `out_of_stock_none` (`ai: never`, 4 lines, vars `item`): "no swap I can check against your rules; skip it this week". It is written in each keeper's voice;
  - every FAQ entry whose `a` names an ingredient gets an `a_if_blocked` (Ruling 21).
- **Wen:**
  - `games.seasonal` text and every seasonal prompt say "Seasonal or well-travelled?" (Ruling 6);
  - option C becomes the table's `travelled` label;
  - the seasonal questions keep their ids, so the event history stays valid.
- **Bram:**
  - the `value` questions lose `$` and `¢`. Their numbers stay as they are, except that cent figures are written in the price's own unit ("≈ 26¢" → "≈ 0.26", "= 70¢" → "= 0.70"). The two that compare prices (`bram-braise-value`, `bram-pc-cheapest`) each get a `chalkboard`, and every reaction's arithmetic matches it. `bram-pc-beans-yield` keeps its example numbers in its reaction but compares yields, not prices, so it gets no chalkboard; the protein and yogurt questions have no prices at all (Ruling 5);
  - the header's USD comment becomes the example-price note;
  - the label and safety questions that teach a US label or FSIS figure get `countries: [united states]` (Ruling 8). The °C/°F temperature questions stay unscoped (physics, not law);
  - the Protein Counter's questions keep `contains: [egg]` / `[milk]`.
- **Okafor-Sato:** the name stays "Mr. Okafor-Sato" unless the founder rules otherwise (the file's own founder note, carried to the founder list). No pronouns, as now.
- **Spice Merchant:** the asafoetida question's `contains` becomes `[asafoetida]` (the node carries the wheat edge).

**New Pan triggers** (`content/dialogue/pan.yaml`; Steps 9–10 fire them by id, so all go in `REQUIRED_PAN_TRIGGERS` in Step 5). Written lines only (M5 Ruling 21):

| Trigger | ai | When | Vars |
|---|---|---|---|
| `market.no_calendar` | never | No seasonal table for the player's region (or none set): the seasonal round is left out, plainly; never "your region isn't supported". | |
| `market.stall_wait` | never | Rules can't be read yet, so the stall waits (fail closed). | |
| `market.bank_small` | never | Some questions were left out because they name something the player's rules block or that can't be checked. Never says which. | |
| `market.practice` | allowed | Opening a stall on a day with no run: practice, any day. | |
| `market.round_done` | allowed | A round ends: no score, no count; what you learned, warmly. | |
| `market.leave_round` | allowed | The player leaves mid-round: it costs nothing. | |
| `market.no_swap` | never | No stall swap passes the player's rules for an item. | `item` |
| `market.stock_swapped` | never | Read-back after taking a stall swap: labelled and re-checked. | `item`, `swap`, `dish` |
| `season.now` | never | The note beside an item in season where the player is. | `item` |
| `season.other` | never | A neutral note for the region's other categories ("stored", "well-travelled"); never a warning. | `item`, `category` |
| `market.checkoff_readback` | never | Read-back of a check-off card (Step 8). | `summary` |
| `market.checkoff_none` | never | Nothing said matched the open list; nothing ticked. | |
| `market.no_run` | never | A check-off with no open market run: points at the list chip. | |
| `errand.question` | allowed | An errand's stall question, before it; the step passes whatever is answered. | `stall`, `item` |
| `cook.drill_first` | never | Ruling 16: a recipe skill's prereqs aren't at Seen; the drill is offered, Cook stays. 4–6 lines, no ❗, no "should". | `technique`, `cook` |
| `stamp_earned.market_game` | allowed | The weekly stall stamp. Spends nothing (M5 Ruling 17). | `stall` |

Each `ai: never` trigger has 4–6 lines (M5 Ruling 21). No line uses "smuggled", "exotic", "mysterious", "authentic", "version of", a streak or count word, "only N left", a currency symbol, "buy" as an instruction from a keeper, or a joke about a sparse cupboard.

- [ ] **4.1 Write the failing tests** (`packages/core/test/market-content.test.ts`, over the real files):
```ts
test('every content/market file passes validateStallFile against data/ingredients.json', ...);
test('data/seasonality.yaml passes validateSeasonTable; wen passes seasonalAgrees; no region other than pnw-usa', ...);
test('every stall contains id resolves; tofu → soy; asafoetida → wheat (label-dependent); beef, chicken, lamb isA meat', ...);
test('a vegetarian rule makes bram protein_counter; a soy rule drops every tofu question; a coeliac rule drops asafoetida', ...);
test('no stall question text contains a currency symbol ($ £ € ¥ ₹ ₩ ₦ ₱ ¢); each chalkboard matches its reactions; the two price questions have one', ...);
test('every agency-naming question has a countries scope', ...);
test('"smuggled" appears nowhere in content/', ...);
test('validateRewards(data/rewards.yaml) passes with market_game; stamp_names has market_game', ...);
test('graph additions: no node gains an allergen edge its source field does not state (snapshot of new nodes\' edges)', ...);
test('every soy, wheat, milk, egg, sesame or fish product added from an item tip carries its edge (tempeh → soy, seitan → wheat, paneer → milk …); leek reaches fodmap_fructan; fennel_seed isA fennel', ...);
```
- [ ] **4.2 Run** `npm test -w @kitchenquest/core -- market-content` → FAIL.
- [ ] **4.3 Write the data and content.** The review flags go in the files (YAML) and in `content/README.md` (JSON). Run `grep -rn "# REVIEW:" content/ data/` and list every new flag in the report.
- [ ] **4.4 Run** `npm test -w @kitchenquest/core`, `npm test -w @kitchenquest/game` (the content build still validates the stall files with M5's schema and passes, because the new keys pass through), `npm test -w @kitchenquest/api` (the catalogue's graph and stall-id checks still pass) → PASS, except the expected `eval-gate.test.ts` failures (never skipped; report them as expected).
- [ ] **4.5 Commit** `content(market): checkable stall content — graph nodes, the Pacific Northwest table, example prices, scopes, new lines`
