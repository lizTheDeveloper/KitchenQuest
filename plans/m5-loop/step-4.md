# Step 4 — Content and data: loop lines, forms, seed frames, keeps, recognize steps

The loop speaks only in written lines (spec §8, Ruling 21). This step writes them. It also adds the Bureau forms the new cards use and the curated data the core functions need:
- the three seed frames (Ruling 13);
- typical keep days for perishables;
- ingredient → stall and food-group maps;
- one `recognize` step per cook.

The build validates all of it with Steps 1–3's validators and fails, naming the file, on anything wrong.

**Files:**
- Create:
  - `content/frames/fried-rice.yaml`, `content/frames/green-sauce.yaml`, `content/frames/quick-tomato-sauce.yaml`;
  - `data/keeps.json`: `{ ingredientId: days }`, fridge or counter days for perishables in the graph only;
  - `data/stalls.json`: `{ category or ingredient id: StallId }`;
  - `data/food-groups.json`;
  - `apps/game/src/content/voice-allowlist.ts`: `VOICE_ALLOWLIST: { file: string; line: string; reason: string }[]`, the exact-line allowlist of Ruling 24 (C29), shared with Step 12's scan.
- Modify:
  - `content/dialogue/pan.yaml` (new triggers below);
  - `content/bureau/forms.yaml`: `plan` (7-W) gains fields `days`, `hard_week`, `one_more`; `market_list` (12-M) gains `stall`, `for_dish` and `general_stall` (the display name of the `general` stall); new `margin_note` (2-M/MARGIN), `cooked_for` (5-S/SHARED TABLE), `technique_certificate` (51-T), `frame` (8-F/FRAME); `stamp_names` gains `quest_done`, `certificate` and `market_run`, one name for each `StampId` (C13);
  - `data/ingredients.json` (Ruling C12): new nodes `tomato`, `herb` (a category: "fresh herbs"), `spinach`, `lime` and `cooked_rice`, each with `fdcId`/`per100g` where FDC has a record and a `source` note otherwise. They carry no `isA`, `contains` or `unsafeFor` edge beyond what that source states, so they make no allergen claim the data doesn't carry. Each is listed in `content/README.md` as `# REVIEW:` for the content reviewer;
  - `content/cooks/{leela,marisol,haruka}.yaml`: one `recognize` step each, placed before the `cook` step. Each technique is outside that cook's own recipe skills, so `validateQuests` passes (C2): Leela on `patience`, Marisol on `tempering` (blooming chile in oil), Haruka on `patience`. In M5 its `lines` and `otherwise` are empty arrays, and the game speaks the generic Pan line `quest.recognize` when the technique is known (nothing otherwise). The cooks' own recognition lines need each cuisine's reviewer, so they wait for M10 (audit M-3);
  - `content/README.md`: sections for frames, the new quest step types (`travel`, `recognize`), the trust ladder (Ruling 1) with the founder note kept, `data/rewards.yaml`, `data/keeps.json` and the other data files (with their `# REVIEW:` flags, since JSON has no comments), and the M5 trigger table;
  - `apps/game/src/content/required.ts` (+ test): the new required triggers;
  - `apps/game/src/content/types.ts` (C33, C35): `TechniqueData.techniques` becomes core's `TechniqueNode[]` (the `TechniqueData` name stays the game's file type, `{ freshness, techniques }`); `FrameFile` (= core `Frame`); `GameContent` gains `rewards: RewardsData`, `frames: Frame[]`, `keeps: KeepsMap`, `foodGroups: FoodGroups`, `stallOf: StallMap` (data/stalls.json, which `marketList` needs on the device) and `stallNames: Record<StallId, string>` (each `content/market` file's `name`, plus `general` from the 12-M form's `general_stall`). `ClientContent` stays `Omit<GameContent, 'stalls'>`, so all six new fields reach the client while the stall files stay out (C11);
  - `apps/game/build/content/read.ts`: `DATA_FILES` += `rewards.yaml`, `keeps.json`, `stalls.json`, `food-groups.json`, and the `frames/` directory;
  - `apps/game/build/content/schemas.ts` and `compile.ts` (+ `compile.test.ts`): call `validateRewards`, `validateTechniques`, `validateQuests`, `validateFrames`; check that `keeps` / `stalls` / `food-groups` ids are all in the graph, that every `stalls.json` value is a `content/market` id or `general`, and that every `StampId` has a `stamp_names` entry; build `stallNames`.
- Test: `apps/game/build/content/compile.test.ts`, `apps/game/src/content/required.test.ts`, and a new `apps/game/src/content/voice-scan.test.ts`.

**Existing lines rewritten** (C30; Rulings 3, 4 and 17), in `content/dialogue/pan.yaml`, `when` texts included:
- `stamp_earned`: drop "Spend it on a hat" (stamps are spent nowhere until M10, Ruling 17); the replacement line spends nothing.
- `introduction_received`: the `when` becomes "A cook introduces the player to a friend; the friend's pin changes to 'expecting you'." Lines drop "opening a new country" and "A new pin on the map": every launch cook is already on the map and visitable (Ruling 3).
- `skill_up`: the `when` becomes "A technique moves up a tier (Seen → Tried, Tried → Yours)." The "up a level" line is replaced; skills have no levels (Ruling 4).

**New Pan triggers** (all in `REQUIRED_PAN_TRIGGERS`; `ai: never` where marked, written lines only everywhere per Ruling 21):

| Trigger | ai | When | Vars |
|---|---|---|---|
| `plan.readback` | never | Read-back of a plan card: what goes on which day. | `summary` |
| `plan.dish_unknown` | never | A named dish isn't one the cooks teach; nothing is guessed. | `dish` |
| `plan.unverified_dish` | never | A planned dish is ❓; check the labels. | `dish` |
| `plan.fewer_than_asked` | never | "Pick N" found fewer dishes that pass the rules. | `count` |
| `plan.hard_week` | allowed | The player said it's a hard week: easy dishes, no extras. | |
| `one_more.offer` | allowed | The weekly technique slot (new). | `technique`, `known`, `dish`, `day` |
| `one_more.refresh` | allowed | The weekly slot as a refresher; an invitation, never a warning. | `technique`, `dish` |
| `one_more.declined` | allowed | "Not this week": full, warm, no cost. | |
| `one_more.accepted` | allowed | Drill day added before the cook day. | `day` |
| `market.ticked_pantry` | allowed | Ticked items went into the pantry. | `items` |
| `market.run_done` | allowed | The run is finished (once a week). | |
| `rescue.offer` | allowed | Use-It-Up, as a rescue (audit M-14). | `item`, `technique`, `dish` |
| `rescue.compost` | allowed | Compost, warmly. "Compost counts. The worms send their thanks." is one line. | `item` |
| `rescue.unverified` | never | The rescue's frame or dish is ❓ for the player. | `item` |
| `frame.offer` | allowed | A Pantry Frame from what's in the cupboard; never comments on how much is there. | `frame`, `technique` |
| `frame.slot_empty` | never | A required slot has no filler that passes the rules. | `slot` |
| `cook.who_ate` | allowed | After cook mode: "Who ate with you?" Skippable. | |
| `cooked_for.alone` | allowed | Just me: equal warmth ("Feeding yourself counts. It's the first person on the list."). | |
| `cooked_for.shared` | allowed | Fed others. | |
| `cook.changes_ask` | allowed | "Did you change anything?" Skippable. | |
| `margin.readback` | never | Read-back of a margin-note card. | `summary` |
| `margin.blocked` | never | A note's swap or addition clashes with the player's rules. | `finding` |
| `margin.needs_account` | never | Notes are account-only. | |
| `log.dish_offer` | never | The one-tap log card after cooking. | `dish` |
| `quest.recognize` | allowed | Generic recognition, until M10's cook lines; never "a version of". | `technique`, `cook` |
| `quest.travel_anyway` | allowed | An unintroduced cook, visitable anyway (Ruling 3). | `cook` |
| `certificate.technique` | allowed | "Yours": the Bureau Certificate of Technique. | `technique` |
| `book.empty` | allowed | The Recipe Book before any dish is taught. | |
| `book.exported` | never | The book file was saved; it's yours, always free. | |
| `nav.offer` | never | The line beside a navigation chip. | `place` |

- Seed frames: three `status: draft` files credited "Drafted by Kitchen Quest editors" and `# REVIEW:`-flagged on every food-safety line (cold rice storage, raw egg in fried rice). Their slots name only graph ids, including the nodes added above. `rescues:` maps `herb` → green sauce, `tomato` → quick sauce and `cooked_rice` → fried rice. Techniques: fried rice `stir-fry`, green sauce `emulsion`, quick tomato sauce `quick-sauce`.
- `data/keeps.json`: only ids in the graph, with a conservative day count, including `herb`, `tomato`, `spinach` and `cooked_rice`. The README lists every entry as `# REVIEW:` against a national food-safety source. An id with no entry means "no nudge".
- Voice checks (new `voice-scan.test.ts`, run over every line, form and frame the client bundle carries, i.e. `ClientContent`; the market stall files, which no M5 screen shows, are scanned when M6 gives them a screen):
  - voice §7's banned words;
  - unlock, loot, collect, acquire, discover, found (about recipes);
  - streak, "missed", "x days";
  - "version of", about one cuisine and another;
  - Guild, price, upgrade, premium, subscribe;
  - "HIPAA" and "medical-grade";
  - numbers of hours or calories in nourishment or rescue lines.

  A frame or rescue line that comments on how little is in the cupboard (a list of words: "only", "just", "empty", "bare", "sad") fails, because a sparse cupboard is never a joke (audit M-4).

  No pattern is weakened (Ruling 24, C29). The legitimate teaching lines the patterns catch are matched as exact lines in `VOICE_ALLOWLIST`, each with its reason: forms.yaml's "*About ½ lb (225 g) of boneless raw meat per person. Example prices." footnote; `stamp_names.cost_per_serving` "Price per Serving (Butcher)" (§3.5 teaches cost per serving); the `map` footnote "…never found, looted or discovered…" and the permit footnote about claiming to have "discovered" a dish (both anti-loot); the M3 `ledger` footnote "*Missed days are not recorded as missed…"; and the two pan.yaml lines "I may have missed one of the ingredients you named…" and "I may have missed {term}…". An allowlisted line that changes stops matching and fails again.

- [ ] **4.1 Write the failing tests:** required triggers and their `ai` values; the first line of each `ai: never` trigger; `{var}` declarations; the compile tests (a bad frame slot id, a `recognize` of the cook's own technique, `keeps` with an unknown id, a `stalls.json` value `dairy`, a `StampId` with no `stamp_names` entry, an unknown id in a technique's `adjacent`, rewards with non-increasing levels → the build fails naming the file; the compiled client content has `stallNames` with a name for every `StallId`); the voice scan, including a planted "you lost your streak" fixture that must fail, a planted "Spend it on a hat" that must fail, and an allowlisted line edited by one word that must fail.
- [ ] **4.2 Run** `npm test -w @kitchenquest/game -- content compile voice-scan` → FAIL.
- [ ] **4.3 Write the content and data.** Write every line to voice §0 and §3. Cooking or food-safety facts get `# REVIEW:`. No joke touches an allergen, a ❓ or a ⛔ line.
- [ ] **4.4 Run** `npm test -w @kitchenquest/game` and `npm test -w @kitchenquest/core` → PASS. Check the first-paint budget (M4 carry: ~290 KB) with the new `ClientContent` fields (C35).
- [ ] **4.5 Commit** `content: weekly-loop lines and forms, seed frames, keeps/stall/food-group data, recognize steps`
