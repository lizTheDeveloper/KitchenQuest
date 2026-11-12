# Kitchen Quest content

This folder holds the game's written words: dialogue, quests, cook stories, market minigame questions, FAQ answers, and the Pantry Bureau's forms. It is data, not code. Writers and contributors edit these files; the game reads them.

Read the voice guide first: [`docs/style/voice.md`](../docs/style/voice.md). Its hard rules (§0) apply to every line here.

## Layout

```
content/
  README.md              # this file: schema + how the game uses it
  dialogue/
    pan.yaml             # the Pan's line bank, keyed by trigger
  cooks/
    leela.yaml           # Ammachi Leela, Kochi, Kerala, India: parippu
    marisol.yaml         # Doña Marisol, Oaxaca, Mexico: frijoles de olla
    haruka.yaml          # Haruka, Osaka, Japan: onigiri
  market/
    wen.yaml             # Old Wen: produce (seasonality is region + month)
    bram.yaml            # Big Bram: butcher, with the vegetarian Protein Counter variant
    okafor-sato.yaml     # Mr. Okafor-Sato: tofu & legumes
    spice.yaml           # the Spice Merchant
  bureau/
    forms.yaml           # form numbers, titles, field labels, stamps, footnotes
  frames/
    fried-rice.yaml      # Pantry Frames (M5): a technique with slots, filled from the cupboard
    green-sauce.yaml
    quick-tomato-sauce.yaml
```

Beside this folder, `data/techniques.yaml` holds the Technique Toolkit: the technique ids and display names (`id`, `name`) that recipe `skills:` and quest `drill` steps refer to, and the freshness thresholds (`warm_after_days: 42`, `rusty_after_days: 120`, spec §17), which are tunable data, not code. The Pan has two lines for the toolkit and voice: `toolkit.rusty_invite` (an invitation beside a Rusty technique, never a warning; variable `{technique}`) and `voice.not_yet` (hold-to-talk before live voice exists; removed when voice ships). The game build compiles all of this folder, `recipes/` and `data/` and fails, naming the file, if any of it is invalid: a missing required Pan trigger, a cook or recipe that points at something that doesn't exist, a riddle without exactly one correct option, and so on.

All files are YAML, 2-space indent, UTF-8. Strings are double-quoted. Variables are `{curly}`.

## How the game uses this content: scripted first

1. **A written line is always the first choice.** When the game fires a trigger (the player opens the app in the morning, a timer finishes, a riddle is answered), it picks one of that trigger's written `lines`.
2. **No repeats in a row.** The game keeps a short per-trigger history (the last `min(3, n-1)` lines used) and picks randomly among the rest, so a trigger with 6 lines never shows the same line twice in a row and rarely within three firings.
3. **Variables** are filled from game state. A line whose variable is missing is skipped. If every line would be skipped, the game uses the first line with the variable replaced by a safe default (documented under that trigger's `vars`).
4. **`ai: allowed`** means the game *may* ask the model for a fresh variant in the character's voice instead (for example, every fourth firing, or when the player has seen all the written lines this week). The prompt includes the voice guide's hard rules, the persona card, a few of the written lines as examples, and the variable values. The output is checked (length, banned words, no numbers where numbers are banned) and replaced by a written line if it fails or if the AI is unavailable.
5. **`ai: never`** means the written lines are used exactly, always. This is required for anything safety-relevant: allergy and diet read-backs, label reminders, low-intake check-ins, medical deflections, and emergency lines.
6. **The AI is only for things writing can't reach:** free-form questions that no FAQ entry matches, photo reactions (the written `reactions` are the fallback), and turning what the player says into data (meal logs, pantry items, rule proposals). Even then, the Pan confirms with a written read-back.
7. **If the AI is down,** everything except free-form answers still works from these files, and the Pan says so in character (`ai_unavailable` in `pan.yaml`; the mentor conversation uses `mentor.ai_unavailable`, which never claims anything was kept or saved).

## Schema

### Line bank (`dialogue/*.yaml`, and the line sections of cook and stall files)

```yaml
# line bank
triggers:
  <trigger.id>:
    ai: never | allowed
    when: <one sentence on when the game fires it>
    lines:
      - "text with {vars}"
```

Optional keys on a trigger:

- `vars:` a map of variable name → what it holds and a safe default, e.g. `hours: "whole hours since last logged meal (default: several)"`. Every `{var}` a line uses must be declared here (`name` too), and an `ai: never` trigger may not declare a variable none of its lines use. The build fails otherwise, naming the trigger and the line.
- `notes:` writer's notes for the engine or for reviewers.

**Variant counts.** Most triggers have 4–10 lines so they don't repeat. `cook.step_quip` has more (it fires often). A few safety triggers (`rule.emergency`, each stall's `medical`, Bram's `religious_rules`, the Spice Merchant's `allergen_note`) have exactly one fixed line on purpose: safety text should read the same every time.

**Trigger ids** are dotted, lowercase. A dotted suffix narrows a trigger: `reminder.hours_since_meal.h6` is the six-hour tier of `reminder.hours_since_meal`. The engine uses the most specific trigger that exists and falls back to the parent.

### Quest (`cooks/*.yaml` → `quest:`)

```yaml
# quest
quest:
  id: leela-tempering
  cook: leela
  title: "..."
  unlock: { requires: [], trust: 0 }
  steps:
    - { type: talk, lines: ["..."] }
    - { type: riddle, prompt: "...", options: [{ text: "...", correct: false, reaction: "..." }], explain: "..." }
    - { type: drill, skill: knife, prompt: "...", lines: ["..."] }
    - { type: errand, stall: wen, item: onion, lines: ["..."], adapted: ["..."] }
    - { type: travel, place: marisol, lines: ["..."] }
    - { type: recognize, technique: patience, lines: [], otherwise: [] }
    - { type: cook, recipe: india/kerala/parippu, technique: tempering }
  rewards: { xp: 40, trust: 1, skills: { knife: 10 } }
```

- Steps run in order. The files write steps in block style; it's the same YAML.
- `unlock.requires` lists quest ids that must be complete. `unlock.trust` is the minimum trust with this cook.
- **riddle:** exactly one option has `correct: true`. Wrong options keep the player on the step ("try again"); every option has a `reaction`. `explain` is shown after the correct answer, as the plain-language reason.
- **drill:** a short technique lesson. `skill` is a skill id (`knife`, `heat-control`, `tempering`, `legumes`, `patience`, `grains`, `shaping`, …). `prompt` is the instruction; `lines` are the cook's coaching.
- **errand:** sends the player to a market stall (`wen`, `bram`, `okafor-sato`, `spice`) for `item` (an ingredient id). The stall's own choosing minigame for that item runs if one exists. `lines` are what the cook says when sending and on return (the last line is the return line). If the rules engine blocks the item, the stall offers the cook's adapted version instead; the cook's `faq` covers the substitute.
- **errand `adapted`** (optional, M5): what the cook says instead when the player's rules block the item (⛔, swap-only or ❓). The step still passes with the same rewards; a player's rules never lock them out of progress. Without it the Pan says `quest.errand_adapted`.
- **travel** (M5): passed by arriving at `place`, a cook id (`#/visit`). `lines` are said on arrival.
- **recognize** (M5, audit M-3): `technique` must be one learned elsewhere, never a skill of this cook's own recipes (the build checks it). `lines` are said when the player has it at Tried from another cook's dish, else `otherwise`. In M5 both are empty in every cook file: the game speaks the Pan's generic `quest.recognize` when the technique is known, and nothing otherwise. Each cook's own recognition lines need that cuisine's reviewer, so they wait for M10. Shipped: Leela on `patience`, Marisol on `tempering` (blooming chile in oil), Haruka on `patience`, each just before the `cook` step.
- **cook:** opens cook mode for `recipe`, a path under `recipes/` without the `.cook` extension (`india/kerala/parippu`). Optional `technique` (M5) must be one of that recipe's `skills`: when the player's rules block the dish, only stand-in dishes and frames that practise that technique count (core `alternativesFor`). Without it, any of the recipe's skills does. If none passes the rules, the step completes as an adapted lesson (`quest.cook_adapted`).
- The build runs core `validateQuests` over every quest (the API catalogue runs the same check), and fails, naming the cook file, on a bad reference, a riddle without exactly one correct option, an `unlock.requires` cycle, or a recognize step of the cook's own technique.

### FAQ (cooks and stalls → `faq:`)

```yaml
# faq
faq:
  - q: ["can i use canned beans", "canned beans ok?"]   # match phrases
    a: "..."
```

- `q` holds lowercase match phrases. The game normalises the player's question (lowercase, strip punctuation) and matches by phrase containment or a simple token-overlap score. A match above threshold uses the written `a`; otherwise the question goes to the AI (if available), grounded in the recipe and the player's rules.
- An answer that mentions an ingredient is still run through the rules engine before display. If it would suggest something the player can't have, the game shows the entry's `a_if_blocked` (when present) or a generic "that one isn't for you; ask me for a swap" line.
- Optional `tags:` for routing (`storage`, `substitution`, `safety`).

### Cook file (`cooks/*.yaml`)

```yaml
id: leela
name: "Ammachi Leela"
place: "Kochi, Kerala, India"
dish: "Parippu"
recipe: india/kerala/parippu
persona: ["5 bullets: the AI's voice card"]
intro: ["first meeting, 3-5 lines"]
story: ["the dish's story and origin, 4-6 lines; # REVIEW: comments on uncertain claims"]
quest: { ... }            # see Quest
gift: ["the teaching moment: the cook passes the recipe on"]
trust_lines:              # said on return visits at each trust level
  1: ["..."]
  ...
  5: ["..."]
reactions:
  photo: ["6+ scripted photo reactions; each names something plausible and gives one tip"]
  skip_photo: ["3 lines for when the player skips the photo"]
introduction: ["the letter/introduction to the next cook"]
faq: [ ... ]              # see FAQ
```

**Trust levels** are 1–5: 1 Guest, 2 Acquainted, 3 Trusted apprentice, 4 Family friend, 5 Keeper of the dish (the cook trusts you to teach it to someone else). Level 0, Stranger, is before the first visit and has no return lines. *(The prototype used 0–4 with the same names minus "Keeper"; the founder should confirm the fifth level.)*

**The trust ladder (M5, Ruling 1).** Six states: 0 Stranger plus the five levels above. The names live in `data/rewards.yaml` (`trust.names`). Guest comes when the cook's quest is done; each later level comes from distinct ISO weeks in which the player cooked that cook's dish (`trust.weeks_for_level`: 2, 4, 7 and 10 cook-weeks for levels 2–5), at most one level a week (Ruling 2). The weeks need not be consecutive, so it is no streak, and trust never decays. Trust gates are advisory: every launch cook stays visitable, and an introduction letter (at trust 3) changes the friend's pin to "expecting you" (Ruling 3). `unlock.trust` gates nothing. *(Founder to confirm the fifth level and the pace, as above.)*

**Photo reactions** in `reactions.photo` are written so they make sense without seeing the photo. They're the fallback when the AI is down or the image can't be read. The AI's own reaction follows the same rules (voice guide §0.12): name something visible, give one tip, never body comments or "that's wrong".

### Market stall (`market/*.yaml`)

```yaml
id: wen
name: "Old Wen"
stall: produce
art: grocer                # the keeper's sprite key, or null when never seen
persona: ["..."]           # writers' card; stripped from the client bundle (M6 Step 5)
triggers:                  # line bank: greet, correct, wrong, idle, out_of_stock, out_of_stock_none, medical, ...
  idle:
    contains: { "1": [chuck] }   # per line, by index: the graph foods that line names (the build fails a missing one)
    ai: allowed
    when: "..."
    lines: ["Take your time.", "The chuck isn't going anywhere."]
games:                     # this stall's minigames: key → one-line description
  ripeness: "..."
questions:                 # the minigame bank
  - id: wen-avocado-ripe
    game: ripeness         # one of this file's `games:` keys
    prompt: "..."
    options:
      - { text: "...", correct: true, reaction: "..." }
      - { text: "...", correct: false, reaction: "..." }
    explain: "one plain sentence, true on its own"
    contains: [avocado]    # ingredient ids involved; each must be a graph node
    countries: ["United States"]   # optional (Ruling 8): one country's label or agency figure
    chalkboard:            # value questions that compare prices only (Ruling 5): one entry per option
      - { price: 22.50, servings: 6 }
item_tips:
  avocado: { pick: "...", store: "..." }   # keys are graph ids
faq:
  - q: ["chip text", "other phrasings"]
    a: "the answer"
    a_if_blocked: "shown instead when `a` names something the player's rules block or can't verify"
```

- Each question has 3–4 options, exactly one `correct: true`. The correct option's `reaction` is the "right!" line; each wrong option's `reaction` is its funny, true explanation. `explain` is shown after any answer. A shipped question keeps its id and its option order (Ruling 2): a reworded option keeps its place; a reordered one needs a new id.
- **Rules filtering (M6 Ruling 2.2).** Before a question is shown, the rules engine checks everything it names, with no substitutions: its `contains`, each option's `contains`, and every graph ingredient its prompt, options, reactions and explanation name. Only ✅ is shown; ⛔ and ❓ questions are dropped and counted, never named (`market.bank_small`). An unknown `contains` id fails the build. Tips and FAQ answers are checked the same way: a tip naming anything ⛔ or ❓ is not shown, and an FAQ answer that does shows its `a_if_blocked` (itself checked), else the stall's generic safety line. **Every FAQ answer that names an ingredient has an `a_if_blocked` that names none** (M6 Step 4, `packages/core/test/market-content.test.ts`).
- **Keeper lines (M6 Step 5 fix round 1).** A keeper line is shown only when everything it names is ✅ (core `keeperLines`): its trigger's `contains` for that line, and every graph food its words name. The build fails a line whose words name a graph food its `contains` doesn't list, so a writer declares each one. A `{var}` names nothing; code checks what it fills in.
- **Chalkboard arithmetic (Ruling 5, fix round 1).** Each entry divides exactly to the cent; every "A ÷ B = C" in the question is true and A ÷ B is a board entry (in an option's reaction, that option's own); there is no "≈"; every other figure in a reaction or the explanation is some option's price per serving; and the prompt lists each entry, price then servings, in board order. A currency symbol anywhere in a stall file fails the build.
- **Bram's Protein Counter.** `bram.yaml` has a `variants.protein_counter` block with its own triggers, questions, tips and FAQ. The game uses it when the player's rules block `meat` itself (vegetarian, vegan, or a custom rule covering all meat); a partial rule ("no pork") keeps Big Bram with the pork questions dropped. Questions naming egg or milk are dropped for players who exclude those.
- **Chalkboard prices (Ruling 5)** are example numbers in no particular currency: no currency symbol anywhere in a question, never real, never regional. The two price questions (`bram-value-braise`, `bram-pc-cheapest`) carry a `chalkboard:`; the build checks that the correct option is the cheapest per serving and that every "= N" in a reaction is that option's own per-serving figure. The numbers divide exactly, so no reaction needs "≈". Form 14-S carries the footnote "*Example prices in no particular currency. Your shop will differ."
- **Country scopes (Ruling 8).** A question that teaches one country's label or agency figure lists the countries it is true for in `countries:` (names as in core `market/country.ts`, checked against ISO 3166-1). It shows only to a player whose profile country is in the scope; with no country set, only unscoped questions show. Bram's four US label questions (`bram-air-chilled`, `bram-grass-finished`, `bram-use-by`, `bram-no-hormones`) are scoped to the United States; the °C/°F temperature questions are physics, not law, and stay unscoped.
- **Stall swaps (Ruling 11).** `out_of_stock` (with `{item}` and `{swap}`) is the line for a rules-checked swap from `data/substitutions.json`; `out_of_stock_none` (`ai: never`, four lines, `{item}`) is the line when no swap passes the player's rules: skip it this week.
- **Wen's seasonality** lives in `seasonal.<region>.<month>` (month is 1–12), for regions in `data/seasonality.yaml` only. Each option is one of that region's category labels, word for word, and the correct one is the category the table gives the question's own `contains[0]` that month (core `seasonalAgrees`). A region with no table entry gets no "Seasonal or well-travelled?" round and no calendar note (`market.no_calendar`); the general ripeness and storage questions still run. There is no fallback to another region or country. See the comment at the top of `wen.yaml`.

### Bureau (`bureau/forms.yaml`)

Forms (number, title, purpose, field labels, button labels, footnotes), stamp texts, and a pool of general footnotes for UI copy. Safety fields on forms are plain; footnotes carry the jokes.

The mentor's cards (Milestone 4) use these forms:

- `consent_health` (3-C/HEALTH) and `consent_ai` (3-C/AI): two separate tap cards, one per consent. Their one field, `notice`, holds the API's notice text for that purpose, shown verbatim; the Bureau file never rewrites it. That notice text is a draft pending lawyer review (C-30). Saying no costs nothing, and the footnote says so.
- `profile` (1-A/AMEND): a proposed change to market days, meals per week, region or meal times. A card shows only the fields its patch sets.
- `rule_allergen`, `rule_intolerance`, `rule_diet`, `meal_log`, `pantry` and `schedule`, as before.

`disclaimers` are plain, required text. The build fails without `cross_contact`, `unverified` and `ai_characters` (`apps/game/src/content/required.ts`). `ai_characters` is the C-16 disclosure, verbatim: "The Pan and the cooks are AI characters. Don't rely on them for medical advice." Never edit its wording here alone.

### The mentor's Pan triggers (Milestone 4)

The server agent and the client's scripted engine emit these by id, so they are all in `REQUIRED_PAN_TRIGGERS` and all `ai: never` (`apps/game/src/content/required.test.ts` checks both, plus the first line of each). The model is never asked to write one.

| Trigger | When | Vars |
|---|---|---|
| `rule.unknown_term` | The term isn't in the ingredient graph or the rule terms. Nothing is saved; the player is told to check recipes and labels themselves. | `term` |
| `rule.which_one` | Several ingredients match; the player taps one. Nothing is picked for them. | `term` |
| `rule.tap_needed` | A typed "yes" for a severe card. Severe cards need a tap. | `ingredient` |
| `rule.ask_what_else` | A severe statement named an ingredient no card was made for; asks for it plainly so it is never silently lost (Step 7). | `term` (optional) |
| `rule.ask_keep_off` | A health turn ended with no card and no rule outcome (or the model's rule was dropped); asks plainly what to avoid and how badly (Step 7). | |
| `mentor.check_card` | A mentor turn with no card while a dish is on screen or named; points at the card and the label (Step 7, R9: model text is never shown). | |
| `confirm.tap_card` | A typed "yes" or "no" with more than one card open. | |
| `write.not_done` | The player asked for a record to change and no card came out (Step 7, R9: model text is never shown). | |
| `rule.already_saved` | A rule card would read back a milder level than the saved rule for that ingredient; no card is offered, nothing written (M4 Step 12). | `ingredient`, `rule`, `severity` |
| `write.daily_limit` | A typed yes hit the daily write limit on meal logs or loosening rule edits; nothing was written (M4 Step 12). | |
| `consent.health_first` | A rule or meal card for a player without `health_data` consent; the 3-C/HEALTH card follows. | |
| `child.grownup` | A child is talking. Exactly one fixed line, no joke. | |
| `allowance.explain` | Any question about plans, prices or the chat allowance. Never names the Guild, a price, a plan or a tier (never rule 7). | |
| `log.needs_account` | A meal log for a signed-out player. | |
| `profile.readback`, `pantry.readback` | Read-back of a profile/schedule or pantry card, like `log.confirm_readback`. | `summary` |
| `ai.try_again` | The AI failed; the player's message is held for "Try again". | |
| `mentor.ai_unavailable` | The mentor's AI failed or is off; the script answers. Never says "saved", "kept", "logged", "stored" or "photo". | |
| `forget.done` | The player cleared their conversations. | |

The engine also emits the existing `rule.*` read-back, stamp, void, emergency and medical lines, `log.confirm_readback`, `log.logged`, `pantry.added`/`removed`, `schedule.set`/`bad_time`, `undo`, `undo.nothing`, `didnt_understand`, `rate_limited`, and every Form 1-A intake trigger (`intake.open` to `intake.complete`, listed one by one).

### Pantry Frames (`frames/*.yaml`, Milestone 5)

A frame is a technique with slots, filled from the player's pantry by core `fillFrame` (spec §17, Ruling 13). One file per frame; the file name is its `id`.

```yaml
id: green-sauce                 # kebab-case, equal to the file name
title: "Green sauce"
technique: emulsion             # a data/techniques.yaml id
status: draft                   # draft | reviewed
credit: "Drafted by Kitchen Quest editors"
slots:
  - { key: herb, accepts: [herb], optional: false }   # accepts: ingredient ids from data/ingredients.json only
  - { key: nut, accepts: [nut], optional: true }      # a category id accepts any kind of it (isA)
steps:
  - "Wash {herb}, shake it dry and chop it fine."     # {slot} placeholders; a step naming an unfilled slot is left out
rescues: [herb]                 # ingredient ids Use-It-Up may rescue with this frame; each must fit some slot
```

- Every filler is checked by the rules engine on its own and the filled dish as a whole. ⛔ fillers are never chosen; ❓ ones (label-dependent, unresolved) are never chosen for the player. A required slot nothing passes stays unfilled and the dish shows ❓ (`frame.slot_empty`), never a guess.
- Steps name only what a slot holds. An ingredient written into a step but not in a slot is never checked against the player's rules, so don't.
- The build runs core `validateFrames` on each file and fails, naming it, on a slot id missing from the graph, an unknown technique, a step using an unknown slot, a required slot no step uses, or a rescue no slot accepts.
- **The three seed frames** (fried rice `stir-fry`, green sauce `emulsion`, quick tomato sauce `quick-sauce`) are `status: draft`, credited to the Bureau's editors, not a community. M10's writers may reword them. Rescues: `herb` → green sauce, `tomato` → quick tomato sauce, `cooked_rice` (and `spinach`) → fried rice. Every food-safety line is `# REVIEW:`-flagged in the file (cold rice storage and reheating, raw egg, washing herbs, soft tomatoes). Because `herb` is label-dependent, a pantry that says only "herbs" fills the green sauce for a player with no restricting rules; with any rule, the herb slot waits for a herb the player names or picks (and then the sauce shows ❓). The graph's herbs (curry leaf, epazote) fit the herb slots too: a reviewer may want to narrow the green sauce's `accepts`.
- No frame or rescue line comments on how much is in the cupboard ("only", "just", "empty", "bare", "sad"): a sparse cupboard is never a joke (audit M-4). The voice scan fails on it.

### Data files (`data/`)

Beside this folder, the game build reads these files and fails, naming the file, on anything invalid. The API catalogue (M5 Step 5) runs the same core checks. JSON has no comments, so the review flags for the JSON files live here.

- **`data/rewards.yaml`** (M5, Ruling 7): XP amounts (`lesson`, `drill`, `cook`, `frame`, `market_run`, `refresh`), the flat, capped daily nourishment XP (Ruling 5: per qualifying log, blind to what or how much was eaten), the cumulative level curve (strictly increasing), stamps per occasion (`quest_done`, `certificate`, `market_run`, the `StampId`s; each needs a `stamp_names` entry in `bureau/forms.yaml`), and the trust ladder. Tunable here, never in code; a retune never lowers anything already granted. Checked by core `validateRewards`.
- **`data/techniques.yaml`**: the Technique Toolkit, with `adjacent` (what to suggest after a technique, for the weekly One More Technique slot) and `prereqs` (best tried first; advisory, never a lock). Checked by core `validateTechniques` (unknown ids, self references, a prereqs cycle).
- **`data/keeps.json`** (M5, Ruling 12): `{ ingredientId: days }`, how long a perishable keeps once bought, for Use-It-Up Rescue and frame filling. Conservative day counts. The lookup is by the bought item's own id, with no isA ancestry, so keys are concrete ingredients (`herb` is listed because it is the id a told or bought "herbs" resolves to). An id with no entry means no nudge: a spoil date is never guessed. Whole days, 1 to 365, ids in the graph only (core `validateKeeps`).
- **`data/stalls.json`** (M5, C11): `{ ingredient or category id: stall }`, which market stall sells it, for Form 12-M. A category entry covers its kinds through isA (`allium` sends onions, shallots and garlic to Old Wen); an ingredient's own entry wins (`celery_seed` goes to the Spice Merchant, not Wen). Anything unlisted goes to `general` (the General Counter, named by Form 12-M's `general_stall` field). Values are `content/market` ids or `general`; there is no dairy stall (core `validateStallMap`).
- **`data/food-groups.json`** (M5): `{ ingredient or category id: veg_fruit | protein | grain }`, for the plan's balance line (`plan.gap_green`, `plan.gap_protein`, `plan.balanced`). It never scores anything; garnishes (herbs, curry leaves) are left out so a sprinkle doesn't count as "something green" (core `validateFoodGroups`).
- **`data/seasonality.yaml`** (M6, Ruling 9): The Season's Table. One entry per region, each with a display name, `status: draft | reviewed`, cited sources, match phrases for the profile's country and region, its own 2–5 categories (the first is "in season now"), and per month the ingredient ids in each category. A month left out means no note. M6 ships only `pnw-usa` (November–February, built from Wen's own seasonal answers, each question's own id). Region phrases are written so they don't catch the wrong place ("washington state", "portland oregon"; a bare "Washington" or "Portland" matches nothing). Checked by core `validateSeasonTable`; Wen must agree with it (`seasonalAgrees`). How a region plugs in is at the top of the file.
- **`data/ingredients.json`, the market nodes** (M6 Step 4): 88 nodes: the 85 the stall files name (38 of the 48 `contains` ids and 78 item-tip keys were missing), plus `butternut`, `butternut_squash` and `butternut_nut` (the butternut ruling). Meat cuts under `beef`, `chicken`, `lamb` and `pork` (so the vegetarian term covers them); `bean`, `berry` and `butternut` are broad categories (never a rule target, like `herb`), with their kinds filed under them (`butternut` over the squash and the tree nut); `tofu` and every tofu kind, `yuba`, `tempeh`, `miso` and `edamame` reach soy; `seitan` contains wheat; `paneer` and `greek_yogurt` contain milk; `furikake` contains sesame, fish, soy and wheat; `asafoetida` contains wheat; `tempeh` is `unsafeFor` wheat, gluten and barley; `butternut_nut` is a tree nut, `unsafeFor` walnut and pecan; the blends, `miso`, `canned_bean` and `furikake` are label-dependent; `leek` and `green_onion` are alliums and fructans; `fennel_seed` is filed under `fennel`, `cumin_seed` under `cumin`, `coriander_seed` and `cilantro` under `coriander`, and the chillies and `paprika` under `chili` (which also answers to "chile", "chiles" and "red chile"); `moong_dal`, `toor_dal` and `lentil` under `bean`. Nutrition values and `fdcId` come from USDA FoodData Central (SR Legacy) where one record matches the node as named; otherwise none, and `source` says why.
- **`data/substitutions.json`, stall swaps** (M6, Ruling 11): three for the launch dishes' market items (`shallot → onion`, `green_chili → dried_red_chili`, `moong_dal → red_lentil`), each with a "Stall swap:" note and `unsafeFor` its own `from`, so it stays a stall swap and is never the rules engine's swap for an allergy to the item (review I1). Curry leaves and epazote have no honest swap, so they have no entry and the stall says `out_of_stock_none`.

Review flags for the JSON files:

- `# REVIEW:` **every `data/keeps.json` entry**, against a national food-safety source (USDA FoodKeeper, UK FSA): `cooked_rice` 1 day (FSA/NHS: cool within about an hour, fridge, eat within 24 hours; USDA allows 3–4 days, the stricter figure is kept), `spinach` 3, `herb` 4, `epazote` 4, `tomato` 3 (ripe, at room temperature), `green_chili` 7, `lime` 14 (fridge). The Step 4 data check confirmed spinach, tomato, green chilli, lime and cooked rice against extension charts and NHS/FSA; herb and epazote have no primary source yet (conservative, still to confirm).
- `# REVIEW:` **the M5 nodes in `data/ingredients.json`** (Ruling C12): `tomato` (FDC 170457), `spinach` (FDC 168462), `lime` (FDC 168155), `cooked_rice` (FDC 168932, "Rice, white, short-grain, cooked, unenriched", which declares no fibre or sugars, so none is given; `contains: [rice]`, so a rule on rice covers leftover rice) and `herb` (a category, "fresh herbs", no FDC record, no nutrition values). FDC values were checked against the FDC portal (Step 4 data check). The produce nodes carry no `isA`, `contains` or `unsafeFor` edge beyond what their sources state.
- `# REVIEW:` **`herb` is label-dependent and broad** (Step 4 fix round 1, C1). A line or pantry item that says only "herbs" could be any herb (celery leaf, chives, lovage), so it is ❓ under any restricting rule, never ✅, and a Pantry Frame never fills a slot with it for the player. `broad: true` means it is never a rule target: "allergic to herbs" gets `rule.which_kind` ("which one?") with the herbs the graph knows as buttons, never a card on the category. The graph's own herbs, `curry_leaf` (and `curry_leaf_sprig`) and `epazote`, are filed under it with `isA: [herb]`. Filing more herbs (coriander, parsley, mint) under it needs the same review.
- `# REVIEW:` **`peanut_oil`** (FDC 171410, "Oil, peanut, salad or cooking"; M5 Step 4, Step 3 N1), aliases "groundnut oil", "arachis oil", "refined peanut oil", "roasted peanut oil" and "cold-pressed peanut oil", `contains: [peanut]`, and the alias "arachis" on `peanut`, so a margin note or a rule naming them is checked as peanut: ⛔ under a peanut rule, never ✅. Refined peanut oil is treated as containing peanut on purpose: a label can't be verified from here. "PB" is deliberately not an alias (too ambiguous).
- `# REVIEW:` **`cooked_rice`'s aliases** "leftover rice", "cold rice" and "day-old rice" read any leftover as plain cooked rice (`contains: [rice]` only). Takeaway egg-fried rice told as "leftover rice" would fill the fried-rice frame ✅ under an egg rule. The content reviewer decides whether these aliases stay, or whether leftovers need their own ❓ node.
- `# REVIEW:` `data/stalls.json` and `data/food-groups.json` placements (fish and dairy at the General Counter; eggs at Big Bram's Protein Counter; tortillas at Okafor-Sato's, because Doña Marisol asked nicely).
- `# REVIEW:` **the M6 market nodes' allergen edges** (Step 4, C16–C17), against a food-allergen source: `tofu` (and `silken_tofu`, `soft_tofu`, `firm_tofu`, `extra_firm_tofu`, `tofu_puffs` through it), `yuba`, `tempeh`, `miso`, `edamame` → soy; `seitan` → wheat, and `unsafeFor: [soy]` (shop seitan is often simmered in soy sauce); `asafoetida` → wheat, label-dependent (compounded hing is commonly cut with wheat flour; a gluten-free one can't be verified from here); `paneer`, `greek_yogurt` → milk; `furikake` → sesame, fish, soy and wheat, label-dependent (many add milk or egg); `butternut_nut` → tree nut, `unsafeFor: [walnut, pecan]` (the walnut genus, Juglans; walnut–pecan cross-reactivity, conservative); `garam_masala`, `curry_powder`, `miso`, `canned_bean` label-dependent; `mexican_oregano` `unsafeFor: [oregano]` (a different plant, Lippia, sold as oregano). Tempeh is `unsafeFor` wheat, gluten and barley (grain tempeh declares them; data check), not label-dependent, so its questions still reach vegetarians; furikake contains sesame, fish, soy and wheat, and stays label-dependent for milk and egg (data check). `moong_dal`, `toor_dal` and `lentil` are filed under `bean` with the other pulses (review C2), so a "beans" line is never ✅ under a rule on one of them.
- `# REVIEW:` **FODMAP and cross-reactivity are clinical questions, not graph edges.** `leek` and `green_onion` are filed under `fodmap_fructan`, as onion, shallot and garlic are (the green tops are lower in fructans, but a line names the whole vegetable). No other new node carries a FODMAP edge (asparagus, chickpeas and kidney beans are FODMAP-relevant too: the graph's low-FODMAP coverage is the alliums only). `pea` carries no lupin edge. `lupin_bean` is now also filed under `bean`, so a "beans" line is never ✅ under a lupin rule; `edamame` is filed under `bean` so it isn't under a soy rule either. Nutmeg is a seed, with no tree-nut edge.
- `# REVIEW:` **the market names and the Pan's health gate** (M6 Step 4 fix round 1, ruling C1). Every market node answers to its bare name again (`paneer`, `oregano`, `clove`/`cloves`, `carrot`/`carrots`, `ginger`, `nettle`, `lentil`/`lentils`, `berries`, `butternut`), so a stall text or margin note naming one is checked against a rule on it. M4's slip matching (one or two edits from a one-word name of 5+ letters) skips a closed list of everyday words in `packages/core/src/mentor/route.ts` (`EVERYDAY_WORDS`: "dinner", "love", "until", "paper", "Oregon", "checked", "feel", "child", "chilled", "apply", "temp", "carries", "little", "worries", "Seattle" and the like), each checked not to be a graph name or a food word (re-review N1, N4: "chile" and "marrow" came off it; "chile" is now an alias of `chili`, so "I live in Chile" reads as health, the safe side, and Wen's pear and blueberry questions, which name Chile the country, are left out under a chilli rule). An exact name or alias always counts as health, and so does a compound ("chilling" holds "chilli"). A bare "butternut" is ambiguous (binding ruling): the `butternut` node is a broad category over `butternut_squash` (under winter squash) and `butternut_nut` (under tree nut), so "allergic to butternuts" gets the which-kind choice and never a squash-only card, and a line or stall text naming a bare butternut reads as both (⛔ or ❓ under a tree-nut rule). "butternut squash" names only the squash. Wen's two butternut-squash questions are left out for a tree-nut rule too, because the text scan also sees the word "butternut" in them: the safe side. "hing" stays unknown (❓): as a compound it would read "something" and "anything" as asafoetida.
- `# REVIEW:` **the bare stall words** (M6 Step 5 fix round 1, Task 5 ruling 1). Keeper lines and stall texts said "chuck", "squash", "rice", "tortillas", "legumes" and "plums", which the graph couldn't read, so a rules check passed them. Now: `chuck` answers to "chuck"; `bean` to "legume"; three new categories, each never one kind: `squash` (over `winter_squash`, so `butternut_squash`, and over `zucchini`), `rice_grain`, named "rice" (over `rice`, the short-grain white rice; a "rice" line is ❓ under a rule on one kind, ⛔ under a rice rule), and `tortilla` (over `corn_tortilla`, label-dependent: flour tortillas hold wheat, some lard); and `plum` (no FDC values recorded yet). In the Pan's health gate these six are **exact-only** (`EXACT_ONLY` in `packages/core/src/mentor/route.ts`): an exact "rice" or "chuck" is health, the safe side, but "check", "square", "plumber", "price", "chuckle" or "league" is never a slip or a compound of one. "ran out of rice" is now a health turn, like "finished the milk". Every keeper line that names a graph food declares it in its trigger's `contains` (line index → ids), and the build fails a line that names one it doesn't declare; core `keeperLines` checks the declared ids and the words.
- `# REVIEW:` **stored "no cumin" rules** (review M1): before M6 the bare "cumin" and "jeera" named `cumin_seed`; now they name the `cumin` category, which `cumin_seed` is filed under. A rule saved before M6 from "no cumin" targets `cumin_seed`, so a line that says only "cumin" is ❓ under it (never ✅), where it used to be ⛔. A rules migration (`cumin_seed` → `cumin` for rules filed from the bare word) is carried to Steps 6–7.
- `# REVIEW:` **every M6 node's FDC record** (SR Legacy, checked in M6 Step 4 against the FoodData Central SR Legacy CSV release 2018-04): the ids are in each node's `fdcId` and `source`. Spices with only a ground record (`cinnamon`, `clove`, `nutmeg`) carry the ground values; `mushroom`, the meat cuts, `silken_tofu`, `greek_yogurt`, `paneer`, `seitan`, `yuba`, `nettle` (FDC has only a blanched record), `star_anise`, the categories and the blends other than curry powder carry none.
- `# REVIEW:` **the three stall swaps' notes** (`data/substitutions.json`): half a small onion for three small shallots; one dried red chilli for each green chilli; the same amount of split red lentils for moong dal. Kitchen judgement, no primary source; a cook from the tradition should confirm them for parippu.
- `# REVIEW:` `data/stalls.json` gains `cumin: spice` (the bare "cumin" now names the `cumin` node, not `cumin_seed`).

### Rule terms (`data/rule-terms.json`)

Words that name a rule rather than one ingredient: "vegetarian", "vegan", "pescatarian", "coeliac", "no pork". Each entry is a core `RuleTerm`:

```json
{ "name": "vegetarian", "phrases": ["vegetarian", "veggie"], "ids": ["meat", "fish", "shellfish", "gelatin"], "severity": "preference", "form": "rule_diet" }
```

- `phrases` are what the player might type. A phrase belongs to one term only.
- `ids` must all be ids in `data/ingredients.json`, and together they must cover everything the word excludes. A term is never narrower than the word (spec §2.2, pre-flight C5).
- `severity` is `anaphylactic`, `allergy`, `intolerance`, `preference`, or `null` when the card must ask. "coeliac" and "no pork" are `null` on purpose: a default would lower a stated allergy ("no pork, I'm allergic").
- `form` is the 27-B card it uses: `rule_allergen`, `rule_intolerance` or `rule_diet`.

The game build compiles the file into the content bundle (`ruleTerms`) and checks it with core `validateRuleTerms`. A bad entry fails the build, naming the file and the term: an id missing from the graph, a phrase used by two terms, an unknown severity or form. The API loads the same file into its catalog (Step 7).

JSON has no comments, so its review flags live here:

- `# REVIEW:` halal, kosher and Jain are deliberately absent. No one target can express them, so they resolve to `rule.unknown_term` (or an options list), never to a narrower rule. Adding a term for any of them needs a reviewer from that tradition, and the graph must first carry everything it excludes.

### The weekly loop's Pan triggers (Milestone 5)

Code fires these by id, so they are all in `REQUIRED_PAN_TRIGGERS` (`apps/game/src/content/required.ts`, with each one's `ai` value in `M5_LOOP_TRIGGERS_AI`). Written lines only, even where `ai: allowed` (Ruling 21). The `ai: never` ones are plain read-backs and safety lines, and their first lines are pinned by `required.test.ts`.

| Trigger | ai | When | Vars |
|---|---|---|---|
| `plan.readback` | never | Read-back of a plan card: what goes on which day. | `summary` |
| `plan.dish_unknown` | never | A named dish isn't one the cooks teach; nothing is guessed. | `dish` |
| `plan.unverified_dish` | never | A planned dish is ❓; check the labels. | `dish` |
| `plan.fewer_than_asked` | never | "Pick N" found fewer dishes that pass the rules. | `count` |
| `plan.dish_sacred` | never | A sacred dish named in a plan; kept for its occasion (M5 Step 3). | `dish` |
| `plan.which_day` | never | A planned dish's day names no single day ("weekend", "tonight"): which day? (M5 Step 8). | `dish` |
| `plan.after_which_day` | never | "Pick N after …" names no single day: which day? Nothing was picked (M5 Step 8). | `day` |
| `plan.hard_week` | allowed | The player said it's a hard week: easy dishes, no extras. | |
| `one_more.offer` | allowed | The weekly technique slot (new). | `technique`, `known`, `dish`, `day` |
| `one_more.refresh` | allowed | The weekly slot as a refresher; an invitation, never a warning. | `technique`, `dish` |
| `one_more.declined` | allowed | "Not this week": full, warm, no cost. | |
| `one_more.accepted` | allowed | Drill day added before the cook day. | `day` |
| `market.ticked_pantry` | allowed | Ticked items went into the pantry. | `items` |
| `market.run_done` | allowed | The run is finished (once a week). | |
| `rescue.offer` | allowed | Use-It-Up, as a rescue (audit M-14). | `item`, `technique`, `dish` |
| `rescue.compost` | allowed | Compost, warmly. | `item` |
| `rescue.unverified` | never | The rescue's frame or dish is ❓ for the player. | `item` |
| `frame.offer` | allowed | A Pantry Frame from what's in the cupboard; never comments on how much is there. | `frame`, `technique` |
| `frame.slot_empty` | never | A required slot has no filler that passes the rules. | `slot` |
| `cook.who_ate` | allowed | After cook mode: "Who ate with you?" Skippable. | |
| `cooked_for.alone` | allowed | Just me: equal warmth. | |
| `cooked_for.shared` | allowed | Fed others. | |
| `cook.changes_ask` | allowed | "Did you change anything?" Skippable. | |
| `margin.readback` | never | Read-back of a margin-note card. | `summary` |
| `margin.blocked` | never | A note's swap or addition clashes with the player's rules. | `finding` |
| `margin.needs_account` | never | Notes are account-only. | |
| `log.dish_offer` | never | The one-tap log card after cooking. | `dish` |
| `quest.recognize` | allowed | Generic recognition, until M10's cook lines; never "a version of". | `technique`, `cook` |
| `quest.travel_anyway` | allowed | An unintroduced cook, visitable anyway (Ruling 3). | `cook` |
| `quest.errand_adapted`, `quest.cook_adapted` | never | A rule-blocked errand or dish, passed the adapted way with the same rewards (M5 Step 2). | `cook` |
| `certificate.technique` | allowed | "Yours": the Bureau Certificate of Technique (Form 51-T). | `technique` |
| `book.empty` | allowed | The Recipe Book before any dish is taught. | |
| `book.exported` | never | The book file was saved; it's yours, always free. | |
| `nav.offer` | never | The line beside a navigation chip. | `place` |
| `plan.which_count` | never | A corrected pick count ("pick 2, actually 3"): how many? Nothing was picked (M5 final review m6). | |
| `rule.weight_deflect` | never | Weight loss, weight or BMI, or counting calories: a plain deflection to a clinician; code answers, the model never sees the turn (M5 final review I2). | |

Also emitted by core since Step 4 fix round 1: `rule.which_kind` (ai: never, vars `term`, `examples`), the ask for a category too broad to be one rule ("allergic to herbs").

**Content review (M5):** every line above, with these first: `quest.errand_adapted`, `quest.cook_adapted` and `plan.dish_sacred` (kept as written in Steps 2–3), `plan.which_day` and `plan.after_which_day` (new in Step 8), and `one_more.refresh`, `rescue.compost` and `introduction_received` (reworded in fix round 1 so a refresher never names the absence, compost brings no word of shame, and an introduction opens no door).

Rewritten in M5 (C30): `stamp_earned` spends nothing (stamps are spent nowhere until M10, Ruling 17); `introduction_received` opens no new country (every launch cook is already on the map, Ruling 3); `skill_up` is about technique tiers, never levels (Ruling 4), and its variable is `{technique}`.

The new Bureau forms: `margin_note` (2-M/MARGIN, a plain safety form: notes are health data, Ruling 9), `cooked_for` (5-S/SHARED TABLE: a fixed count and an optional fixed word, never a name), `technique_certificate` (51-T) and `frame` (8-F/FRAME). Form 7-W gains `days`, `hard_week` and `one_more`; Form 12-M gains `for_dish` and `general_stall`, whose label names the general stall.

### The market's Pan triggers (Milestone 6)

Steps 9–10 fire these by id (Step 5 adds them to `REQUIRED_PAN_TRIGGERS`). Written lines only, even where `ai: allowed` (M5 Ruling 21); each `ai: never` trigger has 4–6 lines. No line uses a streak or count word, a countdown or scarcity word, a currency, "buy" from a keeper, or a joke about a sparse cupboard.

| Trigger | ai | When | Vars |
|---|---|---|---|
| `market.no_calendar` | never | No seasons calendar for the player's region (or none set): the seasonal round is left out, said plainly. Never "your region isn't supported". | |
| `market.stall_wait` | never | The rules can't be read yet, so the stall waits (fail closed). | |
| `market.bank_small` | never | Some questions were left out (they name something the rules block or can't check). Never says which. | |
| `market.practice` | allowed | A stall opened on a day with no run: practice, any day. | |
| `market.round_done` | allowed | A round ends: no score, no count. | |
| `market.leave_round` | allowed | The player leaves a round partway: it costs nothing. | |
| `market.no_swap` | never | No stall swap passes the player's rules for an item. | `item` |
| `market.stock_swapped` | never | Read-back after taking a stall swap: labelled and re-checked. | `item`, `swap`, `dish` |
| `season.now` | never | The note beside an item in season where the player is (✅ items only). | `item` |
| `season.other` | never | A neutral note for the region's other categories; never a warning. | `item`, `category` |
| `market.checkoff_readback` | never | Read-back of a check-off card (Step 8). | `summary` |
| `market.checkoff_none` | never | Nothing said matched the open list; nothing ticked. | |
| `market.no_run` | never | A check-off with no open market run: points at the list chip. | |
| `errand.question` | allowed | An errand's stall question; the step passes whatever is answered. | `stall`, `item` |
| `cook.drill_first` | never | Ruling 16: a recipe skill's prereqs aren't at Seen; the drill is offered, Cook stays. No ❗, no "should". | `technique`, `cook` |
| `stamp_earned.market_game` | allowed | The weekly stall stamp. Spends nothing. | `stall` |

Also new in M6 Step 4: each stall's `out_of_stock_none` (above), and Form 14-S/STALL (`forms.stall_round`) for the minigame panel: its `game` labels (one per minigame key, "Seasonal or well-travelled?" first), the example-price footnote and "*No stall keeper will sell you anything. They are teachers with tables." Form 12-M's meat footnote lost "Example prices": the list shows no prices.

### The voice scan

`apps/game/src/content/voice-scan.test.ts` runs over every line, form, frame and recipe (title, steps, ingredient display names and notes) the client bundle carries: voice §7's banned words; unlock, loot, collect, acquire, discover, and "found" about recipes; streak, "missed" and "x days"; "version of"; Guild, price, upgrade, premium, subscribe; HIPAA and "medical-grade"; hours or calories in nourishment or rescue lines; a frame or rescue line about a sparse cupboard; scarcity words and joke cues ("regret", "bare", "empty fridge", "worked with less", "better stocked" …) on any intake or pantry line and any line that names the cupboard, fridge, pantry or a shelf (M5 final review I4); and spending stamps. No pattern is weakened (Ruling 24): a legitimate teaching line a pattern catches goes in `apps/game/src/content/voice-allowlist.ts`, by file, location (its key path) and exact text, with its reason; the same words pasted anywhere else are scanned. Edit an allowlisted line and the scan fails again until the entry is re-justified. The market stalls are scanned too (M6 Step 5), as they ship in the lazy market module (`virtual:kq-market`): every stall line, prompt, option text, reaction, explanation, item tip, FAQ chip and answer (and `a_if_blocked`), the keepers' greet, idle and farewell lines, the Protein Counter's content, Wen's seasonal round and The Season's Table's names and labels. Two patterns cover all content: the crime framing of shipped food that Ruling 6 retired (the old round name's second word) and any currency symbol (`$ £ € ¥ ₹ ₩ ₦ ₱ ¢`, Ruling 5). Two more cover the stalls: scarcity or countdown wording ("sold out", "hurry", "only N left", "last chance", "selling fast" …) and a "mysterious" spice. Every line of Okafor-Sato's own file is checked for pronouns, named or not. The food-safety keep times ("Fridge 3–5 days"), Big Bram's cost-per-serving teaching and the "Sold out of {item}" stock lines are allowlisted by location; the other lines the scan caught were reworded and carry a `# REVIEW:` flag in the stall file.

The build checks the stall files strictly too (`apps/game/build/content/compile.ts`, M6 Step 5): an unknown key anywhere fails (so a misspelt `contains:` or `countries:` can never drop a check), then core's `validateStallFile` (graph ids, one correct of 3–4 options, the games Form 14-S names, country scopes, chalkboard arithmetic, currency symbols), `validateSeasonTable` (`data/seasonality.yaml`, including deadline or scarcity words in a label) and `seasonalAgrees` (Wen's seasonal answers match the table). Each stall's safety lines (`out_of_stock`, `out_of_stock_none`, `medical` / the Spice Merchant's `allergen_note`, Bram's `religious_rules`) must exist and be `ai: never`. A question id is unique across all four stalls.

**Option order is pinned (Ruling 2).** A saved stall answer is an option index in file order, so once a question ships its option texts are pinned in `apps/game/build/content/market-pins.json`. Re-ordering or rewording an existing question's options fails the build with "give the question a new id". A deliberate text fix re-pins that one question in the same commit (`npm run content:pin -w @kitchenquest/game -- --repin <id>`), and the pin diff is reviewed. A new question fails the build until `npm run content:pin -w @kitchenquest/game` adds its pin; the build never writes the file itself.

## Content review for the founder: everything M5 flagged, in one place

Each line below was flagged during M5 (Steps 1–12, from the SDD ledger and the step reports). None of them failed a scan: every one passes the voice scan and the never-rules sweep. They are listed because a person should read them before launch. Pan triggers are in `dialogue/pan.yaml`, and forms are in `bureau/forms.yaml`. "Chrome" means the words are written in code, not in `content/`.

**Pan lines: read these first**
- [ ] `quest.errand_adapted`, `quest.cook_adapted`: a rule-blocked errand or dish, passed the adapted way (Step 2, kept as written).
- [ ] `plan.dish_sacred`: a sacred dish named in a plan. Line 2 ("I'll leave it out of the plan, with respect") and line 3 ("like an ordinary supper") were singled out by the Step 3 review (Step 3).
- [ ] `plan.which_day`, `plan.after_which_day`: new asks (Step 8).
- [ ] Reworded so that a refresher never names the absence, compost carries no word of shame, and an introduction opens no door: `one_more.refresh[1]`, `rescue.compost[2]`, `introduction_received[3]` (Step 4 fix round 1).
- [ ] Rewritten for C30: `stamp_earned` spends nothing, `introduction_received` opens no new country, and `skill_up` is about tiers, with `{technique}` (Step 4).
- [ ] Reworded when the voice scan caught them: intake "twice for the price of once" → "the effort of once", and `plan.blocked_dish[3]` "find another dish" → "pick another dish" (Step 4).
- [ ] Reworded so that a ❓ is never "fine": `rescue.unverified[0]`, `plan.unverified_dish[2]`, and `plan.fewer_than_asked`, rewritten for any count (Step 4 fix round 1).
- [ ] `rescue.unverified`, all four lines: "I can't check a dish for the {item} against your rules. Check the label before you cook." and three like it. They must not contradict the ❓ frame offer (Step 10 fix round 1, Ruling 3).
- [ ] `plan.blocked_dish`: the two lines that did not name the dish now name `{dish}` (Step 10 fix round 1).
- [ ] `week.move_partial`: a truthful line when only part of a week moved to the account (Step 10 fix round 2).
- [ ] `margin.blocked`, all four lines: the note can be kept, and "Cook with my notes" stays off for the dish while it clashes. Each is flagged `# REVIEW` (Step 11 fix round 1, I4).
- [ ] `quest.not_saved`: the runner's line when a step did not land (Step 9).
- [ ] **All 30 new M5 triggers and the four new forms** (`margin_note` 2-M, `cooked_for` 5-S, `technique_certificate` 51-T, `frame` 8-F, plus the Form 7-W and 12-M fields). Start with the `ai: never` read-backs: `plan.readback`, `plan.dish_unknown`, `plan.unverified_dish`, `plan.fewer_than_asked`, `rescue.unverified`, `frame.slot_empty`, `margin.*`, `log.dish_offer`, `book.exported`, `nav.offer` (Step 4).

**Chrome: words written in code**
- [ ] The guest-progress offer ("Add this device's progress to your account?", `kitchen/apprentice-card.ts`) and the ❓ quest panel ("Learn it as a lesson", "Cook it anyway", `quests/`) (Step 9).
- [ ] The after-cook status lines: "Stamped.", "Skipped. Nothing was kept.", "Not logged. That costs nothing.", "I couldn't read that as who ate…", the full-margin notice, "not in your book yet" and the unreadable-notes line (`cook/after-cook.ts`, `book/`) (Step 11).
- [ ] The Cooked for Someone count words ("Just me", "You and one more", "You and two or three more", "You and four or more") and the who chips, "Flatmate" among them (`book/slips.ts`) (Step 11).
- [ ] `EMPTY_SLOT_TEXT` in `apps/game/src/recipes/card-view.ts`, reworded in the M5 final review (m10) to "nothing I can check against your rules fits this yet, so this dish isn't ready to cook". It no longer mentions the cupboard (audit M-4), and it is true when items are there but the rules refuse them.
- [ ] The apprentice card's outfitter note, "*Stamps are kept with your papers. The Bureau's outfitter opens later." (Ruling 17: no price, no shop) (Step 9).

**Food safety and data (a quick check against a current source)**
- [ ] Every `# REVIEW: food safety` line in the three seed frames (`frames/`): cold rice, reheating, raw egg, herb washing and soft tomatoes. The fried-rice egg line, the green-sauce line and the tomato-sauce line could not be verified (Step 4 data check).
- [ ] Every `data/keeps.json` day count. `cooked_rice` is 1 day, the most conservative figure (NHS/FSA). Herbs (4 days) and epazote (4 days) could not be verified (Step 4 data check).
- [ ] The M5 graph nodes (C12): `tomato`, `herb` (label-dependent and broad), `spinach`, `lime` and `cooked_rice` (FDC 168932), plus `peanut_oil` (FDC 171410) and its aliases. They carry no allergen claim beyond their data (Step 4).
- [ ] The `cooked_rice` aliases ("leftover rice", "cold rice", "day-old rice"), which read any leftover as plain cooked rice (Step 4 fix round 1, M9).
- [ ] The placements in `data/stalls.json` and `data/food-groups.json` (Step 4).
- [ ] The storage FAQ keep times for Leela ("three or four days") and Marisol (corrected from four or five days to three or four, FSIS) (Step 4).
- [ ] The `VOICE_ALLOWLIST` entries and their reasons (three countdown entries were removed by rewording in the M5 final review) (`apps/game/src/content/voice-allowlist.ts`, Ruling 24) (Step 4).

**M5 final review: new or reworded lines (read these first)**
- [ ] `rule.weight_deflect` (new, I2): four `ai: never` lines for weight loss, weight or BMI and calorie counting. No numbers or targets; each points to a doctor or dietitian and keeps the door open to cooking. Spec §5's safeguards and voice §0.9–10.
- [ ] `plan.which_count` (new, m6): the ask after a corrected pick count.
- [ ] `intake.pantry.ask[0]` (I4): "Rice, half an onion, and regret" was a sparse-cupboard joke (audit M-4). Now "Last one: what's in the cupboard right now? A rough list is plenty, and whatever's there is a fine place to start."
- [ ] `intake.pantry.followup[2]`, `[3]`, `[4]` (I4): the "regret" callback, "better stocked than a lighthouse" and "I've worked with less" commented on how much was there. Reworded; the new voice-scan pattern (scarcity words and joke cues on intake, pantry and cupboard lines) now catches all three forms.
- [ ] Countdown rewordings (m14), so their allowlist entries are gone: `plan.saved[3]` ("only a guess" → "just a guess"), `plan.dish_unknown[1]` ("left it out" → "kept it out"), `frame.slot_empty[3]` ("left it unfilled … until you pick something you've checked" → "I haven't filled it … until you pick something I can check": the player's own label check never clears ❓).
- [ ] The prompt's few-shot player lines (m3, not shown to players): "We're out of butter now.", "Breakfast around quarter past eight.", "For this week, put the stew on Thursday and the pasta on Saturday."

**Founder decisions (not built)**
- [x] **The drill-first hint (final review m9, Task 9 concern 7, Ruling 4).** Built in M6 (Ruling 16, Step 10) on its proposed shape: advisory, Cook stays enabled, none in Family Table. The founder may still defer or narrow it: see the M6 list below.

## Content review for the founder: everything M6 flagged, in one place

Each line below was flagged during M6 (Steps 1–11, from the SDD ledger and the step reports). None of them fails a scan: every one passes the voice scan (`voice-scan.test.ts`) and the M6 never-rules sweep (`never-rules.e2e.test.ts`, every market screen in standard and Family Table mode). They are listed because a person should read them before launch. Stall files are in `market/`, Pan triggers in `dialogue/pan.yaml`, forms in `bureau/forms.yaml`. "Chrome" means the words are written in code, not in `content/`.

**Pan lines: `ai: never` first**
- [ ] The market triggers in "The market's Pan triggers (Milestone 6)" above, `ai: never` ones first: `market.no_calendar`, `market.stall_wait`, `market.bank_small`, `market.no_swap`, `market.stock_swapped`, `season.now`, `season.other`, `market.checkoff_readback`, `market.checkoff_none`, `market.no_run`, `cook.drill_first`. Then `market.practice`, `market.round_done`, `market.leave_round`, `errand.question` and `stamp_earned.market_game`.
- [ ] `intake.unavailable` (new, `ai: never`, Step 10): what the Pan says when Form 1-A's lazy module can't load. Nothing is lost; the next open tries again. Never said in a child conversation (Task 10 ruling I1).
- [ ] `market.answer_right` (new, Step 9): the Pan's food-free line after a right stall answer when the keeper has none that is safe for the player's rules. `market.cheer` stays for check-offs.
- [ ] `market.cheer[5]`: "Right again. I'm almost impressed. Almost." → "Right. I'm almost impressed. Almost." ("again" counted a run of right answers; no-pressure rule, C18).
- [ ] `season.other[0]`: "{item}: {category}." → "{item} here: {category}." (Step 5: as a pattern the old line matched almost any "X: Y." sentence).
- [ ] The stamp name **"A Stall Round, Played Through"** (`bureau/forms.yaml` `stamp_names.market_game`, Step 3).

**Stall lines reworded by the scans (each carries a `# REVIEW:` in its stall file)**
- [ ] The seven Step 5 voice-scan rewordings: Bram's `bram-thaw` reaction ("In a hurry" → "Short on time"); Bram's marbling FAQ `a` and `a_if_blocked` ("thin streaks of fat" → "thin flecks of fat"); Wen's November tomato reaction ("mealy and sad" → "mealy and dull"); `wen-squash-best` option and reaction ("green streaks" → "green stripes"; the option text is re-pinned in `market-pins.json`); `wen-carrot-tops` reaction ("soft and sad" → "soft and floppy"); Wen's `avocado.store` tip ("to hurry it" → "to speed it up"); and Bram's `ground_beef.pick` tip (below).
- [ ] Bram's `ground_beef.pick` tip, reworded twice: "80/20 for juicy burgers" (the x/y pattern, Step 5) → "about 80% lean" → **"about four parts lean to one part fat for juicy burgers"** (Step 11: the M5 never-rules percentage pattern caught it on screen, and no line is excused from it).
- [ ] The FAQ `a_if_blocked` that named "legumes", now "Small split ones" (Step 5 fix round 1), and Okafor-Sato's other `a_if_blocked` answers (Task 5 carry).

**Questions the rules hide for some players (read the reactions)**
- [ ] **Butternut.** Bare "butternut(s)" is ambiguous: the rule entry offers "butternut squash" or "butternut, the tree nut", never picks one, and the text scan treats it as both (Task 4 ruling). So Wen's butternut-squash questions are hidden for a tree-nut player (the safe side). The founder may reword them to say "winter squash" so they stay.
- [ ] **Chile.** Wen's pear and blueberry reactions name Chile (the country) as where the fruit travels from, and "chile" is an alias of chilli (Task 4 fix round 2, N1), so those questions are hidden under a chilli rule. A reword ("from South America") would keep them.

**The market list and the chalkboard**
- [ ] **"some"** (`UNWRITTEN_AMOUNT`, core `week/amounts.ts`; chrome): a row where one dish's line has no quantity shows "2 + some" or "1 tsp + some", never an invented weight (Ruling 12, Step 3 fix round 1).
- [ ] Bram's chalkboards (Ruling 5): no currency anywhere. The braise prices are unchanged (22.50, 38, 24, 60). The Protein Counter's were tweaked so each divides exactly, with no "≈": lentils 1.79 → 1.75 (0.25 a serving), tofu 2.79 → 2.80 (0.70), tempeh 3.49 → 3.50 (1.75); eggs stay 4.20 (0.70). The bean-yield reaction keeps 1.89 and 4 × 1.29 = 5.16 as example numbers. "Buy shank if the chuck's gone" became "Shank's the one to pick if the chuck's gone", and "the best few dollars you'll spend" became "the most useful little tool in a kitchen".
- [ ] Form 14-S/STALL (`forms.stall_round`): title, title aside, the `game` labels ("Seasonal or well-travelled?" first), the buttons and both footnotes ("*Example prices in no particular currency. Your shop will differ." and "*No stall keeper will sell you anything. They are teachers with tables.").
- [ ] **Form 9-Q/Practice Log's footnote** was rewritten to match Ruling 1 (Step 4 fix round 1, I2): one stall stamp a week for any round played through and 5 XP for each first correct answer; its "Correct answers" score field is gone. Two forms now describe stall rounds; the founder may retire 9-Q for 14-S.
- [ ] Form 12-M's meat footnote lost "Example prices": the list shows no prices.

**The market's content (Step 4)**
- [ ] Each stall's new `out_of_stock_none` (four lines each, in the keeper's voice): no swap passes the player's rules; skip it this week.
- [ ] The 26 new `a_if_blocked` answers (Wen 5, Bram 8, the Protein Counter 4, Okafor-Sato 4, the Spice Merchant 5): each says the same thing as its `a` without naming an ingredient.
- [ ] The seasonal round is now **"Seasonal or well-travelled?"** (Ruling 6: its old name framed shipped food as a crime): Wen's `games.seasonal`, every seasonal prompt's closing question, and option C, now the table's own label "Well-travelled: shipped in from far away". The question ids are unchanged.
- [ ] Bram's US-scoped label questions (Ruling 8): air-chilled (most US chicken is water-chilled; air-chilling is the EU norm), grass-finished, sell-by and no-hormones show only to players in the United States.
- [ ] **"Mr. Okafor-Sato"** (Ruling 23, carried from the file's own founder note): "Mr." is itself gendered, and a neutral display name ("Okafor-Sato") may fit better. M6 is the first milestone to put the name on screen. Kept as written until the founder rules.
- [ ] The Season's Table (`data/seasonality.yaml`): Pacific Northwest only, November–February, `status: draft`. Its region phrases ("washington state", "western washington", "wa", "oregon", "portland oregon", "portland or", "seattle", "pacific northwest", "pnw"); a bare "Washington" or "Portland" gets no calendar. "Oregon" also names a few small towns in other states (Oregon, Ohio), which would get this calendar. Which regions come next is decided with the ROADMAP launch-region item (Ruling 9).

**Every `# REVIEW:` the M6 steps added (`grep -rn "# REVIEW:" content/ data/seasonality.yaml`; the JSON files' flags are under "Data files" above)**
- [ ] The market graph nodes (88 in `data/ingredients.json`) and their FDC records, and the bare names restored in Step 4 fix round 1 and Step 5 fix round 1 (`chuck`, `squash`, `rice_grain`, `legume`, …), and the Pan's everyday-word list (`EVERYDAY_WORDS` in core `mentor/route.ts`), which the health gate's near-miss matching skips.
- [ ] The allergen judgement edges: `asafoetida` → wheat, label-dependent (compounded hing is often cut with wheat flour); `leek` (and `green_onion`) → `allium` and `fodmap_fructan`; `tempeh` → soy and `unsafeFor` the wheat, gluten and barley rule targets (grain tempeh); `seitan` → wheat and `unsafeFor: [soy]`; `furikake` contains sesame, fish, soy and wheat, label-dependent for milk and egg; `miso` label-dependent; `butternut_nut` `unsafeFor: [walnut, pecan]`; moong and toor dal `isA bean`; the `legume` category over beans, peas, lentils, chickpeas, peanut, soy and lupin.
- [ ] `pnw-usa`'s months (November–February only, `status: draft`), its sources, the November nettle and mushroom calls, and its region phrases. "oregon" also names small towns in other states (Oregon, Ohio), which would get this calendar; a bare "Washington" or "Portland" gets none.
- [ ] The three stall swaps' notes (`data/substitutions.json`): half a small onion for three small shallots; one dried red chilli for each green chilli; the same amount of split red lentils for moong dal.
- [ ] The `countries:` scopes: Bram's four US label questions; US territories are not inside the United States for a scope; the UK nations keep their own names, with "United Kingdom" containing all four.
- [ ] The 52 new `VOICE_ALLOWLIST` entries and their reasons (`apps/game/src/content/voice-allowlist.ts`): 45 food-safety and ripening keep times, 5 cost-per-serving lines, 2 "Sold out of {item}" stock lines.

**Chrome: words written in code**
- [ ] The stall screen's own words (`market/stall-screen.ts`, `round-view.ts`): "Question n" (orientation only, never a count of right answers), the right-answer marks "(your pick, the right one)", "That is the round.", "Another round", "Leave the stall", "There are no questions for you at this stall today", the market-offline and "answers can't be kept" lines, and the Protein Counter's consent note.
- [ ] The stock control (`week/stock-view.ts`): "Out of stock?", "(for {dishes})", the skip and undo words, and the list row's "stall swap for {dish}" and "(out of stock)"; cook mode's "swapped at the market: {swap} for {item}".
- [ ] The check-off card's buttons and states ("Tick these", "Not now", "Undo", "(not ticked)"), including its "(not ticked)" wording for a row ticked earlier on screen (Task 10 re-review carry).

**Open `[founder]` rulings (each built on its default; overridable)**
- [ ] **Ruling 1:** 5 XP for each question's first right answer, and one stall stamp a week for any round played through, whatever the answers.
- [ ] **Ruling 3:** the Fishmonger and Dairy & eggs stalls wait for M10 content; fish and dairy stay at the General Counter.
- [ ] **Ruling 5:** chalkboard prices are example numbers in no particular currency.
- [ ] **Ruling 6:** the seasonal round is "Seasonal or well-travelled?" (its old name framed shipped food as a crime; listed above).
- [ ] **Ruling 9:** only the Pacific Northwest calendar; every other region gets "no calendar yet". Which regions come next is decided with the ROADMAP launch-region item.
- [ ] **Ruling 13:** a bare "no fennel" at check-off stays a health ask (one extra turn), never a stock note.
- [ ] **Ruling 15:** the market is a hub (`#/stalls`) over the market scene, not one scrolling market.
- [ ] **Ruling 16:** the drill-first hint, built advisory on the recipe and cook screens (defer to M10, or narrow to the recipe screen: only the strip hook in `cook/cook-screen.ts` changes).
- [ ] **Ruling 23:** the keeper keeps the display name "Mr. Okafor-Sato" (listed above).

## Review flags

Any claim a writer isn't sure of is marked with a `# REVIEW:` comment on the line above it. Cultural and culinary claims in a cook's file need a reviewer from that cuisine's community before the cook's recipe can be `status: reviewed` (spec §10). Shopping and food-safety facts need a quick check against a current source (USDA/FSIS, a national food-safety agency, or the relevant growers' board).

Find them all with:

```sh
grep -rn "# REVIEW:" content/
```

## Adding a cook

Copy `cooks/leela.yaml`, keep every section, and write the `introduction` from the previous cook. Every cook needs: a reviewer from the tradition, a credited community, a difficulty-1 first dish (spec §11), and FAQ entries for the five questions people will certainly ask (substitutes for the hard-to-find ingredient, storage, scaling, a shortcut, and "can I make it without X").
