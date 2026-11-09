# Milestone 3: Game Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file.

**Goal:** An installable, offline-capable PWA (`apps/game`): the world map, the player's kitchen, a cook's kitchen, an HTML cook mode with Cooklang timers and wake lock, a scripted mentor panel, recipe cards checked by `@kitchenquest/core` against the player's rules, a Technique Toolkit display, and the sign-in page for the M2 API.

**Architecture:** An HTML app shell with a hash router owns every screen and all text. Phaser is loaded lazily and only paints backdrops and sprites behind the HTML. If the canvas never loads, every screen still works. Content (`content/*.yaml`, `recipes/**/*.cook`, `data/*`) is compiled and validated at build time by a Vite plugin into one virtual module, so a bad file fails the build. All safety and progression logic is pure TypeScript in `packages/core` (recipe steps, `check`, nutrition, Toolkit/Freshness) or in small pure game modules (the dialogue engine, timers, routing, service worker routes), with Vitest unit tests. Playwright drives the built app for the flows.

**Tech Stack:** Vite 8, TypeScript, Phaser 3.90, `@kitchenquest/core`, `yaml` and zod 4 (build time only), `@fontsource/*` (self-hosted fonts), Vitest 5, `playwright@1.63.0` with `@axe-core/playwright`, a hand-written service worker.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md` (§2 principles, §3.2–3.4 loop and presentation, §4.4 display, §5 calories, §6 rewards, §8 scripted-first, §9 offline/privacy, §10 drafts/sacred, §16 never rules, §17 Toolkit/Freshness, §19 Family Table). Also: `content/README.md` (content schema and dialogue rules), `prototype/BRIEF.md` (look), `docs/style/voice.md` §0 (hard rules), `plans/m2-api/step-3.md`–`step-6.md` (API shapes).

**Numbering note:** spec §13 lists "Mentor (text)" as M3 and "Game shell" as M4. The founder has moved the game shell up to M3 so the two can run in parallel. The mentor/AI milestone will be planned separately. Wherever the spec says "M4" for the game shell or the Toolkit data model, read it as this milestone.

## Global Constraints

Quoted from the spec unless marked. Every task's requirements include this section.

- §3.4: "Phaser renders the scenes. HTML overlays handle forms, long text, and accessibility (screen readers, large text). Cook mode and logging must work fully without the canvas." (Plan rule: the canvas never draws text; it is `aria-hidden`; every canvas hotspot has an HTML button that does the same thing.)
- §3.2 cook mode: "big text, one step at a time, built-in timers from Cooklang `~{}` timers, and the screen kept awake."
- §2.1: "The AI suggests, deterministic code decides." Recipe status comes only from core `check`. Nutrition comes only from core `nutritionPerServing`.
- §2.2: "'Can't verify' is never 'safe.' Unknown ingredients, store-bought products, and fuzzy quantities are surfaced, not silently passed."
- §4.4: "The game never shows a dish as cookable when it is blocked." Severe rules show the persistent disclaimer, word for word from core `DISCLAIMER`: *Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.*
- §6: "Nothing earned is taken back. Undoing a meal log or an allergy rule removes the record, never XP, level, stamps or trust." Technique Toolkit: "Seen (lesson) → Tried (cooked once) → Yours (used in a second dish or cuisine). Never decays."
- §17 Freshness guardrails: "Freshness never lowers a tier, level, XP, stamps or trust. 'Yours' stays yours." · "Fading is slow: a technique counts Warm after about 6 weeks unused and Rusty after about 4 months. Both are tunable data, not code." · "A Rusty technique is shown as an invitation ('your tadka's gone a bit rusty; fancy a refresher?'), never as a warning or a red badge." · "No notifications are sent about fading."
- §16 Never rules (binding on every milestone): 1. Never charge for safety. 2. Never paywall eating enough. 3. Never sell progress or a way to skip learning. 4. No loot boxes or random paid items. 5. No paid urgency; scarcity only mirrors real seasons. 6. Never take back anything earned. 7. Mentors and cooks never sell; the Pan never mentions the Guild unprompted. 8. No rewards for eating less, for responding to reminders, or for streaks. 9. No referral schemes or leaderboards. 10. Community recipes stay free to cook, and their contributors are paid and credited. (Plan rule: M3 contains no purchase, Guild, price or upgrade UI anywhere.)
- §19 Family Mode: "no purchase prompts shown in child-facing views, no pester-power mechanics, no streaks." · "In Family Table mode the Pan uses scripted lines only." · "There is no text box, and nothing is kept."
- §5: "Calories are hidden by default and can be turned on in settings."
- §10: drafts "are playable and labeled as drafts". Sacred dishes: "no XP or photo loop, shown only as stories".
- §8: "The game uses a written line whenever one fits." The `content/README.md` rules apply: "No repeats in a row … the last `min(3, n-1)` lines used"; "A line whose variable is missing is skipped. If every line would be skipped, the game uses the first line with the variable replaced by a safe default."
- §9: "Offline: recipes, cook mode, and logging work offline through the service worker." · "No selling or sharing of data, and no third-party ad trackers." (Plan rule: the app makes no requests to any other origin. Fonts are self-hosted.)
- voice.md §0.2–0.3: never "exotic". "Recipes are *taught*, *gifted*, *passed on*, *shared*. Never *looted*, *unlocked from*, *collected*, *discovered*, *found*, *captured* or *conquered*. … UI copy too: 'Leela taught you Parippu', not 'Recipe acquired!'."
- Carried from the M2 auth review (founder): `/auth/verify` sets `Referrer-Policy: no-referrer` as a `<meta>` tag and as a response header wherever we control the server. It POSTs the token **only after a user click**, never on load (login CSRF).
- §7.0: "Writes need a yes." M3 has no health or safety write UI. The API client's rule writes take `confirmed: true` as a literal type, for the mentor milestone to call after a read-back.
- Look (`prototype/BRIEF.md`): use its CSS tokens verbatim. Fonts are Pixelify Sans, Atkinson Hyperlegible and VT323. Pixel borders, square corners, `image-rendering: pixelated`, integer sprite scaling. Use real `<button>`s with visible focus. Respect `prefers-reduced-motion`. No horizontal scroll at 400px, with the side gutter `max(16px, env(safe-area-inset-left/right, 0px))`.
- Testing (founder): Playwright uses the pre-installed Chromium through `chromium.launch()` from `playwright@1.63.0`. Never run `playwright install` locally. E2E tests run against `vite build` + `vite preview`.

## Review Focus

1. **The player's "today" is their local calendar date, not UTC.** A player at 23:30 in UTC−8 must get today's rule phases and freshness, not tomorrow's. → Task 6 (`localDate`), Task 2 (date-only freshness math).
2. **Rules that can't be read must never show ✅.** Corrupt device storage, rules that core's `validateRules` rejects (e.g. after an ingredient id is renamed), or account rules that fail to load must show ❓ with a plain "couldn't check your rules" note. → Task 3 (corrupt storage), Task 6 (`activeRules` error → unverified), Task 11 (invalid API rules).
3. **Deep links bypass the recipe card.** `#/cook/<slug>` opened from history, a bookmark or a shared link must refuse a blocked or sacred dish. A cook mode resumed after reload must re-check the dish against the current rules. → Task 7.
4. **Timers when the phone sleeps or the tab is hidden.** Background tabs throttle intervals, so timers must use absolute end times. A finished timer is announced exactly once, even after a step change or a 2-hour jump. Leaving cook mode with timers running says so. → Task 7.
5. **The service worker must never hold player data or sign-in tokens.** `/api/*` and `/auth/*` are network-only. The token is stripped from the address bar on load. A new deploy must not break an open cook session: the new worker waits, and old caches are deleted on activate. → Task 10, Task 11.

## Tasks

- [ ] [Step 1 — Core: recipe steps, timer durations, browser-safe entry](step-1.md)
- [ ] [Step 2 — Core: Technique Toolkit and Freshness](step-2.md)
- [ ] [Step 3 — App shell: router, design system, player store, Bureau form, e2e harness](step-3.md)
- [ ] [Step 4 — Content pipeline: build-time load and validation, techniques data](step-4.md)
- [ ] [Step 5 — Pan dialogue engine and mentor panel shell (with Family Table mode)](step-5.md)
- [ ] [Step 6 — Recipe cards against the player's rules](step-6.md)
- [ ] [Step 7 — Cook mode](step-7.md)
- [ ] [Step 8 — Asset manifest, lazy Phaser, the player's kitchen and the Toolkit display](step-8.md)
- [ ] [Step 9 — World map, travel permit, cook's kitchen](step-9.md)
- [ ] [Step 10 — PWA: manifest, service worker, offline, install notes](step-10.md)
- [ ] [Step 11 — API client, sign-in pages, account rules](step-11.md)
- [ ] [Step 12 — Accessibility and never-rules sweep, CI, README](step-12.md)

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7. Then 8 → 9. Then 10, 11 in either order, then 12. Steps 1 and 2 touch `packages/core`. Coordinate with whoever is finishing M2 (step 5 also edits core).

**Deferred, on purpose:** real AI and the Pan's tools (the mentor milestone); voice STT/TTS and on-device commands (voice milestone); a rule-entry UI (it needs the §7.0 read-back and §7.6 spell-back, so it belongs to the mentor milestone); the quest engine, trust and unlock gating, XP/stamps HUD, "One More Technique", refresher XP and suggestions (M5); market scene (M6); photo + reaction (later); "A Kitchen That Remembers" art (M10); Web Push (tracker milestone); deployment headers beyond the committed nginx snippet (launch hardening).
