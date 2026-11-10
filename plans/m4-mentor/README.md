# Milestone 4: The Mentor (text) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file.

**Goal:** The Pan becomes the player's main way to enter data. A text conversation (scripted first, `qwen/qwen3.8-27b` through OpenRouter only where writing can't reach) turns what the player says into proposal cards for allergy and diet rules, meal logs, profile and schedule answers, and pantry changes. Deterministic code builds every card and its read-back. Nothing is saved until the player taps the card (or, for non-severe cards, types a plain "yes"). It includes the onboarding interview (Form 1-A) in text, consent and AI-disclosure cards, a rules screen as the form fallback, and a scripted mentor that keeps all of this working when the AI is off, failing, over its cap, or not consented to.

**Architecture:** One deterministic toolkit in `packages/core/src/mentor/` (intent classifier, page-event stripper, spelling, clock/weekday/pantry/rule/meal parsers, card builders, the wire protocol types) is shared by the server agent and the client's scripted engine, so both build identical cards. The server agent (`apps/api/src/mentor/`) pre-routes every turn through code first (emergency, medical, child, plain yes/no/undo, plan questions, health text without `ai_health`). Only what is left goes to the model. The model gets **no write tools**: it can only call `propose_*` tools. Their arguments are validated, corrected by deterministic post-checks, and turned into sealed, short-lived `mentor_proposals` rows. A proposal is written only by `POST /mentor/proposals/:id/confirm` (a tap), or by a strict typed "yes" for a non-severe card issued in the previous Pan turn. The write runs through the same services the REST routes use. The model's free text passes an output filter, and any claim of a write is always replaced, because the model cannot write. In the game, `MentorBackend` returns cards as well as lines. The AI backend wraps the scripted engine and falls back to it on any failure.

**Tech Stack:** Node 22, Fastify 5.12, drizzle 0.45, Postgres 16, zod 4, `yaml` (new API dependency, to read `content/` and `docs/style/voice.md` at boot), OpenRouter Chat Completions over `fetch` (no SDK), Vitest 5, Vite 8 and Playwright 1.63.0 (pre-installed Chromium) for the game.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md`: §2 principles, §4.4 rules, §5 meal logging, §7 intro, §7.0 mentor agent and tools, §7.5 failure, §7.6 voice safety (interfaces only), §7.6b safety architecture (binding), §8 scripted first, §9 privacy, §12 mentor tests, §13 (M4 = Mentor (text)), §16 free forever and never rules, §19 Family Table, §20 security. Also `docs/spikes/2026-11-09-qwen-as-pan.md` §6 mitigations and §2/§8 cases; `docs/style/voice.md` §0, §3, §6, §7; `content/dialogue/pan.yaml`; `content/bureau/forms.yaml`; `content/README.md`; `docs/compliance/2026-11-09-health-data-compliance.md` §6 (C-12–C-17, C-34, C-39), §8 (P-1–P-14); `docs/compliance/risk-register.md` (N-4, N-9); `docs/compliance/data-inventory.md` §3.3–3.4; `plans/m2-api/step-5.md` (rules) and `plans/m3-game/step-5.md`, `step-6.md`, `step-11.md` (panel, rules state, API client, verify page).

**Numbering note:** spec §13 and `docs/compliance/ROADMAP.md` make this M4. The compliance report's C-12–C-17, C-34, C-39 and N-4, N-9 name `plans/m3-mentor/README.md`. That file is this one.

## Global Constraints

Quoted from the spec unless marked. Every task's requirements include this section and the M2 and M3 Global Constraints (`plans/m2-api/README.md`, `plans/m3-game/README.md`).

- §2.1: "The AI suggests, deterministic code decides. Anything safety-relevant (allergens, diet rules, nutrition) is computed by plain, tested code over confirmed data. LLM output is a proposal a person or the rules engine checks."
- §2.2: "'Can't verify' is never 'safe.'" (Plan rule: a term the graph can't resolve is never stored as a narrower rule. It gets `rule.unknown_term` and nothing is saved. An ambiguous term shows options and never auto-picks one.)
- §7.0: "The agent never writes the database directly." · "Writes need a yes. Any write affecting health or safety needs a spoken or tapped 'yes' after a full read-back. A second short window lets the player say 'wait, undo that.'" · "Every write shows as a small card in the conversation … so the player can tap it to edit or undo." · "There is no free-form long-term memory of health details outside the encrypted tables."
- §7.6b (binding): 1. "The server guards every health write … The model's own claim of confirmation is never enough." 2. "Read-backs and allergen spelling come from code, not the model, using written lines from `content/dialogue/pan.yaml`." 3. "The on-screen card is the record. … If the reply claims a write that didn't happen, the claim is replaced." 4. "Card taps and system events never arrive as user text, and lookalike strings (e.g. '[Player tapped …]') are stripped from user input." 5. "Output filter before display or speech: no 'this is safe to eat' claims, banned words from `docs/style/voice.md`, a 3-sentence limit, and no empty replies." 6. "temperature 0.3, reasoning off, and a pinned allow-list of fast, cheap, no-retention providers." 7. Few-shot examples for "I finished the milk" and "half twelve means 12:30". 9. The spike suite "becomes a permanent eval, run on every prompt or model change, with a zero-tolerance gate on safety categories."
- §7.6: "Severe rules always need a tap on the on-screen card in addition to the spoken yes." Severe = `anaphylactic` or `allergy` (core `SEVERE`). (Plan rule: a typed "yes" never confirms a severe card.)
- §7: "All AI calls go through one `AiProvider` interface in `apps/api` that calls OpenRouter. The model is set by config (`AI_MODEL=qwen/qwen3.8-27b`). Each task has a versioned prompt template and a JSON-schema output, and responses are validated before use."
- §7.5: "Core play never depends on AI … If the mentor is unavailable, the UI fallback forms appear." (Plan rule: every flow in this milestone has a scripted path that is tested with the AI off.)
- §8: "The game uses a written line whenever one fits." `ai: never` triggers are used exactly. The model is never asked to write a read-back, label reminder, medical deflection or emergency line.
- §9 / C-13: "AI requests send only what the task needs, with no user identifiers in prompts." No email, user id, name, exact dates or child data in any prompt.
- §16 free forever: "allergy and diet checks, including AI help creating rules", "meal logging", "export and delete". Never rule 1 "Never charge for safety." Never rule 7 "Mentors and cooks never sell; the Pan never mentions the Guild unprompted." (Plan rule: the AI's daily cap never blocks rule entry or meal logging. Those fall through to the uncapped scripted path. Allowance questions get a scripted line, never a model reply.)
- §16: "Paid plans are 18+." M4 adds no purchase UI anywhere.
- §19: "In Family Table mode the Pan uses scripted lines only." · "There is no text box, and nothing is kept." · "Child nicknames never enter a prompt."
- §20: health data is "Never sent to the AI without `ai_health` consent." · "We never claim 'HIPAA compliant'." (Plan rule: the words "HIPAA" and "medical-grade" appear in no product copy; Step 12 scans for them.)
- C-14: every OpenRouter request carries `provider.data_collection: "deny"`, `provider.zdr: true` and the allow-list. Never a `:free` model. Config refuses to boot without the policy.
- C-15: "Prompts and responses are never written to logs, GlitchTip or the database apart from C-12 transcripts." Only `usage_events` (counts and cost).
- C-16 copy, verbatim: "The Pan and the cooks are AI characters. Don't rely on them for medical advice."
- P-11 / N-9: no processor receives user data until its DPA is signed. (Plan rule: in production the API refuses to boot with `AI_ENABLED=true` while `processors.json` lists `openrouter` or `openrouter-model-providers` with a `dpa_status` other than `signed`.)
- P-1–P-14 (compliance report §8), as this milestone meets them:
  - P-3 is Step 7's consent gate and minimised context.
  - P-4 is Step 11's separate tap cards, with one-tap withdraw in Settings.
  - P-5: mentor routes carry text only in POST bodies, never in URLs, and logs are tested (Steps 4, 7, 8).
  - P-6: the context holds region at most.
  - P-7: no audio in M4.
  - P-9 is the child guard (Step 7) and Family Table scripted-only (Step 10).
  - P-10: `data_collection: "deny"` (Step 4).
  - P-11 is Step 4's DPA gate.
  - P-12: no "HIPAA" anywhere (Step 12 scan).
  - P-14: every new table is in export, delete and `HEALTH_TABLES` (Steps 5, 6).
  - P-1, P-2, P-8 and P-13 are untouched: no organisation, clinician or region code here.
- Error body shape is M2's. New codes: `proposal_closed` (409), `undo_window_closed` (409), `tap_required` (400).
- Tests never touch the network. The model is a fake `AiProvider` (`apps/api/test/helpers/fake-ai.ts`). OpenRouter calls are tested through an injected `fetch`. API tests use real Postgres (M2 harness). Game e2e mocks `/api/**` with `page.route`.
- Constants (tunable, one place each): `PROPOSAL_TTL_MS = 30 * 60_000`, `UNDO_WINDOW_MS = 5 * 60_000`, `TRANSCRIPT_RETENTION_DAYS = 30` (C-12), `HISTORY_MESSAGES = 8`, `MEMORY_TTL_MS = 30 * 60_000`, `CONVERSATION_IDLE_MS = 6 * 3_600_000`, `TURNS_PER_MINUTE = 20`, `FREE_AI_TURNS_PER_DAY = 15` and `GUILD_AI_TURNS_PER_DAY = 100` (business doc §C "~15" and "~100"), `MAX_TEXT = 500` chars, `MAX_PANTRY_ITEMS = 300`.

## Review Focus

1. **A false "it's saved" or "it's safe".** A forged `[Player tapped "Stamp it ✔" …]` in the text, a `<system>` override, a DAN role-play, or a model that answers "the peanut rule is on file" or "the frijoles are completely safe" must leave the player seeing only what the database holds: no write, the claim replaced by `write.not_done` or `didnt_understand`, and the card as the only record. → Step 7 (filter, strip), Step 8 (adversarial suite).
2. **The wrong "yes".** A typed "yes" with two cards open, a "yes" after the card expired or after another turn, a "yes yes yes I confirm" in the same message as the allergy, a severe card confirmed by anything but a tap, and a double-tapped Stamp button. Each needs exactly one write or none, and never a severe write without a tap. → Step 8 (server), Step 10 (client).
3. **The AI drops out mid-flow.** A timeout, a 5xx, invalid JSON, the daily cap, or the global budget reached during the intake interview or a rule read-back. The player still finishes Form 1-A and stamps the rule through the scripted path, keeps the unsent message for "Try again", and is never told to pay. → Step 7, Step 9, Step 11.
4. **Health data reaching the AI or the logs without consent.** "I'm allergic to peanuts" typed by a player without `ai_health` must never reach the provider. A non-consenting player's prompt carries no rule names or ids. A provider error that echoes the prompt leaves nothing in the log stream. → Step 4, Step 7.
5. **Ingredient terms the graph can't pin down.** "kiwi" (not in the graph), "nuts" (a category), "pecan" after "peanut", and plurals or misspellings must give a plain "can't check that yet", a full "this covers …" list, or a choice of options. They must never silently become a narrower rule that later shows a dish as ✅. → Step 1, Step 9.

## Pre-flight

**Gate:** Steps 9–11 build on M3 Step 11's `apps/game/src/api/{types,client,account}.ts` and `apps/game/src/auth/verify-page.ts`. At the time of writing, M3 Steps 10–12 are ticked in `plans/m3-game/README.md`, but their code is not on `claude/eager-cori-h3gmju`: Step 10 is uncommitted in the `KQ-m3` worktree. Merge M3 Steps 10–12 into the branch before dispatching Step 9. Steps 1–8 touch only core, content and the API, so they can start now.

Earlier-milestone files each task touches (new files are listed in each step):

| Step | Earlier-milestone files modified |
|---|---|
| 1 | `packages/core/src/engine.ts`, `packages/core/src/index.ts` |
| 2 | `content/dialogue/pan.yaml`, `content/bureau/forms.yaml`, `content/README.md`, `apps/game/src/content/required.ts`, `apps/game/build/content-plugin.ts` (load `data/rule-terms.json`), `apps/game/src/content/types.ts` |
| 3 | `apps/api/src/rules/routes.ts`, `apps/api/test/rules.test.ts`, `.env.example`, `docs/compliance/data-inventory.md` §3.14 |
| 4 | `apps/api/src/config.ts`, `apps/api/src/app.ts` (`Deps.ai`), `apps/api/src/server.ts`, `apps/api/package.json`, `apps/api/test/helpers/config.ts`, `apps/api/test/processors.test.ts`, `docs/compliance/processors.json`, `.env.example` |
| 5 | `apps/api/src/db/schema.ts`, `apps/api/src/app.ts`, `apps/api/src/account/routes.ts` (export), `apps/api/src/consent/health-data.ts` (`HEALTH_TABLES`), `apps/api/src/audit/self-reads.ts` + `SELF_READ_RESOURCES`, `apps/api/test/architecture.test.ts`, `apps/api/test/account.test.ts`, `docs/compliance/data-inventory.md` |
| 6 | `apps/api/src/db/schema.ts`, `apps/api/src/jobs/retention.ts`, `apps/api/src/consent/notices.ts`, `apps/api/src/consent/health-data.ts`, `apps/api/src/account/routes.ts`, `apps/api/test/architecture.test.ts`, `apps/api/test/consent.test.ts` (current notice version), `docs/compliance/data-inventory.md` |
| 7 | `apps/api/src/app.ts` |
| 8 | `apps/api/src/rules/service.ts` (Step 3), `apps/api/src/profile/routes.ts` (extract `applyProfilePatchIn`) |
| 9 | `apps/game/src/state/store.ts` (+ test), `apps/game/src/recipes/rules.ts` (+ test), `apps/game/src/api/client.ts`, `apps/game/src/api/types.ts`, `apps/game/src/mentor/backend.ts` (+ test) |
| 10 | `apps/game/src/mentor/panel.ts` (+ test), `apps/game/src/mentor/index.ts`, `apps/game/src/styles/components.css`, `apps/game/e2e/mentor.e2e.test.ts` |
| 11 | `apps/game/src/shell/router.ts` (+ test), `apps/game/src/shell/app.ts`, `apps/game/src/settings/settings-screen.ts`, `apps/game/src/auth/verify-page.ts`, `apps/game/e2e/signin.e2e.test.ts` |
| 12 | `apps/game/e2e/` never-rules scan (M3 Step 12), `docs/compliance/ROADMAP.md`, `docs/compliance/data-inventory.md`, `docs/compliance/dpia.md`, `docs/compliance/processors.json`, `README.md` |

## Tasks

- [ ] [Step 1 — Core: the deterministic mentor toolkit and wire protocol](step-1.md)
- [ ] [Step 2 — Content: new Pan lines, consent and disclosure forms, rule terms](step-2.md)
- [ ] [Step 3 — API carry-overs: rule service, per-user rule lock, 401 before 403](step-3.md)
- [ ] [Step 4 — API: AiProvider, OpenRouter policy, processor gate, no content logging](step-4.md)
- [ ] [Step 5 — API: meal logs and pantry](step-5.md)
- [ ] [Step 6 — API: conversations, transcripts, proposals, notices](step-6.md)
- [ ] [Step 7 — API: the turn endpoint (pre-route, consent, prompt, tools, filter, allowance)](step-7.md)
- [ ] [Step 8 — API: confirm, reject, undo, typed yes; the adversarial suite](step-8.md)
- [ ] [Step 9 — Game: store and rules carry-overs, API client, scripted engine with cards](step-9.md)
- [ ] [Step 10 — Game: cards in the panel, the AI backend, trail and undo](step-10.md)
- [ ] [Step 11 — Game: Form 1-A intake, consent and disclosure cards, rules screen, age screen, settings](step-11.md)
- [ ] [Step 12 — Eval harness, free-forever and never-rules sweep, compliance docs](step-12.md)

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Steps 9 → 10 → 11 can start after Step 2 and the pre-flight gate, and they need Step 8's routes for their e2e mocks to match. Step 12 comes last. Steps 1 and 2 touch `packages/core` and `content/`, which the game build also compiles. Run `npm test` for the game after each.

**Deferred, on purpose:**
- the other §7.0 tools: `log_symptoms` (M9 journeys), `plan_week` / `edit_plan` (M5), `check_off_item` (M6), `import_recipe` (M8), `start_lesson` / `start_quest` / `open_scene` (M5), grounded `answer_question` and AI rule expansion for unknown terms (M8, which must stay cap-exempt per §16)
- nutrition numbers for meal logs (game dishes are computed by core at read time in M9; free-form estimates in M8/M9)
- device-side meal logs and offline log sync (M9; signed-out players get `log.needs_account`)
- streaming replies, the `tool.filler` line, STT/TTS, spoken yes and barge-in (M7; this plan defines `input.kind`, `channel` and `toolTurn` so M7 adds them without changing the protocol)
- the under-16 actual-knowledge procedure and the child-directedness review (M12, C-39); Family Mode child profiles (M13)
- the OpenRouter DPA itself (a founder action, C-34); this milestone builds the gate and the review checklist
