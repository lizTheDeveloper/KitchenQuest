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
| Recipe format | Cooklang |
| Open source | The canonical recipe library is open (CC BY-SA 4.0). User imports stay private |

### 1.2 Assumptions (not confirmed; change freely)

- "Reclaim City" is read here as a habit-RPG loop (Habitica-like): real-life actions earn in-game progress. Revise §6 if it means something else.
- No monetization in v1. Architecture does not preclude a later subscription.
- Launch content is 3 countries × 3 cooks = 9 dishes. Country choice depends on recruiting contributors from those cuisines (§11).
- Minimum age 16, because the app processes health data.

## 2. Principles

1. **The AI suggests, deterministic code decides.** Anything safety-relevant (allergens, diet rules, nutrition) is computed by plain, tested code over confirmed data. LLM output is a proposal a person or the rules engine checks.
2. **"Can't verify" is never "safe."** Unknown ingredients, store-bought products, and fuzzy quantities are surfaced, not silently passed.
3. **Reward eating enough, never restriction.** No XP for eating less. No shame streaks. Missed days cost nothing.
4. **Guest, not conqueror.** Recipes are taught and gifted, credited to communities, and reviewed by people from those cuisines before they are canon.
5. **Comedy punches at the fantasy and the player, never at cultures.**
6. **Health data is minimal, encrypted, exportable, and deletable.**

## 3. World and game loop

### 3.1 Setting

Real Earth, but kitchens have small gods, markets have weather, and knives have opinions.

- **The Pantry Bureau.** A fantastically over-bureaucratic guild that licenses apprentice cooks. It issues forms in triplicate, stamps, and footnotes. The Adams register lives here.
- **The Pan.** A talking cast-iron pan: sidekick, critic, and meal reminder ("It has been six hours. I am a pan, and even I am concerned."). The Pratchett register lives here.
- **Cooks.** One NPC per kitchen (a restaurant, street stall, or home kitchen). They are competent, dignified experts from their cuisine and are never the butt of the joke.

### 3.2 Weekly loop

**Setup (onboarding):**
- The player tells the Bureau their real market day(s) and roughly how many meals a week they'll cook.
- They enter allergies and diet rules (§4.4).
- That's enough to start. Everything else can wait.

**Kitchen days (daily, 5–10 minutes).** In the 8-bit kitchen, the player does any of:
- **Lesson:** learn an upcoming recipe step by step, including *why* each step exists.
- **Drill:** a short technique lesson (dicing, heat control, "until fragrant," salting pasta water).
- **Plan:** choose taught dishes for the week. The plan shows weekly nutrition balance, and the Pan flags gaps ("Nothing green since Tuesday.").
- **Log:** record what they ate (§5), and answer a symptom check-in if a diet journey is active.

**Market day.**
- The week's plan becomes an ingredient quest list, grouped by stall (produce, protein, dairy, pantry, spice merchant) and pre-filtered against the pantry the player says they already have.
- Checking an item off in the real store "fetches" it in the market scene.
- Out of something? The recipe offers a labeled substitute, re-checked by the rules engine.
- Completing the run earns market XP.

**Cook days.**
1. Open a planned dish in **cook mode**: big text, one step at a time, built-in timers from Cooklang `~{}` timers, and the screen kept awake.
2. Finish by taking a photo with the in-app camera.
3. The cook reacts in character: specific, kind, funny feedback about what is visible (§7.2). This is a reaction, not verification.
4. Rewards are granted (§6), and the meal is logged with recipe-derived nutrition.

**Gentle failure.**
- Bought ingredients but didn't cook? The Pan suggests a use-it-up recipe before they spoil.
- Nothing is lost when a day is missed.

### 3.3 Travel and progression

- Trust with a cook unlocks their next dish.
- At high trust, the cook introduces the player to a friend in another country, which opens that country on the map.
- Imported recipes (§7.1) appear as **Recipes from Abroad**: a guest cook in the recipe's country of origin, visible only to the importing player.

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

**Logging a meal:**
- **Game dish:** one tap. Nutrition comes from the recipe × servings eaten.
- **Free-form:** text ("two slices of toast with peanut butter") or a photo. The AI estimates components; the user confirms. Everything is marked as an estimate.
- **Repeat:** "same as yesterday's breakfast."

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
| **Daily nourishment** | Logging meals at reasonable intervals and hitting "enough" ranges. Small and steady, never multiplied by streaks |

**Anti-cheat stance.** Photos aren't verified, and that's fine. The game's value is the cooking, so cheating only cheats yourself. No leaderboards in v1, so there's no incentive to fake.

## 7. AI features

All AI calls go through one `AiProvider` interface in `apps/api` that calls OpenRouter. The model is set by config (`AI_MODEL=qwen/qwen3.8-27b`). Each task has a versioned prompt template and a JSON-schema output, and responses are validated before use.

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

If OpenRouter is down or returns invalid output, the game says so in character ("The cook has stepped out; your plate is on the pass and they'll get to it."), queues the request, and retries. Core play (lessons, market, cook mode, logging, rule checks) never depends on AI.

## 8. Comedy and writing

- **Style guide** (`docs/style/voice.md`):
  - Bureau voice: formal, footnoted, absurd procedure
  - Pan voice: deadpan, fond, concerned
  - Cooks' voices: competent, specific, warm
  - Hard rules: no jokes about cultures, accents, bodies, or weight
- **Core narrative content is handwritten**: onboarding, cook introductions, dish stories, and Bureau forms.
- **AI writes only the dynamic lines**: photo reactions, Q&A, and Pan reminders, prompted with the style guide plus persona.
- **Content as data.** Dialogue and lessons live in data files, not code, so writers and contributors can edit them.

## 9. Architecture

```
KitchenQuest/
  apps/
    game/        # Vite + Phaser + HTML overlays, PWA (manifest, service worker, Web Push, share target)
    api/         # Node + Fastify, TypeScript; AI provider; auth; jobs
  packages/
    core/        # pure TS: Cooklang wrapper, ingredient graph, rules engine, nutrition, rewards
  recipes/       # open canon .cook files + lesson sidecars, CC BY-SA 4.0
  data/          # ingredient graph seeds, substitutions, USDA subset, personas, dialogue
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
- **Game:** Playwright flows for onboarding, the weekly loop, cook mode, and import review, using the existing `game-playtesting` skill. Accessibility check on all HTML panels.
- **Recipes:** CI validates every canon `.cook` file (parses, resolves all ingredients, has credit and license).

## 13. Build order (each milestone gets its own plan)

1. **Core:** monorepo layout, `packages/core` with the Cooklang wrapper, ingredient graph, rules engine, and nutrition, with tests. No UI.
2. **API and data:** Fastify, Postgres schema, auth, recipe sync from `recipes/`, profile and rules endpoints.
3. **Game shell:** PWA, map, kitchen, cook mode, onboarding (market day + rules). Uses placeholder art.
4. **Weekly loop:** plan → market run → cook → log, plus rewards and trust.
5. **AI:** provider interface, photo reaction, ingestion, NPC Q&A, rule expansion, and evals.
6. **Tracker:** free-form logging, targets, reminders (Web Push), weekly view, low-FODMAP journey.
7. **Content and art:** 9 dishes, personas, dialogue, PixelLab sprites, style guide.
8. **Launch hardening:** privacy and export/delete, terms, offline, performance, and a playtest batch.

## 14. Out of scope for v1

- Native app-store apps (a Capacitor wrapper later)
- Body metrics and weight tracking
- Social features, leaderboards, and sharing photos publicly
- Paid currency or subscription
- Barcode scanning
- Wearables and health-platform integrations
- Multiplayer cooking

## 15. Open questions

1. What does "Reclaim City" mean to you, and which part of it should the reward loop copy?
2. Which 3 launch countries, and who are the contributors and reviewers?
3. Monetization direction (free, subscription, or school tie-in), so the data model doesn't block it.
4. Is age 16+ right, or should it be 18+?
