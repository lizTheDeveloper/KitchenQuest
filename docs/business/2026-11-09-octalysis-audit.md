# Octalysis Audit: Kitchen Quest — 2026-11-09

**Method:** `octalysis-audit` skill (Yu-kai Chou's 8 Core Drives). Scores are 0–10 per drive. They are based on what is **designed or prototyped today**:
- the spec, `docs/superpowers/specs/2026-11-09-kitchenquest-design.md`
- the three prototypes in `prototype/`
- the written content in `content/`

Nothing is built yet beyond the prototypes, so a score reflects design intent plus prototype behavior.

**Founder goals tested against:**
1. Push players to learn new cooking skills: "add one more technique to their toolkit".
2. Support sustainable, non-extractive monetization.
3. Stay white-hat-leaning, with no dark patterns, no rewards for eating less, and no shame streaks (spec §2.3, voice guide §0.5–0.7).

**Octalysis axes used below:**
- **White hat:** Core Drives (CD) 1–4. CD5 is neutral. **Black hat:** CD6–8.
- **Left brain** (extrinsic, logic, ownership): CD2, CD4, CD6.
- **Right brain** (intrinsic, creativity, social): CD3, CD5, CD7.
- CD1 is top of the octagon and CD8 is bottom; neither is left or right.

---

## 1. Drive scores

| # | Drive | Hat | Brain | Score | Key mechanics today (evidence) | Main gap |
|---|---|---|---|---|---|---|
| 1 | Epic Meaning & Calling | White | Top (neither) | **6/10** | Apprentice licensed by the Pantry Bureau (§3.1). "Guest, not conqueror" stance (§2.4). Recipes are gifts carried by communities: Leela says "Cook it for someone. That is the only rule." Trust level 5, "Keeper of the dish", means the cook trusts you to teach it on (`content/README.md`, all three `cooks/*.yaml` level-5 lines). Open CC BY-SA canon (§10). Feeding yourself enough is framed as the whole game ("Well fed today. That's the whole game, really", `pan.yaml` `log.enough_met`). | The calling is stated in dialogue but has no mechanic. Being a Keeper does nothing. The open canon and contributor credit are invisible in play. There is no arc beyond "visit more cooks". |
| 2 | Development & Accomplishment | White | Left | **6/10** | XP and apprentice level. Per-dish `skills` feed skill XP, and skill levels gate harder dishes (§6). Drills (§3.2). Five trust levels per cook. Bureau Stamps for first completions (`market.html:886`). Level-up and skill-up toasts. `pan.yaml` `skill_up` lines: "Skills are just mistakes you've stopped making." | Skills are bare counters (`S.skills[skill] += xp`, `quest.html:635`). There is no technique tree, no visible toolkit, and no sign that a technique *transfers* between dishes. XP rewards activity, not mastery: replaying market quizzes earns unbounded XP. There is nothing that says "this week, one new technique". |
| 3 | Empowerment of Creativity & Feedback | White | Right | **3/10** | Pantry talk ("rice, half an onion, and regret"). Substitutions, re-checked by the rules engine. Week planning by conversation. Recipe imports. Photo reactions as rich feedback. Two good seeds in content: Haruka at trust 3, "Try a new filling… If it's good, I'll put it on the board", and Leela at trust 3, "bring me something you cooked from somewhere else". | Cooking is follow-the-steps only. There is no improvise mode from what's in the pantry, no way to record or remix your own variation, and no path for a player's variation to be credited back. The seed lines in content have no mechanic behind them. |
| 4 | Ownership & Possession | White | Left | **5/10** | Your kitchen is home base. Stamps buy kitchen cosmetics (pan hats, aprons, decor). Pantry. Private imported recipes. One-click export of JSON and `.cook` files (§9). Haruka's trust-4 line "You have your own rice paddle here now". | There is no **recipe book** as an object you own: taught dishes are just map pins. Earned skills don't show in the kitchen. Photos and margin notes have nowhere to live. |
| 5 | Social Influence & Relatedness | Neutral | Right | **3/10** | Strong *parasocial* relatedness: the Pan as mentor, cooks' trust lines, introductions between cooks, return-visit lines. Every gift line tells the player to cook for someone. | There are no real humans. Social features are out of scope for v1 (§14). "Cook it for someone" is said many times but never noticed or celebrated. There is no household. *No leaderboards is correct and should stay* (§6). |
| 6 | Scarcity & Impatience | Black | Left | **2/10** | Trust and skill gates on dishes. Countries open only through introductions. Real seasonality: Wen's `seasonal.<region>.<month>` table and the "Seasonal or smuggled?" round. Haruka's "board for one day only". All of it is honest so far. | Seasonality is quiz content only. It never shapes what you're invited to cook this month. *Low is right; it should rise only through real-world seasonality.* |
| 7 | Unpredictability & Curiosity | Black | Right | **4/10** | Randomized, no-repeat line banks (`content/README.md` rule 2). Ingredient riddles. Letters of introduction. "Recipes from Abroad" guest cooks for imports (§3.3). AI photo reactions. Shuffled market options. | Surprise is only in flavor text. There are no surprise visitors and no seasonal "what's good now" moments. No mystery leads to a new technique. |
| 8 | Loss & Avoidance | Black | Bottom (neither) | **2/10** | **By design:** missed days cost nothing, there are no streaks, and `greet.return_after_gap` says "Never mention streaks or lost progress". Honest loss exists in `reminder.use_it_up` ("Let's give it a good ending") and the escalating hours-since-meal reminders. **Unintended:** the prototype subtracts XP and can drop your level when you undo (see §5, R1). | The use-it-up nudge is a reminder only, not a mechanic. The unintended XP loss on undo must go (§5). |

### White Hat Strength: **20 / 40** (CD1 6 + CD2 6 + CD3 3 + CD4 5)
### Black Hat Load: **8 / 30** (CD6 2 + CD7 4 + CD8 2)

**Shape.** The octagon is lopsided toward the top-left: meaning plus left-brain progress counters. The right side is thin: Creativity 3 and Social 3. That is where "one more technique" lives, because a technique is only truly learned once you can *use it without the recipe*.

**Weakest white-hat targets, in order:**
1. **CD3 Creativity**
2. **CD4 Ownership**, specifically the recipe book and the toolkit
3. **CD2 Development**, specifically mastery and transfer rather than XP

Black-hat use is low and mostly honest, which is right. The few problems are implementation drift in the prototypes, not spec intent (§5).

---

## 2. Gaps

### 2.1 CD2 Development & Accomplishment: skills exist, a toolkit doesn't

- **No technique graph.** Recipes carry `skills: [knife, heat-control, sauces]`, and drills carry `skill:` ids such as `tempering`, `legumes`, `patience`, `grains` and `shaping`. Nothing connects them:
  - no prerequisites ("sweating onions → tempering → tadka-finished dal")
  - no adjacency ("you can do this, so this is one step away")
  - no player-facing view of what's in your toolkit
- **The unit of progress is wrong for the goal.** Skill XP piles up from *repetition*: cooking the same onigiri ten times maxes "shaping". The founder's goal is *breadth plus transfer*: one *more* technique, used in more than one dish. Mastery should be measured as **Seen → Tried → Yours**, where "Yours" means you used it in a second dish or a second cuisine. XP totals don't measure that.
- **No "edge of competence" prompt.** Weekly planning (§3.2 Plan) balances nutrition but never proposes a growth step. The Pan flags "Nothing green since Tuesday" but never says "You've never braised. Sunday's a good braising day."
- **Gates are binary and opaque.** "Skill levels gate harder dishes" (§6) hides the reason. A gate should say *which* technique opens it and offer the drill right there. Gates should also be advisory for anyone who already cooks (see R8).
- **Market XP can be ground.** Replaying quizzes adds unbounded XP (`market.html:887`). The apprentice level can then reflect quizzing rather than cooking.

### 2.2 CD3 Creativity: the biggest gap

- **Improvising from the pantry.** The pantry is captured (`update_pantry`, intake `pantry.ask`) but only used to pre-filter the shopping list. It should feed **frames**, not just recipes. A frame is a technique-first template:
  - fried rice: a grain, an aromatic, a protein, high heat
  - frittata
  - soup
  - dal
  - tacos
  - "anything on rice"

  A frame teaches the structure behind a dish, which is exactly what "one more technique" means once the recipe card is put away.
- **Remixing recipes.** There is no data model for "my version". The Cooklang canon is immutable and imports are private, but a player's *margin note* on a canon recipe has nowhere to go.
- **Variations credited back.** The canon is CC BY-SA with a review pipeline (§10). There is a promotion flow for *imports*, but not for *variations of canon dishes*. Haruka's "board" line is the perfect in-fiction hook. The guest stance applies: a variation must credit the original community, and sacred dishes are excluded.
- **Feedback on creativity.** Photo reactions (§7.2) currently react to fidelity. They should also be able to react to a *deliberate change* ("You added lime. My aunt would object. I approve.").

### 2.3 CD5 Social Influence: cooking *for* people, privately

- The content tells the player to cook for someone at least five times: Leela, Marisol and Haruka's gift lines, and Marisol at trust 5. The game never notices when they do.
- **Privacy constraints:**
  - meal logs and rules are encrypted health data (§9)
  - there are no leaderboards (§6)
  - public photo sharing is out of scope (§14)

  So social design must be **about the cooking, never about the eating**. Who you fed is fine. What *you* ate, how much, or your symptoms never leave your account.
- **Household or guild.** The most valuable social unit for a cooking game is the *household*: a shared plan, a shared market list, a shared pantry, and "who in the house can temper". The second is the **Keeper teach-back**: a person you taught, offline. A "guild" in the MMO sense, with public groups and rankings, would invite comparison. Avoid it.
- **No-leaderboards stance: keep it.** Any comparison of intake, frequency or speed is a disordered-eating risk and invites the faking that §6 says is pointless. Allowed social signals:
  - co-op: a household's shared toolkit
  - gift: a recipe postcard
  - recognition: a cook's reaction

  Never rank.

### 2.4 CD4 Ownership: your recipe book, your kitchen

- **Recipe book.** This should be the central owned artifact. Each page holds:
  - the cook's gift line and credit
  - the techniques the dish uses
  - your private photos
  - your margin notes
  - the dates you cooked it
  - who you cooked it for

  It *fills by being taught*, not by collecting. The voice guide §0.3 bans "collected/unlocked", so there must be no "8/9 recipes" completion meter for cultures.
- **Kitchen as a mirror of skill.** Today, cosmetics are bought with stamps. Skill-earned items should appear on their own and can never be bought:
  - the mortar after tempering
  - the bean pot after Marisol
  - Haruka's rice paddle
- **Export** already exists. Make it a visible ownership promise: "your book is yours, printable, exportable, never held hostage".

### 2.5 CD6 & CD7 Scarcity and Unpredictability: seasons and surprise visitors

- **Seasonal produce is natural, honest scarcity.** Wen's region-and-month table already exists. Extend it from the quiz into the loop:
  - "This month at Wen's: squash" becomes a suggested technique (roasting) and a suggested dish.
  - It arrives and leaves with the real season.
  - The *recipe stays in your book forever*. Only the produce is seasonal.
  - The season comes back next year, so nothing is permanently missable.
  - Region-correct, including the southern hemisphere.
- **Surprise cooks.** Introductions and Recipes from Abroad are good, but predictable. Add occasional **travelling cooks** who pass through the Bureau with one drill or one frame. Timing is random, content is curated, and every visitor's lesson is also reachable through normal play.
- **Avoid:**
  - countdowns
  - "only 2 days left"
  - expiring rewards
  - surprise *paid* content
  - push notifications for surprises (they should be found when you open the app, not dragged into your day)

### 2.6 CD8 Loss & Avoidance: without shame

- **Honest loss is real-world loss**: a bunch of coriander wilting in your fridge. The game should never invent in-game loss.
- **Use-it-up as a rescue, not a warning.** `reminder.use_it_up` should open a **rescue mini-quest** that teaches a *preservation technique*. That turns CD8 into CD2 and CD3:
  - soft tomatoes → quick sauce
  - wilting herbs → green sauce
  - stale bread → breadcrumbs
  - ripe bananas → freeze for later
- **Rules for shame-free loss:**
  - Composting counts and is acknowledged without judgment.
  - Nothing in the game decays: no skill decay, no trust decay, no wilting virtual plants.
  - At most one nudge a day, inside quiet hours.
- **Meal reminders** use concern about too little food, as spec §5 intends. Keep them, but see R6 on the hours count and emotional leverage.

---

## 3. Concrete mechanics (14)

Each mechanic lists its drives, white-hat (WH) or black-hat (BH) label, guardrail and milestone. ★ marks the top 5 for the "one more technique" goal.

### ★ M-1. The Technique Toolkit (knife roll)
- **Drives:** CD2, CD4 · **WH, left brain**
- **Milestone:** M5 (data and rewards in `packages/core`), view in M3, technique data in M10
- **Mechanic:**
  - Techniques become first-class data (`data/techniques.yaml`) with `prereqs` and `adjacent` links, shown as a pixel knife roll or pegboard on the kitchen wall.
  - Each technique has three honest tiers:
    - **Seen:** you did the lesson or drill
    - **Tried:** you cooked a dish that uses it
    - **Yours:** you used it in a second, different dish, or a second cuisine
  - "Yours" earns a Bureau Certificate of Technique, with footnotes.
  - Skill XP stays as flavor. The tiers replace it as the measure of progress.
- **Guardrail:**
  - No decay and no time limits.
  - Tiers come from *doing different things*, not doing one thing often.
  - No grand total or percentage meter.
  - The toolkit can never be sold, boosted or skipped.

### ★ M-2. "One More Technique" (the Pan's weekly edge)
- **Drives:** CD2, CD3 · **WH**
- **Milestone:** M5 (plan conversation and `plan_week`)
- **Mechanic:**
  - During weekly planning, the Pan proposes **at most one** dish that adds one adjacent technique, chosen from M-1's `adjacent` graph and filtered by the rules engine: "You can sweat onions. Tempering is one step on. Leela's parippu, Thursday?"
  - Accepting adds the drill to a kitchen day before the cook day.
  - Saying "not this week" is a full, valid answer and has scripted lines.
- **Guardrail:**
  - Opt-in per week.
  - No reward for accepting beyond the normal ones, and no cost for declining.
  - Never stacks: "one more", not "three more".
  - Never proposed in a week the player has said is hard.

### M-3. Same Hands, Different Kitchen (transfer quests)
- **Drives:** CD2, CD1 · **WH**
- **Milestone:** M5 (quest step type), M10 (lines)
- **Mechanic:**
  - Add a `recognize` quest step and cook lines that notice techniques learned elsewhere. Marisol: "You've bloomed spices in oil before. Leela taught you? Good. Here it's chile, same idea."
  - Recognition moves a technique from Tried to Yours.
  - The cultural point stays intact: techniques are shared human knowledge, and dishes are communities' own.
- **Guardrail:**
  - Never frame one cuisine as a "version" of another.
  - Lines reviewed by each cuisine's reviewer (§10).

### ★ M-4. Pantry Frames (improvise from the cupboard)
- **Drives:** CD3, CD2 · **WH, right brain**
- **Milestone:** M5 (pantry → frame suggestion), M10 (frame content)
- **Mechanic:**
  - The player tells the Pan what's in the cupboard. The Pan offers a **frame**, a technique-first template, instead of a recipe: "Rice, an egg, half an onion: that's fried rice. The technique is high heat and cold rice. Want the frame?"
  - Cook mode runs the frame as generic steps with slots, such as `{aromatic}` and `{protein}`.
  - The photo reaction comments on choices.
  - Cooking a frame counts toward the technique's tiers.
- **Guardrail:**
  - Every slot filler is run through `check()`. Unresolved items show ❓ and are never shown as safe.
  - A sparse cupboard is never a joke. Low pantry is a likely sign of food insecurity, so offer cheap frames and never comment on scarcity.
  - No failure state.

### ★ M-5. Margin Notes (your variation, credited properly)
- **Drives:** CD3, CD4 · **WH**
- **Milestone:** M5 (data model: `Variation` on `CookSession` / `Recipe`), M10 (cook reaction lines)
- **Mechanic:**
  - After cook mode, "Did you change anything?" Tell the Pan: "added lime, used chickpeas". It is stored as a structured diff over the canon Cooklang.
  - Your book shows "Leela's parippu · your margin notes".
  - On your next visit, the cook reacts to the change in character.
  - Pays off Haruka's trust-3 "new filling" line: your filling goes "on the board" as a visual in her shop.
- **Guardrail:**
  - Private by default.
  - The canon text is never altered, and the credit line always names the community first.
  - Each variation is re-checked by the rules engine before it can be reused.
  - Not available on `sacred: true` dishes.

### M-6. The Keeper's Offering (variations credited back to the canon)
- **Drives:** CD1, CD3, CD5 · **WH**
- **Milestone:** M10 (contribution pipeline); M5 only reserves the data path
- **Mechanic:**
  - At trust 5 (Keeper), the player may **offer** a margin note to the open canon as a suggested variant.
  - It goes through the §10 review by a reviewer from that cuisine. If accepted, it ships as a CC BY-SA variant credited "variation by <handle>, after <community>".
  - The cook announces it in character.
- **Guardrail:**
  - Explicit consent, with CC BY-SA explained in plain words.
  - No XP or stamps for *submitting*, to prevent spam and farming. Acknowledgment comes only on acceptance.
  - Reviewers can decline with a kind written line.
  - Sacred dishes are excluded.

### M-7. The Recipe Book
- **Drives:** CD4, CD2 · **WH, left brain**
- **Milestone:** M3 (book scene and HTML panel), filled by M5
- **Mechanic:**
  - A pixel book in your kitchen. One page per *taught* dish, holding:
    - the gift line and credit
    - techniques used (linking to M-1)
    - private photos
    - margin notes
    - dates cooked
    - "cooked for" (M-9)
  - Frames and imported recipes have their own sections. Printable.
- **Guardrail:**
  - Copy follows voice §0.3 ("Leela taught you Parippu").
  - No completion percentage across cultures.
  - Export and print are always free and never paywalled.
  - Deleting the account deletes the book, and export comes first.

### M-8. A Kitchen That Remembers
- **Drives:** CD4, CD1 · **WH**
- **Milestone:** M3 (kitchen scene slots), M10 (sprites)
- **Mechanic:**
  - Skill-earned objects appear on their own: the mortar and pestle after tempering, Marisol's olla after frijoles, Haruka's paddle at trust 4, framed Bureau certificates.
  - These are separate from stamp-bought cosmetics.
- **Guardrail:**
  - Earned objects can never be bought or traded. The kitchen displays what you've *learned*, not what you've paid for.
  - No body-related cosmetics. No cosmetic tied to intake.

### M-9. Cooked for Someone (the Shared Table)
- **Drives:** CD5, CD1 · **WH-leaning neutral, right brain**
- **Milestone:** M5 (`cook.done` flow plus one optional field), M10 (lines)
- **Mechanic:**
  - After cooking: "Who ate with you?" Answers can be skipped, or be "just me", "two people" or "my flatmate".
  - The book page records it.
  - Cooks answer with the lines already written: Marisol, "That's how it travels."
  - A gentle "Shared Table" tally of *meals shared*, not people ranked.
- **Guardrail:**
  - Private, with no names required.
  - Never a requirement for trust or progress.
  - Eating alone gets equal warmth ("Feeding yourself counts. It's the first person on the list.").
  - Never compared with anyone.

### M-10. Household Kitchen (opt-in, small, private)
- **Drives:** CD5, CD4 · **neutral**
- **Milestone:** M5 reserves the `Household` entity and a shared `MealPlan` / `MarketRun` / `PantryItem`. The feature ships post-v1, since social is out of scope (§14).
- **Mechanic:**
  - Up to about six people share:
    - the week's plan
    - the market list, so one person shops for all
    - the pantry
    - a **shared toolkit wall**: "Sam can temper; ask Sam"
  - A Keeper can host a **teach-back**: a guided lesson they run for a housemate in person.
- **Guardrail:**
  - **Never** shared: meal logs, nutrition, rules, symptoms, journeys. Allergy *rules* may be shared for planning only with each person's explicit opt-in, and the rules engine checks the shared plan against everyone's rules.
  - Invite-only, leave at any time with your data.
  - No in-household ranking.
  - Minors: the 16+ minimum still applies.

### M-11. Recipe Postcard (teach it on)
- **Drives:** CD5, CD1 · **WH**
- **Milestone:** M10
- **Mechanic:**
  - At "Yours" or Keeper level, print or share a postcard. It carries:
    - the Cooklang recipe and its why-notes
    - the community credit ("from Kochi, from Leela's aunt")
    - an optional handwritten note
  - It is a static file or image, with no tracking link.
- **Guardrail:**
  - Credit is always attached and can't be removed.
  - No user photo by default.
  - **No referral rewards** of any kind, so the game never turns friendship into acquisition.
  - Sacred dishes can't be shared as postcards.

### M-12. The Season's Table (honest scarcity)
- **Drives:** CD6, CD7, CD2 · **light BH, real-world grounded**
- **Milestone:** M6 (seasonality data drives suggestions), M5 (plan hook)
- **Mechanic:**
  - Each month, Wen's real seasonal list surfaces one "what's good now" ingredient. It comes with a suggested technique (for example, squash → roasting) and a dish or frame, shown in the plan conversation and at Wen's stall.
  - The Pan's line ties it to the real world: "It's here till the frost. Then it's next year's problem."
- **Guardrail:**
  - Scarcity mirrors the real world only.
  - No countdown UI.
  - Recipes taught stay forever; only produce is seasonal.
  - Every seasonal dish is reachable in its season every year.
  - Southern hemisphere and other regions are handled correctly.
  - Never monetized.

### M-13. Travelling Cooks (surprise visitors)
- **Drives:** CD7, CD2 · **light BH**
- **Milestone:** M5 (quest engine: random-eligible visitor quests), M10 (content)
- **Mechanic:**
  - Now and then, a traveling cook "stops at the Bureau" with one drill, one frame or one market tip, delivered as a letter in the kitchen.
  - About once every 2–3 weeks, seeded so it's fair.
  - Pairs with M-2: a visitor may bring the week's "one more technique".
- **Guardrail:**
  - Seen only when the player opens the app. No push notifications for surprises.
  - Nothing expires, so a letter waits indefinitely.
  - All visitor lessons are also reachable in normal play.
  - Never paid. No randomized *reward value*, only randomized *timing* of curated content.

### ★ M-14. Use-It-Up Rescue (shame-free loss)
- **Drives:** CD8, CD3, CD2 · **BH used honestly**
- **Milestone:** M5 (pantry item dates from market runs), M9 (Web Push delivery, quiet hours)
- **Mechanic:**
  - `reminder.use_it_up` becomes a rescue mini-quest: a **preservation or rescue technique** plus a quick dish (herbs → green sauce; soft tomatoes → sauce; bread → crumbs; freeze bananas).
  - Rescue technique pages go in the book and count toward M-1.
- **Guardrail:**
  - Only real-world loss, and only for food the player actually bought. Never in-game decay.
  - Composting is acknowledged warmly ("Compost counts. The worms send their thanks.").
  - At most one nudge a day, inside quiet hours, and it can be turned off.
  - Never tied to money.

> Swap M-14 and M-9 if CD5 is the priority. M-9 is the cheapest way to lift the weakest right-brain drive.

**Projected scores** if M-1 to M-9, M-12 and M-14 ship:

| Drive | Now | Projected |
|---|---|---|
| CD1 | 6 | 7 |
| CD2 | 6 | 8 |
| CD3 | 3 | 7 |
| CD4 | 5 | 8 |
| CD5 | 3 | 5 (7 with M-10) |
| CD6 | 2 | 3 |
| CD7 | 4 | 5 |
| CD8 | 2 | 2 |

White Hat Strength rises from **20 to about 30/40**. Black Hat Load stays at about **10/30**.

---

## 4. Monetization × Octalysis

Spec §1.2 says no monetization in v1, and §15 Q3 leaves the direction open. The recommendation below keeps the architecture compatible with an **optional supporter subscription plus institutional licenses** (schools, community kitchens, clinics), with a free core that is complete on its own.

### 4.1 Drives a paid tier MAY ethically use

| Drive | Ethical paid use | Why it's OK |
|---|---|---|
| **CD1 Epic Meaning** | "Bureau Patron" supporter tier that transparently funds paying cuisine contributors and reviewers (§10–11) and a pay-what-you-can or hardship tier for others. A yearly public note on where the money went. | Meaning comes from a real, verifiable cause. The value is not made up. |
| **CD4 Ownership** | Cosmetics: pan hats, aprons, kitchen decor, Bureau stationery themes. A printed hardcover of *your* recipe book. Extra palettes. | Purely expressive and non-random. Never earned items (M-8), never the book's contents. |
| **CD3 Creativity** | Capacity that costs money to run: more AI imports a month, more voice minutes, more photo reactions, above a generous free baseline. | The price follows real AI and GPU cost (§7, §7.7). Core play never depends on AI (§7.5), so free play is complete. |
| **CD2 Development** (with care) | **New content packs as whole, known bundles**: a new country with its cooks and dishes, contributors paid, contents listed up front. Pricing like a book. | Adds *more to learn*. Never speeds up or skips learning. |
| **CD5 Social** | A household plan (M-10) priced per household. Institutional licenses: a class or community-kitchen dashboard showing *skills taught*, never members' intake. | Pays for a coordination service. No pay-to-be-seen. |

### 4.2 Drives and surfaces OFF-LIMITS for monetization

| Off-limits | Includes |
|---|---|
| **CD6 Scarcity and CD8 Loss on safety** | Allergy and diet rules, `check()`, ❓ surfacing, label and cross-contact notes, severe-rule confirmations, emergency lines, medical deflections. Never metered, never rate-limited behind pay, never "premium safety". |
| **CD6 and CD8 on core nutrition and eating well** | Meal logging, the "enough" ranges, meal reminders, low-intake check-ins, the weekly balance view, use-it-up nudges, the Pan's five basics, budget-friendly frames. Never paywalled, never limited, never a "trial that ends". |
| **CD6 and CD8 on what you've earned or own** | A lapsed subscription never removes the book, toolkit, margin notes, photos, trust or certificates. Export and delete are always free. |
| **CD2 pay-to-skip** | No buying XP, skill tiers, trust, stamps, introductions, or skipping drills, quests or lessons. Learning is the product, so skipping it is a refund in disguise. |
| **CD7 randomized monetization** | No loot boxes, gacha, mystery bundles or random cosmetics drops, *even cosmetic-only*. No paid travelling cooks. |
| **CD6 urgency on sales** | No countdown offers, limited-time cosmetics, "only today" bundles, or expiring purchases. A seasonal cosmetic, if any, returns every year. |
| **CD5 relatedness as a sales channel** | The Pan and the cooks never sell. No upsell lines in any NPC line bank, and no "the Pan is sad you didn't subscribe". The store is a separate, plain menu. No referral bonuses. |
| **Health data as revenue** | Already in §9: no selling or sharing data, no ad trackers. Restate it as a monetization rule. |

### 4.3 "Never" rules to add to the spec

Add as **§2.8, Monetization never-list**, or as a new §6.1:

1. **Never charge for safety.** Allergy and diet rules, checks, warnings, ❓ and emergency lines are free, unmetered and identical for every player.
2. **Never paywall eating enough.** Logging, "enough" targets, reminders, low-intake check-ins, use-it-up nudges and the basics stay free.
3. **Never sell progress or let anyone pay to skip learning.** No paid XP, skills, trust, stamps, introductions or skipped lessons.
4. **No loot boxes or randomized paid items.** Every purchase shows exactly what you get.
5. **No paid urgency.** No countdowns, limited-time offers or expiring purchases. Scarcity in the game mirrors real seasons only, and nothing is permanently missable.
6. **Never take back what was earned.** No XP or level loss, ever, including on undo. A lapsed plan never removes the book, toolkit, photos or export.
7. **Mentors don't sell.** No upsell in the Pan's or any cook's dialogue, and the store stays out of the conversation.
8. **No rewards for restriction, for notification compliance, or for streaks.**
9. **No social leverage for revenue.** No referral rewards, leaderboards, or public comparison of skill or intake.
10. **Community recipes stay free to cook.** Contributors are paid and credited. The CC BY-SA canon is never paywalled.

---

## 5. Dark-pattern red flags in the current design

Severity: **H** fix before any playtest · **M** fix in its milestone · **L** watch.

| # | Sev | Where | Issue | Drive misuse | Fix |
|---|---|---|---|---|---|
| R1 | **H** | `prototype/kitchen.html:481, 519, 544` | **Undo costs XP and can lower your level.** `addXP(-xp, "undone")` shows a "−20 XP · undone" toast, and `while (S.xp < 0 && S.level > 1) S.level--` drops the level. Undoing a *mis-filed allergy rule* or a *wrong meal log* is penalized. This puts loss aversion on correcting safety data, the opposite of §7.0 "wait, undo that". | CD8 against safety | Grant write-rewards only after the undo window closes, or reverse silently with no toast. Never let a level go down. Add a test: undo never shows a negative reward. |
| R2 | **H** | `kitchen.html:543`, `kitchen.html:420/491`, `quest.html` Form 27-B | **Rewards for filing allergy rules.** Stamping Form 27-B gives +20 XP and +1 stamp. Onboarding "Form 1-A complete" (+3 stamps) **requires "A rule stamped"**, so players with no allergies are nudged to invent one. That pollutes the safety data and teaches fast confirming. "Stamp it ✔" also gets autofocus (`$("#rb-ok").focus()`), which invites a reflex tap. | CD2 and CD4 on safety | No XP or stamps for creating, editing or deleting rules. Form 1-A counts "No allergies on file" (`intake.allergies.none`) as complete. Put initial focus on the read-back text, not the confirm button. Add to §2 as a principle: *safety actions are never rewarded*. |
| R3 | **M** | `kitchen.html:517` | **"Fed after a nudge" +10 XP bonus.** Eating after a reminder earns more than eating on time, so waiting for the 6-hour nudge pays. This rewards notification compliance and is a multiplier, against §6 "never multiplied". | CD2 / CD8 drift | Remove it. Nourishment XP is flat and does not depend on reminders. |
| R4 | **M** | `kitchen.html:516` (15 XP per log, uncapped) | **Unbounded per-meal XP.** Each log earns XP with no daily cap, so more logged eating events means more XP. That is neither "small and steady" (§6) nor neutral for players with disordered eating, and it invites fake logs. | CD2 on intake behavior | Daily nourishment is a capped, flat amount, for example from the first log at reasonable intervals. Extra logs earn nothing more. Hitting "enough" is acknowledged by the Pan, not scored. |
| R5 | **M** | Spec §3.5: minigames "also gate the weekly market run" | If built literally, a quiz stands between the player and their real shopping list, which is friction on eating. The prototype rightly lets you "Fetch my list" without playing. | CD6 gating a real-life necessity | Reword: "minigames enrich the market run and are never required to see or check off the list." |
| R6 | **L** | `pan.yaml` `reminder.hours_since_meal.*` (`ai: allowed`) | Hour counts and escalating emotional leverage ("I'm properly worried now", "I'd feel better") are kind, but for some players counting hours is a trigger, and the mentor's feelings become guilt. | CD5 / CD8 | Add a setting for hours-since nudges (off or meal-window-only) and respect quiet hours. Make `h9` `ai: never`. Keep the Pan's worry about the *player*, not the Pan's own feelings. |
| R7 | **L** | `market.html:887` | Replayed quizzes earn unbounded XP, so the apprentice level can be ground without cooking. | CD2 grind | Diminishing practice XP, or count practice toward Seen tiers only. Level should mainly reflect cooking. |
| R8 | **L** | Spec §6 "Skill levels gate harder dishes"; trust gates | Hard gates can block an experienced cook, or a player's own heritage dish, behind grinding. These gates will be the first thing anyone proposes to sell. | CD6 | Gates are advisory: "Haruka suggests the drill first". "Cook it anyway" is always available for canon dishes. Never sell a gate (rule 3). |
| R9 | **L** | `haruka.yaml` trust 3, "on the board for one day only" | In-fiction and charming, but it sets a precedent for expiring player content. | CD6 | When M-5 implements it, the board entry fades from the shop but stays in your book forever. |
| R10 | **L** | Spec §6 and UI copy using "unlocks" | Voice guide §0.3 bans "unlocked". The spec and the prototype (`quest.html` "Awaiting an introduction" is fine) mostly comply, but §6 says "Unlocks dishes". | Framing (collector mindset) | Use "opens" or "the cook teaches you" everywhere player-facing. |

**Not flagged (good practice to keep):**
- no streaks
- "No penalty. I'm a pan, not a tax office."
- +2 XP "Curiosity" for wrong market answers
- calories hidden by default
- `log.low_intake_checkin` is `ai: never`, with no numbers
- photo reactions are never verification
- no leaderboards, so nothing to fake
- the `sacred` flag removes dishes from the XP loop
- `greet.return_after_gap` never mentions absence

---

## 6. Recommended next steps

1. Fix **R1 and R2** in the prototypes before Liz's playtest, and add "safety actions are never rewarded" plus the §4.3 never-list to the spec.
2. In the **M5 plan**, add the `Technique` data and tiers (M-1), the Pan's weekly edge (M-2), margin notes (M-5), "cooked for" (M-9) and pantry dates (M-14). Reserve `Household` (M-10).
3. In the **M3 plan**, add the recipe book scene (M-7) and earned-object slots in the kitchen (M-8).
4. In the **M10 content plan**, add `data/techniques.yaml`, pantry frames, cross-cook recognition lines (M-3), cook reactions to variations, and travelling-cook letters.
5. Re-audit after M5 lands, scoring from built code.
