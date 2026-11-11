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
persona: ["..."]
triggers: { ... }          # line bank: greet, correct, wrong, idle, etc.
questions:                 # the minigame bank
  - id: wen-avocado-ripe
    game: ripeness         # which minigame shape the UI uses
    prompt: "..."
    options:
      - { text: "...", correct: true, reaction: "..." }
      - { text: "...", correct: false, reaction: "..." }
    explain: "one plain sentence, true on its own"
    contains: [avocado]    # optional: ingredient ids involved, for rules filtering
item_tips:
  avocado: { pick: "...", store: "..." }
faq: [ ... ]
```

- Each question has 3–4 options, exactly one `correct: true`. The correct option's `reaction` is the "right!" line; each wrong option's `reaction` is its funny, true explanation. `explain` is shown after any answer.
- **Rules filtering.** Before a question is shown, the rules engine checks `contains` and each option's `contains` (when present). A question whose correct answer involves a blocked ingredient is dropped for that player. Blocked items never appear as correct answers.
- **Bram's Protein Counter.** `bram.yaml` has a `variants.protein_counter` block with its own triggers and questions. The game uses it when the player's confirmed rules exclude meat (vegetarian, vegan, or a custom rule). Questions in it with `contains: [egg]` or `[milk]` are dropped for players who exclude those.
- **Wen's seasonality** lives in `seasonal.<region>.<month>` (month is 1–12). See the comment at the top of `wen.yaml` for how other regions and months plug in. A region/month with no entry simply skips the "Seasonal or smuggled?" round; the general ripeness and storage questions still run.

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

Review flags for the JSON files:

- `# REVIEW:` **every `data/keeps.json` entry**, against a national food-safety source (USDA FoodKeeper, UK FSA): `cooked_rice` 1 day (FSA/NHS: cool within about an hour, fridge, eat within 24 hours; USDA allows 3–4 days, the stricter figure is kept), `spinach` 3, `herb` 4, `epazote` 4, `tomato` 3 (ripe, at room temperature), `green_chili` 7, `lime` 14 (fridge). The Step 4 data check confirmed spinach, tomato, green chilli, lime and cooked rice against extension charts and NHS/FSA; herb and epazote have no primary source yet (conservative, still to confirm).
- `# REVIEW:` **the M5 nodes in `data/ingredients.json`** (Ruling C12): `tomato` (FDC 170457), `spinach` (FDC 168462), `lime` (FDC 168155), `cooked_rice` (FDC 168932, "Rice, white, short-grain, cooked, unenriched", which declares no fibre or sugars, so none is given; `contains: [rice]`, so a rule on rice covers leftover rice) and `herb` (a category, "fresh herbs", no FDC record, no nutrition values). FDC values were checked against the FDC portal (Step 4 data check). The produce nodes carry no `isA`, `contains` or `unsafeFor` edge beyond what their sources state.
- `# REVIEW:` **`herb` is label-dependent and broad** (Step 4 fix round 1, C1). A line or pantry item that says only "herbs" could be any herb (celery leaf, chives, lovage), so it is ❓ under any restricting rule, never ✅, and a Pantry Frame never fills a slot with it for the player. `broad: true` means it is never a rule target: "allergic to herbs" gets `rule.which_kind` ("which one?") with the herbs the graph knows as buttons, never a card on the category. The graph's own herbs, `curry_leaf` (and `curry_leaf_sprig`) and `epazote`, are filed under it with `isA: [herb]`. Filing more herbs (coriander, parsley, mint) under it needs the same review.
- `# REVIEW:` **`peanut_oil`** (FDC 171410, "Oil, peanut, salad or cooking"; M5 Step 4, Step 3 N1), aliases "groundnut oil", "arachis oil", "refined peanut oil", "roasted peanut oil" and "cold-pressed peanut oil", `contains: [peanut]`, and the alias "arachis" on `peanut`, so a margin note or a rule naming them is checked as peanut: ⛔ under a peanut rule, never ✅. Refined peanut oil is treated as containing peanut on purpose: a label can't be verified from here. "PB" is deliberately not an alias (too ambiguous).
- `# REVIEW:` **`cooked_rice`'s aliases** "leftover rice", "cold rice" and "day-old rice" read any leftover as plain cooked rice (`contains: [rice]` only). Takeaway egg-fried rice told as "leftover rice" would fill the fried-rice frame ✅ under an egg rule. The content reviewer decides whether these aliases stay, or whether leftovers need their own ❓ node.
- `# REVIEW:` `data/stalls.json` and `data/food-groups.json` placements (fish and dairy at the General Counter; eggs at Big Bram's Protein Counter; tortillas at Okafor-Sato's, because Doña Marisol asked nicely).

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

Also emitted by core since Step 4 fix round 1: `rule.which_kind` (ai: never, vars `term`, `examples`), the ask for a category too broad to be one rule ("allergic to herbs").

**Content review (M5):** every line above, with these first: `quest.errand_adapted`, `quest.cook_adapted` and `plan.dish_sacred` (kept as written in Steps 2–3), `plan.which_day` and `plan.after_which_day` (new in Step 8), and `one_more.refresh`, `rescue.compost` and `introduction_received` (reworded in fix round 1 so a refresher never names the absence, compost brings no word of shame, and an introduction opens no door).

Rewritten in M5 (C30): `stamp_earned` spends nothing (stamps are spent nowhere until M10, Ruling 17); `introduction_received` opens no new country (every launch cook is already on the map, Ruling 3); `skill_up` is about technique tiers, never levels (Ruling 4), and its variable is `{technique}`.

The new Bureau forms: `margin_note` (2-M/MARGIN, a plain safety form: notes are health data, Ruling 9), `cooked_for` (5-S/SHARED TABLE: a fixed count and an optional fixed word, never a name), `technique_certificate` (51-T) and `frame` (8-F/FRAME). Form 7-W gains `days`, `hard_week` and `one_more`; Form 12-M gains `for_dish` and `general_stall`, whose label names the general stall.

### The voice scan

`apps/game/src/content/voice-scan.test.ts` runs over every line, form, frame and recipe (title, steps, ingredient display names and notes) the client bundle carries: voice §7's banned words; unlock, loot, collect, acquire, discover, and "found" about recipes; streak, "missed" and "x days"; "version of"; Guild, price, upgrade, premium, subscribe; HIPAA and "medical-grade"; hours or calories in nourishment or rescue lines; a frame or rescue line about a sparse cupboard; and spending stamps. No pattern is weakened (Ruling 24): a legitimate teaching line a pattern catches goes in `apps/game/src/content/voice-allowlist.ts`, by file, location (its key path) and exact text, with its reason; the same words pasted anywhere else are scanned. Edit an allowlisted line and the scan fails again until the entry is re-justified. The market stall files aren't in the client bundle yet; they are scanned when M6 gives them a screen.

## Review flags

Any claim a writer isn't sure of is marked with a `# REVIEW:` comment on the line above it. Cultural and culinary claims in a cook's file need a reviewer from that cuisine's community before the cook's recipe can be `status: reviewed` (spec §10). Shopping and food-safety facts need a quick check against a current source (USDA/FSIS, a national food-safety agency, or the relevant growers' board).

Find them all with:

```sh
grep -rn "# REVIEW:" content/
```

## Adding a cook

Copy `cooks/leela.yaml`, keep every section, and write the `introduction` from the previous cook. Every cook needs: a reviewer from the tradition, a credited community, a difficulty-1 first dish (spec §11), and FAQ entries for the five questions people will certainly ask (substitutes for the hard-to-find ingredient, storage, scaling, a shortcut, and "can I make it without X").
