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
  - `data/food-groups.json`.
- Modify:
  - `content/dialogue/pan.yaml` (new triggers below);
  - `content/bureau/forms.yaml`: `plan` (7-W) gains fields `days`, `hard_week`, `one_more`; `market_list` (12-M) gains `stall`, `for_dish`; new `margin_note` (2-M/MARGIN), `cooked_for` (5-S/SHARED TABLE), `technique_certificate` (51-T), `frame` (8-F/FRAME);
  - `content/cooks/{leela,marisol,haruka}.yaml`: one `recognize` step each, placed before the `cook` step: Leela on `heat-control`, Marisol on `tempering` (blooming chile in oil), Haruka on `grains`. In M5 its `lines` and `otherwise` are empty arrays, and the game speaks the generic Pan line `quest.recognize` when the technique is known (nothing otherwise). The cooks' own recognition lines need each cuisine's reviewer, so they wait for M10 (audit M-3);
  - `content/README.md`: sections for frames, the new quest step types (`travel`, `recognize`), the trust ladder (Ruling 1) with the founder note kept, `data/rewards.yaml`, `data/keeps.json` and the other data files (with their `# REVIEW:` flags, since JSON has no comments), and the M5 trigger table;
  - `apps/game/src/content/required.ts` (+ test): the new required triggers;
  - `apps/game/src/content/types.ts`: `FrameFile`, `TechniqueData` with `adjacent` and `prereqs`;
  - `apps/game/build/content/read.ts`: `DATA_FILES` += `rewards.yaml`, `keeps.json`, `stalls.json`, `food-groups.json`, and the `frames/` directory;
  - `apps/game/build/content/schemas.ts` and `compile.ts` (+ `compile.test.ts`): call `validateRewards`, `validateQuests`, `validateFrames`, and check that `keeps` / `stalls` / `food-groups` ids are all in the graph.
- Test: `apps/game/build/content/compile.test.ts`, `apps/game/src/content/required.test.ts`, and a new `apps/game/src/content/voice-scan.test.ts`.

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

- Seed frames: three `status: draft` files credited "Drafted by Kitchen Quest editors" and `# REVIEW:`-flagged on every food-safety line (cold rice storage, raw egg in fried rice). Their slots name only graph ids. `rescues:` maps herbs → green sauce, tomato → quick sauce and cooked rice → fried rice.
- `data/keeps.json`: only ids in the graph, with a conservative day count. The README lists every entry as `# REVIEW:` against a national food-safety source. An id with no entry means "no nudge".
- Voice checks (new `voice-scan.test.ts`, run over every compiled line, form and frame):
  - voice §7's banned words;
  - unlock, loot, collect, acquire, discover, found (about recipes);
  - streak, "missed", "x days";
  - "version of", about one cuisine and another;
  - Guild, price, upgrade, premium, subscribe;
  - "HIPAA" and "medical-grade";
  - numbers of hours or calories in nourishment or rescue lines.

  A frame or rescue line that comments on how little is in the cupboard (a list of words: "only", "just", "empty", "bare", "sad") fails, because a sparse cupboard is never a joke (audit M-4).

- [ ] **4.1 Write the failing tests:** required triggers and their `ai` values; the first line of each `ai: never` trigger; `{var}` declarations; the compile tests (a bad frame slot id, a `recognize` of the cook's own technique, `keeps` with an unknown id, rewards with non-increasing levels → the build fails naming the file); the voice scan, including a planted "you lost your streak" fixture that must fail.
- [ ] **4.2 Run** `npm test -w @kitchenquest/game -- content compile voice-scan` → FAIL.
- [ ] **4.3 Write the content and data.** Write every line to voice §0 and §3. Cooking or food-safety facts get `# REVIEW:`. No joke touches an allergen, a ❓ or a ⛔ line.
- [ ] **4.4 Run** `npm test -w @kitchenquest/game` and `npm test -w @kitchenquest/core` → PASS.
- [ ] **4.5 Commit** `content: weekly-loop lines and forms, seed frames, keeps/stall/food-group data, recognize steps`
