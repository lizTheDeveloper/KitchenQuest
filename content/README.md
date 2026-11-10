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
    - { type: errand, stall: wen, item: onion, lines: ["..."] }
    - { type: cook, recipe: india/kerala/parippu }
  rewards: { xp: 40, trust: 1, skills: { knife: 10 } }
```

- Steps run in order. The files write steps in block style; it's the same YAML.
- `unlock.requires` lists quest ids that must be complete. `unlock.trust` is the minimum trust with this cook.
- **riddle:** exactly one option has `correct: true`. Wrong options keep the player on the step ("try again"); every option has a `reaction`. `explain` is shown after the correct answer, as the plain-language reason.
- **drill:** a short technique lesson. `skill` is a skill id (`knife`, `heat-control`, `tempering`, `legumes`, `patience`, `grains`, `shaping`, …). `prompt` is the instruction; `lines` are the cook's coaching.
- **errand:** sends the player to a market stall (`wen`, `bram`, `okafor-sato`, `spice`) for `item` (an ingredient id). The stall's own choosing minigame for that item runs if one exists. `lines` are what the cook says when sending and on return (the last line is the return line). If the rules engine blocks the item, the stall offers the cook's adapted version instead; the cook's `faq` covers the substitute.
- **cook:** opens cook mode for `recipe`, a path under `recipes/` without the `.cook` extension (`india/kerala/parippu`).

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
| `mentor.check_card` | Replaces model text that touched a dish's fit, a rule, a medicine or food safety; points at the card and the label (Step 7). | |
| `confirm.tap_card` | A typed "yes" or "no" with more than one card open. | |
| `write.not_done` | Replaces a model reply that claimed a write that didn't happen. | |
| `consent.health_first` | A rule or meal card for a player without `health_data` consent; the 3-C/HEALTH card follows. | |
| `child.grownup` | A child is talking. Exactly one fixed line, no joke. | |
| `allowance.explain` | Any question about plans, prices or the chat allowance. Never names the Guild, a price, a plan or a tier (never rule 7). | |
| `log.needs_account` | A meal log for a signed-out player. | |
| `profile.readback`, `pantry.readback` | Read-back of a profile/schedule or pantry card, like `log.confirm_readback`. | `summary` |
| `ai.try_again` | The AI failed; the player's message is held for "Try again". | |
| `mentor.ai_unavailable` | The mentor's AI failed or is off; the script answers. Never says "saved", "kept", "logged", "stored" or "photo". | |
| `forget.done` | The player cleared their conversations. | |

The engine also emits the existing `rule.*` read-back, stamp, void, emergency and medical lines, `log.confirm_readback`, `log.logged`, `pantry.added`/`removed`, `schedule.set`/`bad_time`, `undo`, `undo.nothing`, `didnt_understand`, `rate_limited`, and every Form 1-A intake trigger (`intake.open` to `intake.complete`, listed one by one).

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

## Review flags

Any claim a writer isn't sure of is marked with a `# REVIEW:` comment on the line above it. Cultural and culinary claims in a cook's file need a reviewer from that cuisine's community before the cook's recipe can be `status: reviewed` (spec §10). Shopping and food-safety facts need a quick check against a current source (USDA/FSIS, a national food-safety agency, or the relevant growers' board).

Find them all with:

```sh
grep -rn "# REVIEW:" content/
```

## Adding a cook

Copy `cooks/leela.yaml`, keep every section, and write the `introduction` from the previous cook. Every cook needs: a reviewer from the tradition, a credited community, a difficulty-1 first dish (spec §11), and FAQ entries for the five questions people will certainly ask (substitutes for the hard-to-find ingredient, storage, scaling, a shortcut, and "can I make it without X").
