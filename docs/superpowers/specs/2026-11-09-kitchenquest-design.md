# Kitchen Quest — Design Spec

**Date:** 2026-11-09
**Status:** Draft for review
**Owner:** Liz Howard (Multiverse Games)

## 1. Summary

Kitchen Quest is an installable web app (PWA): an 8-bit fantasy RPG set on the real Earth that teaches people to actually cook, and helps them feed themselves regularly, enough, and in balance. Players are apprenticed to cooks around the world, learn real recipes in the app, shop for them on their real market day, cook them in their real kitchen, and photograph the result for an in-character AI reaction. A food tracker, an allergy/diet engine that handles arbitrary restrictions, AI recipe ingestion, and NPCs who answer cooking questions sit underneath the game.

Comedy register: Douglas Adams and Terry Pratchett. Absurd bureaucracy, footnotes, dry kindness. The tone is original, not a Discworld or Hitchhiker's pastiche.

### 1.1 Decisions made in brainstorming

| Topic | Decision |
|---|---|
| Audience | Public Multiverse Games product |
| Pillars | Game and tracker both ship in v1. The v1 tracker is meal logging plus recipe-derived nutrition; deep body-health tracking comes later |
| Platform | Installable web app (PWA). Phaser for the world, HTML panels for forms |
| AI provider | OpenRouter only |
| AI model | `qwen/qwen3.8-27b` for every task. It is vision-capable, so it handles photos and screenshots too. Set in config |
| World | Real countries; everything else is fantasy |
| Cultural stance | Respectful and decolonial: the player is a guest and apprentice, never an explorer or collector |
| Core loop | Weekly rhythm: kitchen days (learn), market day (shop), cook days (cook + photo) |
| Primary interface | Talk to your mentor by live voice or text. The mentor does all data entry. Forms exist only for editing and accessibility |
| Data entry | Anything that isn't conversation is a game: the gamified market and the recipe quest |
| Mentor | The Pan, a talking 140-year-old cast-iron pan (working default; pending confirmation) |
| Live voice | Self-hosted open-source speech-to-text and text-to-speech around Qwen via OpenRouter (working default; pending confirmation, §7.7) |
| Recipe format | Cooklang |
| Open source | The canonical recipe library is open (CC BY-SA 4.0). User imports stay private |

### 1.2 Assumptions (not confirmed; change freely)

- "Reclaim City" is read here as a habit-RPG loop (Habitica-like): real-life actions earn in-game progress. Revise §6 if it means something else.
- Monetization: a free tier plus a choose-your-price "Pantry Guild" membership, School courses, and community seat licences (§16). Paid plans are 18+.
- Launch content is 3 countries × 3 cooks = 9 dishes. Country choice depends on recruiting contributors from those cuisines (§11).
- Minimum age 16, because the app processes health data.

## 2. Principles

1. **The AI suggests, deterministic code decides.** Anything safety-relevant (allergens, diet rules, nutrition) is computed by plain, tested code over confirmed data. LLM output is a proposal a person or the rules engine checks.
2. **"Can't verify" is never "safe."** Unknown ingredients, store-bought products, and fuzzy quantities are surfaced, not silently passed.
3. **Reward eating enough, never restriction.** No XP for eating less. No shame streaks. Missed days cost nothing.
4. **Guest, not conqueror.** Recipes are taught and gifted, credited to communities, and reviewed by people from those cuisines before they are canon.
5. **Comedy punches at the fantasy and the player, never at cultures.**
6. **Health data is minimal, encrypted, exportable, and deletable.**
7. **Talk, don't type.** If a player has to enter data, they either say it to the mentor or play a game that captures it. A plain form is a fallback, never the main path.

## 3. World and game loop

### 3.1 Setting

Real Earth, but kitchens have small gods, markets have weather, and knives have opinions.

- **The Pantry Bureau.** A fantastically over-bureaucratic guild that licenses apprentice cooks. It issues forms in triplicate, stamps, and footnotes. The Adams register lives here.
- **The Pan, your mentor.** A talking cast-iron pan, seasoned for 140 years, licensed by the Bureau as a mentor (somewhat against its will). It is your guide, critic, and meal reminder ("It has been six hours. I am a pan, and even I am concerned."), and the one you talk to for everything (§7.0). The Pratchett register lives here.
- **Cooks.** One NPC per kitchen (a restaurant, street stall, or home kitchen). They are competent, dignified experts from their cuisine and are never the butt of the joke.

### 3.2 Weekly loop

**Setup (onboarding).** Onboarding is a conversation with the Pan, framed as the Bureau's apprentice intake interview (spoken, never a form). The Pan asks for:
- the player's real market day(s) and roughly how many meals a week they'll cook
- their country/region, which drives seasonal produce
- allergies and diet rules, each read back for confirmation (§4.4, §7.0)

That's enough to start. Everything else can wait.

**Kitchen days (daily, 5–10 minutes).** In the 8-bit kitchen, the player does any of:
- **Lesson:** learn an upcoming recipe step by step, including *why* each step exists.
- **Drill:** a short technique lesson (dicing, heat control, "until fragrant," salting pasta water).
- **Plan:** choose taught dishes for the week, by talking it through with the Pan ("something quick Tuesday, something cozy Sunday"). The plan shows weekly nutrition balance, and the Pan flags gaps ("Nothing green since Tuesday.").
- **Log:** tell the Pan what they ate (§5), and answer a symptom check-in if a diet journey is active.
- **Pantry:** tell the Pan what's in the cupboard ("I've got rice, half an onion, and regret").

**Market day.** See §3.5 for the gamified market.
- The week's plan becomes the market quest list, grouped by stall and pre-filtered against the pantry.
- In the real store, the player tells the Pan what they picked up ("got the chicken thighs, no fennel"), which fetches it in the market scene. Tapping also works.
- Out of something? The stall NPC offers a labeled substitute, re-checked by the rules engine.
- Completing the run earns market XP.

**Cook days.**
1. Open a planned dish in **cook mode**: big text, one step at a time, built-in timers from Cooklang `~{}` timers, and the screen kept awake.
2. Finish by taking a photo with the in-app camera.
3. The cook reacts in character: specific, kind, funny feedback about what is visible (§7.2). This is a reaction, not verification.
4. Rewards are granted (§6), and the meal is logged with recipe-derived nutrition.

**Gentle failure.**
- Bought ingredients but didn't cook? The Pan suggests a use-it-up recipe before they spoil.
- Nothing is lost when a day is missed.

### 3.3 The recipe quest (travel and progression)

The world map is a quest board. Recipes are earned through quests, given as gifts and never taken as loot.

- **Quest shape.** A cook sends word through the Bureau. The player travels there and helps with a small problem in that kitchen, such as:
  - an ingredient riddle
  - fixing a technique mistake ("the rice is gluey; why?")
  - a market errand for the cook
  - learning the dish's story

  Then the cook teaches the dish.
- **Trust.** Trust with a cook unlocks their next dish.
- **Introductions.** At high trust, the cook introduces the player to a friend in another country, which opens that country on the map.
- **Imports as quests.** Imported recipes (§7.1) appear as **Recipes from Abroad**: "A traveler left a note at the Bureau…". A guest cook in the recipe's country of origin hosts a short quest, visible only to the importing player.
- **Quest content.** Quests are data files (§8) so contributors can write them. The quest engine supports a small set of step types: talk, travel, riddle, drill, market errand, and cook.

### 3.4 Presentation

- 8-bit pixel art via the existing PixelLab pipeline (`pixellab-sprites` and `visual-design` skills).
- Scenes:
  - World map
  - Country/town
  - Kitchen (home base)
  - Cook's kitchen
  - Market
  - Cook mode (HTML-heavy)
  - Presentation (photo + reaction)
- Phaser renders the scenes. HTML overlays handle forms, long text, and accessibility (screen readers, large text). Cook mode and logging must work fully without the canvas.
- **Mentor panel.** A persistent mentor button on every scene opens the conversation: hold-to-talk, hands-free toggle, or a text box. The Pan's replies show as speech bubbles and are also spoken.

### 3.5 The gamified market (a real shopping-skills trainer)

The market is where players learn to *choose* food. Each stall is an NPC with a short minigame that teaches a real skill. The minigames run in practice mode any day. They are optional on market day: they earn XP but never gate the shopping list (Octalysis audit: no forced play between the player and their groceries).

| Stall | Real skill taught | Minigame |
|---|---|---|
| **Produce** | What's in season in your region this month; picking ripe produce (press, sniff, weigh, color) | "Seasonal or smuggled?" sorting; a ripeness check-off (choose the ripe avocado from four, with tactile hints in text and pictures) |
| **Butcher** | Which cut for which method (braise vs. sear vs. roast); marbling; reading labels; cost per serving | The butcher's quiz: match a dish to a cut, pick the best-value cut for a braise, decode a label |
| **Fishmonger** | Freshness signs (eyes, gills, smell); sustainable choices | "Fresh or fibbing?" spot-the-signs |
| **Tofu & legumes** | Silken vs. firm vs. pressed; dried vs. canned beans; soaking | Match the tofu to the dish |
| **Spice merchant** | Whole vs. ground; freshness; substitutions | Blind-sniff riddles, with substitution recall |
| **Dairy & eggs** | Egg sizes and dates; cheese types for melting vs. crumbling | Quick sort |

- **Data.** Seasonality is a curated table by region and month. Cut guides, freshness signs, and substitutions are curated data files, reviewed like recipes.
- **Diet-aware.** Stalls respect the rules engine. A vegetarian player's butcher stall becomes a "protein counter" with legumes, tofu, tempeh, seitan, and eggs/dairy where allowed. Blocked items never appear as correct answers.
- **Rewards.** Correct choices earn market skill XP and Bureau Stamps. Wrong answers get a funny explanation from the stall NPC, never a penalty.

## 4. Recipes, Cooklang, and the allergy/diet engine

### 4.1 Recipe files

Every recipe is a Cooklang `.cook` file with YAML front matter:

```
---
title: Mapo Tofu
country: China
region: Sichuan
credit: Home cooks of Chengdu; contributed by <name>
cook: auntie-chen
difficulty: 2
skills: [knife, heat-control, sauces]
servings: 2
license: CC-BY-SA-4.0
status: reviewed            # draft | reviewed
sacred: false               # true keeps it out of the XP loop
---
Heat @neutral oil{2%tbsp} in a #wok until shimmering. ~{30%seconds}
```

- **Parser:** `@cooklang/cooklang`, the official Rust parser compiled to WASM. Wrap it in `packages/core` so it can be swapped.
- **Lesson content:** the "why" notes for lessons live in Cooklang comments, or in a sidecar `.lesson.md` with the same base name, so recipes stay valid Cooklang.

### 4.2 Storage

- **Open canon.** `.cook` files live in `recipes/` with their own `LICENSE` (CC BY-SA 4.0) and `CONTRIBUTING.md`. It can be split into its own public repo later. A sync job indexes the canon into Postgres. Git is the source of truth.
- **Private imports.** Cooklang text is stored per user in Postgres and never published. Promoting an import into the canon requires the original author's permission and a review (§10).

### 4.3 Ingredient identity

- **Alias table.** Free-text names map to canonical ingredient IDs ("scallion," "green onion," "spring onion" → `green_onion`).
- **Graph.** Two relation types:
  - `is_a`, for example cashew → tree_nut → nut
  - `contains`, for example soy_sauce → wheat, worcestershire → anchovy, whey → milk, gelatin → mammal_product
- **Seeds:**
  - hierarchy from FoodOn (CC BY 4.0)
  - nutrition from USDA FoodData Central (public domain)
  - curated `contains` edges for common compound ingredients
- **Unresolved names** are queued for curation and treated as ❓ until they are resolved.

### 4.4 Rules engine (arbitrary allergies and diets)

A rule is a small data record:

```ts
type Rule = {
  id: string;
  target: { kind: 'ingredient' | 'category' | 'component'; ids: string[] };
  type: 'avoid' | 'limit' | 'prefer';
  severity: 'anaphylactic' | 'allergy' | 'intolerance' | 'preference';
  limit?: { amount: number; unit: string; per: 'serving' | 'day' };
  phase?: { start: string; end?: string; journeyId?: string };
  note?: string; // the user's own words
};
```

**Creating a rule:**
1. The user types anything ("tree nuts," "alpha-gal," "carrageenan," "nightshades," "my grandma's definition of squash").
2. Known targets resolve directly through the graph.
3. Unknown targets go to the AI, which proposes the ingredient IDs and hidden sources it believes the term covers, with an explanation.
4. The user confirms or edits the proposal. Only the confirmed ID list is stored. The AI is never consulted at check time.

**Checking a recipe:** `check(recipe, rules, date) → { status, findings[] }`, a pure function in `packages/core`.

| Status | Meaning |
|---|---|
| ✅ ok | No rule matched; every ingredient resolved |
| 🔁 swap | A rule matched and a substitution exists that passes all rules |
| ⛔ blocked | A rule matched and no passing substitution exists |
| ❓ unverified | One or more ingredients are unresolved or store-bought compounds |

- **Findings** name the ingredient, the rule, and the path through the graph (e.g. "Worcestershire → contains anchovy → fish").
- **Severe rules** (anaphylactic or allergy) always show cross-contact and "check the label" notes, plus a persistent disclaimer: *Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.*
- **Substitutions** come from a curated table first, then AI suggestions. Every substitution is re-checked by `check` before it is shown, and is labeled in the recipe ("swapped: tamari for soy sauce").
- **Display:** blocked dishes stay visible on the map, marked "this cook will teach you an adapted version" when an adaptation exists. The game never shows a dish as cookable when it is blocked.

### 4.5 Diet journeys

A journey is a named sequence of time-boxed rule sets plus check-ins. Low-FODMAP is the first one:

| Phase | What happens |
|---|---|
| Elimination | A rule set restricts high-FODMAP foods |
| Reintroduction | A series of in-game **Trials**: one FODMAP group per trial, a scheduled test dish, then symptom check-ins over the following days |
| Personalization | Rules are rewritten from the trial results the user confirms |

- **Symptom check-in:** a 0–3 scale for a few user-chosen symptoms plus a free-text note, taking about 10 seconds. It is optional outside journeys.
- **Positioning:** journeys are framed as tools to use with a clinician, not medical advice. Users can define custom journeys (name, phases, rules).

### 4.6 Nutrition

- Per-serving nutrition is computed from ingredient quantities using USDA data, with unit conversion and a density table for volume↔mass.
- Each value carries a confidence. Fuzzy quantities ("a handful," "to taste") use defaults, and the value is marked as an estimate.
- Tracked in v1: energy, protein, fat, carbohydrate, fiber, sugars, sodium, plus fruit/vegetable servings and food-group variety.

## 5. Tracker (v1)

**Logging a meal.** The default is to tell the Pan, by voice or text.
- **Game dish:** "I made the mapo tofu, ate half." Nutrition comes from the recipe × servings eaten.
- **Free-form:** "two slices of toast with peanut butter," or a photo. The AI estimates components and the Pan reads back a short summary; the user confirms or corrects in conversation. Everything is marked as an estimate.
- **Repeat:** "same as yesterday's breakfast."
- **Fallback:** one-tap logging in the UI for game dishes, for when talking isn't convenient.

**Targets are "enough" ranges, not limits:**
- Protein, fiber, and fruit/veg servings: aim to reach at least the range.
- Energy: shown as a range around maintenance. Calories are hidden by default and can be turned on in settings.
- Sodium: an upper bound, as general guidance.

**Reminders:**
- Web Push, at meal windows the user chooses.
- iOS requires the app to be added to the home screen; onboarding explains this.
- Reminders are written by the Pan.

**Weekly view.** Balance across the week, the variety garden (food groups), and journey trends.

**Safeguards against disordered eating:**
- No rewards for low intake.
- No weight-loss gamification in v1.
- Body metrics (weight etc.) are deferred and opt-in when they arrive.
- If logged intake stays very low for several days, the Pan gently checks in and links to support resources. It never scolds.

## 6. Progression and rewards

| Reward | Earned by |
|---|---|
| **XP / apprentice level** | Lessons, market runs, cooking dishes, logging meals |
| **Skill XP** | Each dish's `skills` (knife, heat control, sauces, baking, fermentation, grains, …). Skill levels gate harder dishes |
| **Trust (per cook)** | Cooking their dishes and returning to them. Unlocks dishes and introductions |
| **Bureau Stamps** | Soft currency for kitchen cosmetics (pan hats, aprons, kitchen decor). No paid currency in v1 |
| **Daily nourishment** | Logging meals at reasonable intervals and hitting "enough" ranges. Small, steady and capped per day; never multiplied by streaks, never a bonus for responding to a reminder |
| **Technique Toolkit** | Each technique moves Seen (lesson) → Tried (cooked once) → Yours (used in a second dish or cuisine). Never decays. This is the main progression, and the Pan offers at most one new technique a week ("One More Technique"); saying no costs nothing |

**Nothing earned is taken back.** Undoing a meal log or an allergy rule removes the record, never XP, level, stamps or trust. Filing an allergy or diet rule earns no XP: safety data is never gamified, and onboarding is complete without one.

**Anti-cheat stance.** Photos aren't verified, and that's fine. The game's value is the cooking, so cheating only cheats yourself. No leaderboards in v1, so there's no incentive to fake.

## 7. AI features

All AI calls go through one `AiProvider` interface in `apps/api` that calls OpenRouter. The model is set by config (`AI_MODEL=qwen/qwen3.8-27b`). Each task has a versioned prompt template and a JSON-schema output, and responses are validated before use.

### 7.0 The mentor agent

The Pan is a tool-using agent and the primary interface to the whole app. The conversation runs on the server: the model gets the Pan's persona, the style guide, a compact player context, and a fixed set of tools.

**Tools** (each is a thin wrapper over the same validated API endpoints the UI uses):

| Tool | Effect | Confirmation |
|---|---|---|
| `log_meal` | Log a game dish or a free-form meal | Pan reads back a summary; saved on yes |
| `log_symptoms` | Journey check-in | Saved on yes |
| `propose_rule` / `save_rule` | Allergy or diet rule (§4.4) | **Always** read back in full; saved only on an explicit yes |
| `set_schedule` | Market days, meal windows, reminder times | Read back; saved on yes |
| `update_pantry` | Add or remove pantry items | Light confirmation |
| `plan_week` / `edit_plan` | Choose dishes for the week | Shown on screen; saved on yes |
| `check_off_item` | Market run check-off | None (undoable) |
| `import_recipe` | Start an ingestion (§7.1) from a pasted link, text, or photo | Review step as in §7.1 |
| `start_lesson` / `start_quest` / `open_scene` | Navigate the game | None |
| `answer_question` | Cooking Q&A, grounded (§7.3) | None |

**Rules for the agent:**
- **The agent never writes the database directly.** Tools call the API, which validates input, and the rules engine still decides safety.
- **Writes need a yes.** Any write affecting health or safety needs a spoken or tapped "yes" after a full read-back. A second short window lets the player say "wait, undo that."
- **On-screen trail.** Every write shows as a small card in the conversation ("📒 Logged: toast with peanut butter, breakfast"), so the player can tap it to edit or undo.
- **Memory.** Short-term conversation history, plus a structured profile summary rebuilt from the database each session. There is no free-form long-term memory of health details outside the encrypted tables.
- **Other cooks.** Other NPCs (the cooks and stall keepers) are the same agent with a different persona and a narrower tool set (answers, lessons, quests; no health writes).

### 7.1 Recipe ingestion

| Input | Path |
|---|---|
| Recipe website URL | Server fetches the page. If it has schema.org `Recipe` JSON-LD (most recipe sites do), it is converted to Cooklang deterministically. Otherwise the AI extracts it |
| Instagram / TikTok | Instagram offers no API for reading other people's posts, and scraping it violates its terms. The user pastes the link plus the caption, or uploads a screenshot, and the AI extracts from that. Recipes that exist only in a video are flagged as partial |
| Pasted text / photo of a cookbook page | AI extraction |
| `.cook` file | Parsed directly |
| Android share sheet | PWA Web Share Target sends shared text or links into the import flow |

**Pipeline:**
1. Extract to structured JSON (title, ingredients with quantities, steps, servings, likely country/region of origin with confidence).
2. Render to Cooklang and validate with the parser.
3. Resolve ingredients (§4.3), then run `check` and compute nutrition.
4. The user reviews and edits the result in a form. Nothing is placed until they confirm.
5. Placement: a guest cook in the country of origin, or "Origin unknown: the Bureau's Lost & Found kitchen."

**Credit.** The source URL and author are always stored and shown on the card.

**Untrusted input.** Imported content is treated as data. The model returns schema-constrained output only, and imported text can never create or alter rules, prompts, or other users' data.

### 7.2 Photo reaction

- **Input:** the photo, the recipe, and the cook's persona.
- **Output:** a short in-character reaction (two to four sentences) that names something specific and visible, plus one practical tip.
- **Never:** body comments, health claims, or cruelty. The voice is the cook's, so dry and warm.

### 7.3 NPC cooking Q&A

- Each cook and the Pan has a persona card: voice, expertise, cuisine, and catchphrases.
- **Grounding:** the current recipe, the player's confirmed rules, and their skill levels.
- **Ingredient suggestions** in answers are run through `check` before display. Anything that fails is replaced with a note.
- **Medical questions** get a polite deflection to a clinician.
- **Rate limits:** a per-user daily message limit to control cost.

### 7.4 Rule expansion

See §4.4. The AI proposes and the user confirms.

### 7.5 Failure behavior

If OpenRouter is down or returns invalid output, the game says so in character ("The cook has stepped out; your plate is on the pass and they'll get to it."), queues the request, and retries. Core play never depends on AI: lessons, market minigames, cook mode, one-tap logging, and rule checks all keep working. If the mentor is unavailable, the UI fallback forms appear.

### 7.6 Voice-specific safety

- Speech-to-text output is treated as untrusted user text.
- For rules, the Pan spells out and shows on screen the ingredient it heard ("kiwi, K-I-W-I"), because mishearing an allergen is the worst failure mode.
- Severe rules always need a tap on the on-screen card in addition to the spoken yes.

### 7.6b Mentor safety architecture (from the Qwen spike)

Source: `docs/spikes/2026-11-09-qwen-as-pan.md`. Verdict: `qwen/qwen3.8-27b` is a **go with these mitigations**. They are binding requirements for the mentor milestone.

1. **The server guards every health write.** `save_rule` is rejected unless a proposal card was shown, and the yes arrived through the UI: a tap for severe rules, or a tap or a confirmed spoken yes for others. The model's own claim of confirmation is never enough.
2. **Read-backs and allergen spelling come from code, not the model**, using written lines from `content/dialogue/pan.yaml`. In the spike the model failed to spell severe allergens 24% of the time.
3. **The on-screen card is the record.** The reply is checked against the tools actually called. If the reply claims a write that didn't happen, the claim is replaced.
4. **Page events travel on a separate channel.** Card taps and system events never arrive as user text, and lookalike strings (e.g. "[Player tapped …]") are stripped from user input. This blocks the injection seen in the spike.
5. **Output filter before display or speech:** no "this is safe to eat" claims, banned words from `docs/style/voice.md`, a 3-sentence limit, and no empty replies. Recipe and safety statements come only from `check` results that are in context, never from the model's memory.
6. **Model settings:** temperature 0.3, reasoning off, and a pinned allow-list of fast, cheap, no-retention providers (also required by compliance C-14).
7. **Prompting:** few-shot examples for implicit pantry removals ("I finished the milk") and British times ("half twelve" means 12:30).
8. **Latency:** plain replies meet the voice budget, p50 about 0.5 s. Tool turns speak a scripted filler line ("Let me write that in the ledger…") while the tool runs.
9. **Regression suite:** the spike's 40-case suite becomes a permanent eval, run on every prompt or model change, with a zero-tolerance gate on safety categories.
10. **Comedy stays scripted-first.** The model averaged about 1 good line in 10 and leaned on "I'm a pan" in about a third of replies, which confirms §8. The persona prompt bans catchphrase repetition.
11. **Cost:** about $0.0006 per turn at current list prices, roughly $0.02 per free player per month, within the §16 budget.

### 7.7 Live voice

OpenRouter offers no open-source realtime voice model, so voice is a pipeline. Working default (pending Liz's confirmation):

```
mic → VAD (in browser) → streaming STT (self-hosted open-source Whisper) → Qwen via OpenRouter (streamed tokens)
    → sentence chunker → TTS (self-hosted open-source voice) → audio out
```

- **Latency target:** under 1.5 s from the end of the player's speech to the first spoken audio. Streaming LLM output and sentence-level TTS make this feasible.
- **Barge-in:** the player can interrupt the Pan. Detected speech stops playback and cancels the in-flight turn.
- **Modes:** hold-to-talk by default; a hands-free mode with voice activity detection for cook mode (hands are messy).
- **Voices:** each character gets a distinct open-source TTS voice. The Pan's voice is a priority art-direction task.
- **Hosting:** a `voice` service on Hetzner (a GPU box if CPU latency misses the target). Audio is processed in memory and never stored. Transcripts are kept only as the conversation text, under the same retention rules as other conversation data.
- **Text mode** is always available and is the default where voice isn't permitted (no mic, public place).
- **Alternatives considered:** Qwen's realtime omni model on Alibaba Cloud (better latency and natural turn-taking, but breaks the OpenRouter-only rule); browser built-in speech (free, but robotic and inconsistent across browsers; acceptable as a development stand-in only).

## 8. Comedy and writing

- **Style guide** (`docs/style/voice.md`):
  - Bureau voice: formal, footnoted, absurd procedure
  - Pan voice: deadpan, fond, concerned
  - Cooks' voices: competent, specific, warm
  - Hard rules: no jokes about cultures, accents, bodies, or weight
- **Core narrative content is handwritten**: onboarding, cook introductions, dish stories, and Bureau forms.
- **Scripted first.** Quests, cook stories, stall minigames, reminders, read-backs, and common cooking questions (per-cook FAQ banks) are written content in `content/`. The game uses a written line whenever one fits. Each trigger is marked `ai: never` (e.g. allergy read-backs) or `ai: allowed`.
- **AI only where writing can't reach**: free-form questions, photo reactions, and turning what the player says into data entries. Prompts include the style guide plus the character's persona card. If the AI is unavailable, the written lines cover everything except free-form answers.
- **Content as data.** Dialogue and lessons live in data files, not code, so writers and contributors can edit them.

## 9. Architecture

```
KitchenQuest/
  apps/
    game/        # Vite + Phaser + HTML overlays, PWA (manifest, service worker, Web Push, share target)
    api/         # Node + Fastify, TypeScript; AI provider; mentor agent + tools; auth; jobs
    voice/       # streaming STT + TTS service (WebSocket), self-hosted open-source models
  packages/
    core/        # pure TS: Cooklang wrapper, ingredient graph, rules engine, nutrition, rewards
  recipes/       # open canon .cook files + lesson sidecars, CC BY-SA 4.0
  data/          # ingredient graph seeds, substitutions, USDA subset, seasonality, cut guides, personas, dialogue, quests
  docs/
```

- **Database:** Postgres, with Drizzle for schema and migrations.
- **Auth:** email magic link via the existing mailing infrastructure. Passkeys later.
- **Photos:** S3-compatible object storage (Hetzner Object Storage).
  - EXIF and GPS are stripped on upload.
  - Photos are private by default and deleted when the account is deleted.
- **Hosting:** Hetzner, following the existing `deploy` skill conventions. Errors are reported to the existing GlitchTip.
- **Offline:** recipes, cook mode, and logging work offline through the service worker. Logs sync when back online.

**Key entities:**
- User, Profile (market days, meal windows, settings)
- Rule, Journey, JourneyEnrollment, SymptomCheckin
- Recipe (canon ref or private Cooklang), Ingredient, Alias, Edge
- Cook, Country, Unlock, Trust
- MealPlan, PlanItem, MarketRun, PantryItem
- CookSession, Photo, Reaction
- MealLog, NutritionSnapshot
- XpEvent, Wallet

**Data and privacy:**
- Health-related fields (rules, journeys, symptoms, meal logs) are encrypted at the column level.
- Data minimization: no birthday, only an "I'm 16+" confirmation, and no location beyond country.
- One-click export (JSON plus `.cook` files) and one-click delete.
- No selling or sharing of data, and no third-party ad trackers.
- AI requests send only what the task needs, with no user identifiers in prompts.
- Positioned as a cooking game and food log, not a medical device. Terms and privacy policy are drafted before public launch.

## 10. Open recipe canon and contribution

- **Repo.** `recipes/`, under CC BY-SA 4.0, with `CONTRIBUTING.md` covering format, credit, and review.
- **Reviews.** A canon recipe for a cuisine needs at least one reviewer from that cuisine's community before it can be `status: reviewed`.
- **Drafts.** AI-drafted or editor-drafted recipes ship as `draft`. They are playable and labeled as drafts, and they never carry a community credit until reviewed.
- **Contributors.** Credit in-game, on the cook's card. Paying contributors for launch content is recommended (§11).
- **Sacred foods.** Ceremonial or sacred dishes are `sacred: true`: no XP or photo loop, shown only as stories, and only if a contributor from that tradition approves.
- **Imports.** User imports enter the canon only through a separate promotion flow that requires the original author's permission.

## 11. Launch content (v1)

- **Countries:** 3 countries × 3 cooks = 9 dishes, plus the Pan's 5 "basics" lessons (knife grip, rice, eggs, stock, a salad dressing).
- **Recommendation:** choose the countries by where contributors can be recruited and paid. Avoid shipping a cuisine without a reviewer from it.
- **Difficulty:** the first dish in each country is difficulty 1 (one pan, fewer than 10 ingredients, under 40 minutes).

## 12. Testing

- **`packages/core`:** heavy unit tests.
  - Rules engine: golden fixtures for every severity, hidden-ingredient paths, phases, substitutions, and ❓ handling. Property tests: a recipe containing an ingredient under an avoid rule can never be ✅.
  - Nutrition math, Cooklang round-trips, and reward math.
- **API:** integration tests against a real Postgres in Docker.
- **AI:** eval sets for ingestion (pages, captions, screenshots → expected structure), photo reactions (tone checks), and rule expansion (expected coverage). They run on prompt or model changes, never in the unit-test path.
- **Mentor agent:** scripted conversation tests for each tool. Every health or safety write must be preceded by a read-back and a yes; the agent never writes without one; prompt-injection attempts in imported text or speech can't trigger tools.
- **Voice:** latency benchmark (end of speech → first audio, p50/p95) on the target box; an allergen mishearing test set (similar-sounding foods) to verify spell-back.
- **Game:** Playwright flows for onboarding, the weekly loop, cook mode, and import review, using the existing `game-playtesting` skill. Accessibility check on all HTML panels.
- **Recipes:** CI validates every canon `.cook` file (parses, resolves all ingredients, has credit and license).

## 13. Build order (each milestone gets its own plan)

1. **Core:** monorepo layout, `packages/core` with the Cooklang wrapper, ingredient graph, rules engine, and nutrition, with tests. No UI.
2. **API and data:** Fastify, Postgres schema, auth, recipe sync from `recipes/`, profile and rules endpoints.
3. **Mentor (text):** the AI provider, the Pan agent with tools and confirmations, and the mentor panel. Onboarding is an interview in text. This comes early because it is the main interface.
4. **Game shell:** PWA, map, kitchen, cook mode. Uses placeholder art.
5. **Weekly loop and quests:** plan → market run → cook → log, the quest engine, rewards, and trust.
6. **Gamified market:** stall minigames, seasonality and cut-guide data.
7. **Live voice:** the voice service (STT/TTS), VAD, barge-in, and hands-free cook mode.
8. **AI features:** photo reaction, ingestion, NPC Q&A, rule expansion, and evals.
9. **Tracker:** targets, reminders (Web Push), weekly view, low-FODMAP journey.
10. **Content and art:** 9 dishes and their quests, personas, voices, dialogue, PixelLab sprites, style guide.
11. **Neighborhood Pantry:** mutual-aid sharing of surplus food (§18).
12. **Launch hardening:** privacy and export/delete, terms, offline, performance, and a playtest batch.

## 14. Out of scope for v1

- Native app-store apps (a Capacitor wrapper later)
- Body metrics and weight tracking
- Social features, leaderboards, and sharing photos publicly
- Paid currency (never; see §16)
- Barcode scanning
- Wearables and health-platform integrations
- Multiplayer cooking

## 15. Open questions

1. What does "Reclaim City" mean to you, and which part of it should the reward loop copy?
2. Which 3 launch countries, and who are the contributors and reviewers?
3. Monetization: decided in §16 (Guild price points still to test: $3 / $6 / $12, with $8 tested as the middle).
4. Age: accounts 16+, paid plans 18+ (decided). Younger cooks take part through family mode (§19).
5. Live voice: self-hosted STT/TTS around Qwen via OpenRouter (the default, §7.7), Qwen realtime on Alibaba Cloud, or browser speech?
6. Is the Pan the mentor, or someone else?

## 16. Monetization and ethics

Sources: `docs/business/2026-11-09-value-chain-monetization.md` (value chain analysis) and `docs/business/2026-11-09-octalysis-audit.md` (Octalysis audit).

**Model.**
- **Free tier:** everything in "free forever" below, with a capped daily allowance of mentor AI and voice.
- **Pantry Guild:** a membership with the same features for every member, priced by the member's choice: $3, $6 or $12 a month ($24/$48/$96 a year), with $8 tested as the middle point. It adds a generous AI and voice allowance, cosmetic kitchen items, and supporter credit. A household plan is $10 a month. A free **Bursary** seat goes to anyone who asks, with no proof required.
- **Contributor share:** 15% of net Guild revenue goes to the contributors and reviewers of each cuisine, tracked per recipe contribution.
- **The Multiverse School:** cooking courses on a sliding scale ($99–249), and community-organization seat licences (about $2–3 per seat per month).
- **Founding offer:** $36 for the first year, capped at 500 members.
- **Never:** ads, affiliate links, brand sponsorships, paid currency, or data deals with insurers or employers.

**Free forever** (must work for a player who has paid nothing, and a test pins it):
- allergy and diet checks, including AI help creating rules
- the open recipe canon and cook mode
- meal logging and gut-health diet journeys
- export and delete
- at least one free path to learn every technique
- unlimited voice for players who need it for accessibility

**Never rules** (Octalysis, binding on every milestone):
1. Never charge for safety.
2. Never paywall eating enough.
3. Never sell progress or a way to skip learning.
4. No loot boxes or random paid items.
5. No paid urgency; scarcity only mirrors real seasons.
6. Never take back anything earned.
7. Mentors and cooks never sell; the Pan never mentions the Guild unprompted.
8. No rewards for eating less, for responding to reminders, or for streaks.
9. No referral schemes or leaderboards.
10. Community recipes stay free to cook, and their contributors are paid and credited.

**System requirements that follow from this:**
- An `entitlements` table, not a tier column.
- A `usage_events` table that records AI and voice usage and cost per call, without storing content. It is used for allowances and unit economics.
- Machine-readable contributor ids in recipe front matter.
- **Licenses (decided 2026-11-09):** `content/` (quests, dialogue, Bureau forms, voice guide) is CC BY-SA 4.0, like the recipes. Art and audio stay proprietary to Multiverse Games, so cosmetics can be sold.
- **Paid plans are 18+ (decided 2026-11-09).** The app remains 16+ for accounts. Family mode (§19, pending analysis) is how younger cooks take part.

## 17. Progression mechanics (adopted from the Octalysis audit)

The mechanics below are adopted. Full designs with guardrails are in `docs/business/2026-11-09-octalysis-audit.md` §3. Each one ships in the milestone named.

| Mechanic | What it is | Milestone |
|---|---|---|
| **Technique Toolkit** (knife roll) | Every technique has a tier: Seen (lesson) → Tried (cooked once) → Yours (used in a second dish or cuisine). Tiers are earned for good. | M5 (data model in M4) |
| **Freshness** (fading skills) | Separately from the tier, each technique has a freshness: Sharp → Warm → Rusty. It fades with time since you last used it, as real muscle memory does. Using it again restores it, and refreshing a rusty technique earns XP. | M5 |
| **One More Technique** | Each week the Pan offers at most one new technique related to what you already cook. Saying no costs nothing. | M5 |
| **Same Hands, Different Kitchen** | Transfer quests use a technique you know in another cuisine. | M5 / M10 |
| **Pantry Frames** | Technique-first templates for improvising from what's in the cupboard. Every ingredient goes through the rules engine. | M5 / M10 |
| **Margin Notes** | Your own variations on a recipe, kept private and attached to the recipe card. | M5 |
| **The Keeper's Offering** | At the top trust level with a cook, you may offer one Margin Note to the open canon. It's credited to you and reviewed like any contribution. | M10 |
| **The Recipe Book** | Your book of everything learned, with your notes and photos. Exportable. | M5 |
| **A Kitchen That Remembers** | Your kitchen scene shows your history: cookware you've used, souvenirs from cooks. | M3 / M10 |
| **Cooked for Someone** (Shared Table) | A private record of who you fed. No ranking. | M5 |
| **Household Kitchen** | Opt-in, small and private: shared plan and pantry for one household. | M9 |
| **Recipe Postcard** | Send a recipe card to a friend outside the app, with credit to the cook. | M10 |
| **The Season's Table** | Honest scarcity: produce and dishes follow real local seasons. | M6 |
| **Travelling Cooks** | Surprise visiting cooks that bring a short quest. | M10 |
| **Use-It-Up Rescue** | Shame-free rescue recipes for ingredients about to spoil. It leads into the Neighborhood Pantry (§18). | M5 / M11 |

**Freshness guardrails** (reconciling fading skills with "never take back anything earned"):
- Freshness never lowers a tier, level, XP, stamps or trust. "Yours" stays yours.
- Fading is slow: a technique counts Warm after about 6 weeks unused and Rusty after about 4 months. Both are tunable data, not code.
- A Rusty technique is shown as an invitation ("your tadka's gone a bit rusty; fancy a refresher?"), never as a warning or a red badge.
- At most one refresher suggestion a week, and it shares the "One More Technique" slot, so the Pan never nags twice.
- No notifications are sent about fading.

## 18. Neighborhood Pantry (mutual aid)

Leftovers and surplus ingredients go to neighbors instead of the bin. It supports the Community and Social Justice values, and Use-It-Up Rescue leads straight into it.

- **The Pan suggests; the player approves.** When the pantry or a cooked batch has more than the player will eat before it spoils, the Pan offers: "Three portions of dal and they'll keep till Friday. Want to offer them to the neighborhood?" One tap posts it. **Nothing is ever posted automatically**, because a post reveals the player's area and what they eat.
- **Each post** lists the item, portions, "made on / keeps until" date, pickup window, and an approximate area. The area is a neighborhood or a grid cell of about 1 km, never an address. The exact pickup spot is shared only after the poster accepts a request.
- **Allergens are attached automatically.** A cooked dish posts with its ingredient list and allergen tags from the rules engine. Requesters see their own ✅/⛔/❓ status for the post using their own rules, computed on their side. The poster sees nothing about anyone's rules. The standard disclaimer applies.
- **Food safety:** rules by food type cover what can be shared: cooked dishes within a set number of hours or days, no raw meat or fish, no home-canned goods, and labeled "keeps until" dates. A "check before you eat" note links to local food-safety guidance. Sharing rules vary by region; launch regions get a legal check (§9, milestone 12).
- **Safety and moderation:** reporting and blocking, rate limits on posts and requests, and no free-text contact details in posts. In-app requests reveal a first name or handle only.
- **Community fridges and food banks:** a map of local community fridges and food banks, as an alternative to person-to-person sharing. External groups (e.g. Buy Nothing, Olio) get a "share outside the app" text the player can copy. We don't post to other platforms on the player's behalf.
- **Rewards (Octalysis):** sharing is recorded in Cooked for Someone and gives a small, capped amount of XP. There is no leaderboard and no "top sharer". It is always free.
- **Data:** posts expire and are deleted after their pickup window. Location is stored only at grid-cell precision.

## 19. Family Mode

Full analysis: `docs/business/2026-11-09-family-mode.md`.

- **Who:** an adult (18+) runs a Family Kitchen. Children take part only as **child cook profiles** inside it: no child accounts, emails, birthdays or login. Accounts stay 16+.
- **What:**
  - **Cook Together quests** split each recipe's steps by age band (3–5, 6–8, 9–12, 13–15). Recipes gain a family task block with hazard tags, checked automatically: hot oil is always adult-only, and knives and heat are not allowed below the 9–12 band.
  - A **family recipe book** records who taught whom.
  - A weekly **Family Table** dish, with no streak.
  - **"Try It" quests** reward handling or tasting a food, never finishing it.
  - **Kitchen-safety cards** by age band, written as reviewed content, never AI advice.
- **Children and the AI:** children never talk to the AI.
  - In Family Table mode the Pan uses scripted lines only.
  - Server speech-to-text is off. A few fixed commands ("next", "repeat", "timer") are recognised on the device. There is no text box, and nothing is kept.
  - Child nicknames never enter a prompt; a child appears as "Helper N" with an age band.
- **Data stored about a child:** nickname, age band, a preset avatar, the child's skill progress, "cooked together" records, and allergy rules that the parent enters and confirms (sealed like adult rules).
  - **Never stored:** intake or nutrition tracking, photos of the child, voice, or location.
  - **Photos:** food only. An on-device face check blocks uploads that show a face (pending legal review of the biometric question).
- **Pricing (spec §16):**
  - **Free:** one adult plus up to 4 child profiles, with per-child allergy rules, safety tasks and the printable family book.
  - **Household Guild:** $6 / $10 / $16 a month (choose your price), for up to 4 accounts aged 16+ and 6 child profiles.
  - **Gift memberships** never auto-renew.
  - **Print-on-demand family books**, sold by us, with no affiliate links.
  - A **Junior Kitchen Club** kit through The Multiverse School, holding no student data.
- **Never** (on top of the §16 never rules): no purchase prompts shown in child-facing views, no pester-power mechanics, no streaks.
- **Schedule:**
  - Data model reserved in M5; built in a new **M13** after launch.
  - The Pan's Family Table mode is designed into M3 and M7 so it isn't bolted on later.
  - Legal review before launch is required (counsel scoping call; the report lists 11 questions).

## 20. Security and privacy stance

- **Who it's for:** individuals managing their own food, allergies and diet. Kitchen Quest is not a clinical tool. It doesn't receive data from, or send data to, clinicians, health plans or employers. The one exception is a player-initiated share link (C-26), which the player controls.
- **Not a HIPAA product:** the product rules in `docs/compliance/2026-11-09-health-data-compliance.md` (P-1–P-14) keep it outside HIPAA. Any B2B deal that would bring in protected health information needs a separate, deliberate decision. We never claim "HIPAA compliant".
- **Treated as health data:** allergies, diet rules, diet journeys, symptoms, meal logs, accessibility voice needs, and the photos and transcripts that may reveal them.
  - Collected only with separate, tap-based consent.
  - Sealed with per-user keys.
  - Never sent to the AI without `ai_health` consent.
  - Never used for advertising or training.
  - Exportable and deletable at any time, including from backups via crypto-shredding.
- **Living checklist:** every security and privacy requirement is tracked in `docs/compliance/ROADMAP.md`. Standing rule: anything a health-data or privacy law requires is implemented when found, without waiting for approval.
