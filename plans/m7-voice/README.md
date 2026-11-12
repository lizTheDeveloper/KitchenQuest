# Milestone 7: Live voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file.

**Goal:** The player can talk to the Pan out loud and cook hands-free (spec §7.7, §13 item 7). It runs on a self-hosted speech-to-text and text-to-speech service (`apps/voice`) with browser voice activity detection (VAD), barge-in and a hands-free cook mode. Text stays the default and always works. Every allergen or health word the recogniser hears is spelled back for a tap before it can reach a rule or a card. Audio never leaves memory. Children and Family Table never open the microphone.

**Architecture:**
- **One provider seam per side.**
  - The game's `VoiceProvider` has three adapters: `service` (default), `browser` (Web Speech; a development stand-in only, which production builds refuse) and `none`.
  - The API's `VoiceUpstream` has two: the real WebSocket client and a test fake.
  - `apps/voice` has its `SttEngine` / `TtsEngine` interfaces: real engines in a Python worker process, plus fakes.
  - Swapping the stack (spec §15 open question 5) means a new adapter, not a new milestone.
- **Path.** Browser mic → AudioWorklet (16 kHz PCM16, 20 ms frames) → browser VAD → `wss://<origin>/api/voice`. The API authenticates the session, checks the Origin, the `voice` consent, the child flag and the allowance, then proxies frames to `apps/voice` on the private network. `apps/voice` never sees a user id. faster-whisper turns the audio into a transcript. The game then sends the transcript as an ordinary `POST /mentor/turn` with `input.kind: 'transcript'`.
- **Under M4 Ruling R9 the model's text is never shown, so it is never spoken.** A spoken reply is the same scripted lines and card read-backs the panel draws. The game sends them as `SpeakItem`s: a line reference with its variant index, or a canon recipe step. **TTS accepts no free text.** The API renders each item from `content/dialogue/pan.yaml` or the recipe index. Each variable passes the existing `filterReply` screen, and any model `text` part a later milestone adds passes `filterReply` before speech (§7.6b.5). The text then goes through the sentence chunker to TTS.
- **Latency.** Because a turn's reply is known only once the model's tool call returns, every AI turn hides its latency the way §7.6b.8 and the spike describe:
  - a local sizzle earcon at once;
  - a pre-synthesised scripted filler line if the reply is slow (`voice.filler.ledger` for likely writes, `voice.filler.thinking` otherwise);
  - code-routed turns (most of them) answer in well under a second.
- **Safety.** Core `heardCheck` runs on the device before any backend sees a transcript. The API runs it again before the check-off grammar, the health gate, code cards and the model. A transcript naming any ingredient, rule term or sound-alike of one gets a heard card: the words are shown spelled, with sound-alike alternatives, and the turn goes on only after a tap. A **mishearing test set** of similar-sounding foods is a CI gate on it.
- **Shared code.** `packages/core/src/voice/` holds everything the device, the API and the voice service must agree on: the wire protocol, the heard check, phonetic keys, speech text and chunking, cook commands, and the filler choice.

**Tech Stack:**
- Node 22, Fastify 5.12, drizzle 0.45, Postgres 16, zod 4, Vitest 5, Vite 8 and Playwright 1.63.0 (`page.routeWebSocket`, Chromium's fake media stream).
- New runtime dependencies, each MIT: `@fastify/websocket` 11.x and `ws` 8.x in `apps/api`; `ws` 8.x in `apps/voice`. Pin each exactly at install.
- Operator-only Python 3.11+ worker, in `apps/voice/worker/requirements.txt`, pinned and never installed in CI: faster-whisper (MIT), ctranslate2 (MIT), kokoro-onnx (MIT), onnxruntime (MIT) and numpy, plus the separate `piper` binary (GPL-3.0, its own process).
- CI runs the worker's stdlib-only `--engine echo` mode under the runner's `python3`.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md`:
- §1.1 (live voice is a working default) and §2.7 ("Talk, don't type");
- §7.0 (writes need a yes; spoken yes), **§7.6 (all)**, §7.6b.1, .2, .4, .5, .8, .9 (binding), **§7.7 (all, including the spike results and licensing)**, §7.5 (failure behaviour);
- §9 (`apps/voice`, data and privacy), **§12 Voice** (the latency benchmark and the allergen mishearing set);
- §13 item 7 and §15 question 5;
- §16 (the free tier's capped voice, `usage_events` without content, "unlimited voice for players who need it for accessibility", never rules 1, 7 and 8);
- **§19 Family Mode** ("Children and the AI", "Never stored … voice", "designed into M3 and M7");
- §20 (accessibility voice needs and transcripts are health data; not HIPAA).

Also:
- `docs/spikes/2026-11-09-voice-latency.md` (all of it: stack, numbers, licences, barge-in, fallbacks, open items);
- `docs/style/voice.md` §0 and §3 (plain read-backs, no joke inside safety);
- `docs/business/2026-11-09-value-chain-monetization.md` §B.11 and §C (60 free minutes a month, Guild fair use, accessibility unmetered);
- `docs/compliance/2026-11-09-health-data-compliance.md` C-12, C-15, **C-18, C-19**, C-34, C-38, C-40, P-7, P-9 and P-11;
- `docs/compliance/data-inventory.md` V-1–V-4, P-5, I-1 and U-1;
- `ROADMAP.md`, `dpia.md`, `risk-register.md` (R-15, R-20) and `processors.json`;
- `plans/m6-market/README.md` (Ruling 22, the eval gate, and "spoken check-off by voice (M7)");
- `.superpowers/sdd/README-m6-market/progress.md` and `final-review.md` ("Parked items … Needs one eval re-run", folded into Step 7).

## Global Constraints

Quoted from the spec unless marked. Every task's requirements include this section and the M2–M6 Global Constraints (`plans/m2-api/README.md` … `plans/m6-market/README.md`).

- **§7.6:** "Speech-to-text output is treated as untrusted user text." · "For rules, the Pan spells out and shows on screen the ingredient it heard ('kiwi, K-I-W-I'), because mishearing an allergen is the worst failure mode." · "Severe rules always need a tap on the on-screen card in addition to the spoken yes."
  - Plan rule (Ruling 4): every transcript naming an ingredient, a rule term or a sound-alike of one is stopped by a **heard card**, which needs a tap, before any rule, card or model call.
- §7.6b.1: "`save_rule` is rejected unless … the yes arrived through the UI: a tap for severe rules, or a tap or a confirmed spoken yes for others. The model's own claim of confirmation is never enough."
- §7.6b.4: "Card taps and system events never arrive as user text." A heard-card tap travels as the structured field `input.heard`, never as text. Page-event lookalikes are stripped from transcripts as they are from text.
- §7.6b.5: "Output filter before display or speech". Plan rule: TTS accepts only `SpeakItem`s, never free text. Every variable passes `filterReply`, and any model `text` part passes `filterReply` before speech.
- §7.6b.8: "Tool turns speak a scripted filler line ('Let me write that in the ledger…') while the tool runs."
- §7.7 latency (as revised by the spike): **p50 ≤ 1.5 s and p90 ≤ 2.5 s** from the end of the player's speech to the first spoken reply audio. p95 is reported too (§12). It is measured by the operator benchmark (Step 3), never in CI.
- §7.7: "Barge-in: the player can interrupt the Pan. Detected speech stops playback and cancels the in-flight turn." Plan rule (Ruling 10): playback and pending speech are cancelled. A reply already sent to the API is still drawn on screen, because a write may have happened.
- §7.7: "hold-to-talk by default; a hands-free mode with voice activity detection for cook mode." · "Launch with hold-to-talk. Hands-free with barge-in follows once echo handling is tested in browsers."
- §7.7: "**Audio is processed in memory and never stored.** Transcripts are kept only as the conversation text, under the same retention rules as other conversation data." C-18: "no disk, no swap-backed buffers, no logging of audio or partial transcripts. A test greps the service's filesystem and logs after a session … No speaker identification or voiceprints." P-7: "No voiceprints, speaker identification or face analysis, ever."
- §7.7 licensing:
  - "The Piper engine and espeak-ng are GPL-3.0 … never linked into or shipped with our code."
  - "`ryan-high` is non-commercial and **excluded**. Others need a licence check before use."
  - "Kokoro-82M is Apache-2.0, the preferred voice once on GPU."
  - Plan rule: every model is listed in `data/voice-models.json` with its licence, and a test enforces it (Step 2).
- §7.7: "Text mode is always available and is the default where voice isn't permitted (no mic, public place)." Plan rule: voice is off until the player turns it on, and text input never disappears.
- §7.7 alternatives: browser speech is "acceptable as a development stand-in only". Production builds refuse the `browser` adapter (Ruling 1).
- **§19:** "children never talk to the AI." · "Server speech-to-text is off." · "Never stored: … voice."
  - Plan rule (Ruling 9): in Family Table mode, and in a conversation whose child flag is on, the game never calls `getUserMedia`, never opens the voice socket and shows no talk control.
  - The API closes a voice socket whose conversation has the child flag.
- **§16:**
  - "A `usage_events` table that records AI and voice usage and cost per call, without storing content."
  - Free forever: "unlimited voice for players who need it for accessibility."
  - Never rule 7: "the Pan never mentions the Guild unprompted."
  - Never rule 8: "No rewards … for streaks."
  - Plan rule: the voice allowance UI shows only a state (`available`, or `resting` until a date). No minutes left, countdown, meter, progress bar, timer, streak or upsell, in any mode.
- **§20 / C-19:** accessibility voice needs are health data. Plan rule (Ruling 6): the self-declared accessibility setting is sealed per user, needs `health_data`, is exported and deleted, never sits in a plain column and never reaches a prompt or a log. "We never claim 'HIPAA compliant'": the words "HIPAA" and "medical-grade" appear in no copy.
- C-13 and C-15 carry on:
  - the speech-to-text vocabulary hint (rule targets and pantry names only with `health_data`; Step 5) goes to the self-hosted voice service, never to a prompt or a log;
  - the voice service gets no user id;
  - transcripts reach OpenRouter only as M4 turns do, under `ai_health` for health turns.
- **Eval gate (M6 Ruling 22, controller ruling):** core `index.ts`, `mentor/*`, the API's `mentor/*`, `app.ts`, `usage/usage.ts`, `entitlements/entitlements.ts` and `consent/notices.ts` are in `EVAL_FILES`. So `eval-gate.test.ts` fails from Step 1 until Step 7 records **one** passing `npm run eval:mentor` run.
  - Never set `MENTOR_EVAL_GATE=skip-no-network`, on any branch.
  - Steps 1–7 get no PR until that pass.
  - Steps 8–11 must not modify any `EVAL_FILES` path.
- **Tests never touch the network, a microphone, a GPU or model weights.** CI uses fake engines, a fake upstream, the worker's `echo` engine and Chromium's fake media device. The real-model benchmark is an operator script (Step 3).
- **First paint:** every voice module is a lazy chunk (a dynamic import), loaded only once voice is turned on. First paint may grow by at most 2 KB (the Settings toggle and the panel's talk button), asserted by `budget-plugin.test.ts`.
- **No voice logic written twice.** The protocol, `heardCheck`, phonetic keys, speech text, sentence chunking, cook commands and the filler choice live in core `voice/`, exported from both `index.ts` and `engine.ts`.
- **Logs:** `apps/voice` logs only enums and numbers (a typed `logEvent`). The API voice route logs no message body, frame, transcript or hint. Worker stderr is counted, never forwarded.
- New error and close codes go in the doc comment on `ApiError` (`apps/api/src/errors.ts`) and in core `VoiceCloseReason`.
- Constants (tunable, one place each):
  - core `voice/constants.ts`: `SAMPLE_RATE_IN = 16_000`, `FRAME_MS = 20`, `MAX_UTTERANCE_MS = 30_000`, `PRE_ROLL_MS = 300`, `VAD_HANGOVER_MS = 300`, `MIN_SPEECH_MS = 200`, `BARGE_IN_MIN_MS = 250`, `FILLER_AFTER_MS = 600`, `HANDS_FREE_IDLE_MS = 600_000`, `MAX_SPEAK_ITEMS = 8`, `MAX_SPEAK_CHARS = 600`, `HINT_MAX_WORDS = 60`, `MAX_ALTERNATIVES = 3`;
  - API `voice/constants.ts`: `FREE_VOICE_SECONDS_PER_30_DAYS = 3600`, `VOICE_ABUSE_SECONDS_PER_DAY = 21_600`, `VOICE_COST_MICROUSD_PER_SECOND = 25`.

## Review Focus

1. **A misheard food that is itself a real food.** "Rye" heard as "rice", "pecans" as "pea cans", "mussels" as "muscles", "celery" as "salary", "no nuts" as "no nots", or "jalapeño" without its tilde. The heard card must show the word as heard (never auto-corrected), spelled, with the sound-alike as an alternative. Nothing may reach a rule, a check-off or the model before the tap. → Step 1 (the mishearing set's `real_food_swap` group), Step 6 (an HTTP probe per group).
2. **Audio or transcript escaping memory on an error path.** An engine that throws with the transcript in its message, a worker crash, a socket closed mid-utterance, a Fastify error hook serialising the frame, or a core dump. Nothing reaches a file, a log line or GlitchTip. → Step 2 (throwing engine), Step 3 (worker crash, `LimitCORE=0` in the unit file), Step 5 (route error hook).
3. **The Pan hearing itself.** In hands-free mode, TTS output re-enters the mic, or a radio plays in the kitchen. No barge-in comes below the raised threshold or under `BARGE_IN_MIN_MS`, and silence never leaves the device. → Step 8 (VAD with playback-shaped energy), Step 10 (cook-mode loop).
4. **Child or Family Table arriving mid-session.** Family Table is switched on while the mic is open, or a transcript sets the child flag. The mic tracks stop, the socket closes and nothing more is sent, at once. → Step 5 (server close), Step 9 (panel), Step 10 (cook mode).
5. **Voice failing mid-turn.** The voice service is down or slow, the socket drops, or the allowance runs out during an utterance. The player gets a plain line and the text box, the in-flight utterance is finished or dropped (never retried from stored audio), and a turn already sent still shows its cards. → Step 5 (upstream down, resting mid-utterance), Step 9 (socket drop, barge-in with a write).

## Pre-flight

**Gates:**
- **M6 is merged with its final fix wave** (`.superpowers/sdd/README-m6-market/progress.md`, "M6 final review": the fix-wave items, with no eval run). M7 starts from that merge. Re-read `final-review.md` §"Parked items" against the merged code before Step 7. Drop any carry the fix wave already closed, and say so in Step 7's report.
- **The eval hash moves from Step 1.** Steps 1–6 run the whole API suite as is and report `eval-gate.test.ts` failures as expected. Every other API test must pass.
  - Step 7 recomputes `EVAL_FILES`, makes the one implementer eval run (`OPENROUTER_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1`, synthetic data only, no re-roll; a failure is BLOCKED for the controller) and commits `last-pass.json`.
  - Steps 1–7 then merge through one PR.
- **Order:**
  - Step 1 first.
  - After Step 1, Steps 2 → 3 (apps/voice) and Step 4 (API) can run in parallel.
  - Step 5 needs Steps 2 and 4: it reads the cast from Step 2's manifest. Step 6 follows Step 5.
  - Step 7 after 6.
  - Steps 8 → 9 → 10 after Step 7 merges (they need Step 5's socket and Step 6's protocol for their mocks).
  - Step 11 last.
- **[founder]** rulings are dispatched on their defaults unless the founder overrides them before the step that uses them.

Earlier-milestone files each task touches (new files are listed in each step):

| Step | Earlier-milestone files modified |
|---|---|
| 1 | `packages/core/src/index.ts`, `packages/core/src/engine.ts`, `packages/core/src/mentor/protocol.ts` (the `input` union, `ReplyPart` `heard`), `packages/core/test/no-streak.test.ts` (`DIRS` += `voice`) |
| 2 | `knip.json` (the `apps/voice` workspace), `.dependency-cruiser.cjs` (`voice-no-api`, `voice-no-game`), `.gitignore` (`apps/voice/bench/audio/`, `apps/voice/models/`) |
| 3 | `.env.example` (voice service block) |
| 4 | `apps/api/src/db/schema.ts` (`voiceSettings`), `apps/api/src/entitlements/entitlements.ts`, `apps/api/src/mentor/allowance.ts` (comment only), `apps/api/src/consent/{notices,health-data}.ts`, `apps/api/src/account/routes.ts` (export and delete), `apps/api/src/app.ts`, `apps/api/src/errors.ts`, `apps/api/scripts/grant.ts`, `apps/api/test/{entitlements-boundary,account,consent,inventory,free-forever}.test.ts`, `docs/compliance/data-inventory.md` (P-5, V-4, §6) |
| 5 | `apps/api/package.json`, `apps/api/src/{app,config}.ts`, `apps/api/src/mentor/lines.ts` (`lineAt`), `apps/api/src/ai/processors.ts` (reused for the voice host), `apps/api/src/logging/redact.ts`, `apps/api/test/{config,logging,architecture}.test.ts`, `.env.example` |
| 6 | `apps/api/src/mentor/{routes,turn,memory,conversations,writes,proposals}.ts`, `apps/api/src/db/schema.ts` (`PROPOSAL_CHANNELS` += `spoken_yes`), `content/dialogue/pan.yaml` (`voice.*`; `voice.not_yet` removed), `content/README.md`, `apps/api/eval/{cases,run}.ts`, `apps/game/src/mentor/{backend,ai-backend,scripted}.ts` (minimal: `voice.not_yet` → `voice.unavailable`, the `transcript` kind typechecks) |
| 7 | the carry files in step-7.md, `apps/api/eval/{hash,cases,checks}.ts`, `apps/api/test/eval-gate.test.ts`, `apps/api/eval/last-pass.json` |
| 8 | `apps/game/vite.config.ts` (ws proxy, provider check), `apps/game/index.html` (CSP `connect-src`), `apps/game/build/budget-plugin.ts` (+ test), `apps/game/src/state/store.ts` (`settings.voice`), `apps/game/src/mentor/dialogue.ts` (`Said.index`), `apps/game/src/virtual.d.ts` (`ImportMetaEnv.VITE_VOICE_PROVIDER`) |
| 9 | `apps/game/src/mentor/{panel,index,backend,ai-backend,reply,cards-view,child-flag}.ts`, `apps/game/src/settings/{settings-screen,mentor-section}.ts`, `apps/game/src/api/{client,types}.ts`, `apps/game/src/content/{required,voice-allowlist}.ts` |
| 10 | `apps/game/src/cook/{cook-mode,cook-screen,frame-cook}.ts`, `apps/game/src/cook/wake-lock.ts` (hands-free keeps the screen awake) |
| 11 | `apps/game/e2e/{never-rules,free-forever,a11y,screens}.e2e.test.ts`, `apps/game/e2e/screens.ts`, `apps/api/test/free-forever.test.ts`, `docs/compliance/{ROADMAP,data-inventory,dpia,risk-register,processors.json}`, `docs/compliance/notices/voice-v1.md` (lawyer flags only), `content/README.md` (founder list), `README.md` |

## Rulings

The form is `Ruling: <decision> — <why> — <cost if wrong>`. **[founder]** marks the ones the founder should confirm before the step that uses them is dispatched.

1. Ruling: **The voice stack is the spec's working default.** It is a self-hosted STT and TTS service (`apps/voice`, WebSocket) around Qwen via OpenRouter, behind provider interfaces on all three sides. The game's `browser` adapter (Web Speech API) is selectable with `VITE_VOICE_PROVIDER=browser` in development only: `vite build` in production mode fails on it, because Chrome's recogniser sends audio to Google, a processor we have not reviewed. Text is the default. — Spec §15 Q5 is open. §7.7 names this stack and calls browser speech a stand-in. Interfaces keep the choice cheap to reverse. — If the founder picks Qwen realtime (Alibaba Cloud) or browser speech for production, that adds one adapter plus a processor review, a notice and a DPA (C-34). The heard check, speak items and allowance are unchanged. **[founder]**
2. Ruling: **The starting models are as follows.**
   - STT: faster-whisper `base.en`, int8, beam 1, one thread per job, with a vocabulary hint. `tiny.en` and `small.en` are allowed alternatives by config.
   - TTS: Kokoro-82M for the Pan, voice `bm_fable`.
   - CPU fallback cast: Piper `en_GB-northern_english_male-medium` (CC BY-SA 4.0, attribution shown in Settings).
   - Excluded: `en_US-ryan-high` (the manifest lists it with `status: excluded`, and boot refuses it).
   - Lessac, Alan and Amy are `status: unverified` and cannot be cast.
   - Cooks' voices are cast in M10.

   — These are the spike's recommendations, with Kokoro preferred as instructed. — The Pan's voice is an art-direction call: a different Kokoro voice or blend is a one-line cast change, with no code. **[founder]**
3. Ruling: **Hosting and the latency gate.** Phase 1 is one CPU box. Production `apps/voice` refuses to boot unless `apps/voice/bench/latest.json` records a run of the configured stack that meets p50 ≤ 1.5 s and p90 ≤ 2.5 s. The one exception is `VOICE_ACCEPT_LATENCY_MISS=<that run's date>`, which the founder sets after reading the miss. A miss with Kokoro on CPU is the expected signal to move TTS (and `small.en`) to a GPU box, or to cast the Piper fallback. — The spike measured Kokoro on CPU at a p50 of about 2.0 s, and the target needs evidence, not hope. The gate mirrors P-11's "no processor without a review". — If the founder wants voice live before a passing run, they set the acknowledgement. **[founder]**
4. Ruling: **The heard check is the safety gate for speech.** Core `heardCheck(transcript)` returns a check when the transcript names any graph ingredient (name, alias or plural), any rule term, or a word whose phonetic key is within one edit of one of those (the sound-alike search runs only when the transcript also has health wording: `HEALTH_PATTERN`, `RULE_TRIGGER_PATTERN`, `DIET_WORD_PATTERN`, severity words).
   - **The card.** It shows each heard word as heard, spelled (`spell`), with up to `MAX_ALTERNATIVES` sound-alikes. It has three buttons: "Yes, that's what I said", "Say it again" and "Type it instead". Each alternative is a chip. Only a tap goes on, as `input.heard.words`. **A spoken "yes" never confirms a heard card.**
   - **What is spoken.** Spelling is spoken only when the transcript has health wording. Otherwise the names alone are spoken, and the spelling is on screen.
   - **Spoken check-off.** Because ingredient names trigger it, "got the shallots" also needs one tap.
   - **Order.** Emergency and child run first, as for text.

   — §7.6, and the spike: "unhinted ingredient recognition is about half correct and spelled letters are weak". M6 already treats any ingredient name as health. — One extra tap on spoken check-offs. If the founder finds it too heavy, narrowing to health wording plus `isMajorAllergen` names is a core change and needs one eval run. **[founder]**
5. Ruling: **The voice allowance is a state, not a number.**
   - Free: `FREE_VOICE_SECONDS_PER_30_DAYS = 3600` seconds of the player's speech (`voice_stt` units), rolling.
   - Every Guild kind (`GUILD_KINDS`): fair use, meaning only the abuse ceiling.
   - The accessibility setting: unmetered.
   - The abuse ceiling, `VOICE_ABUSE_SECONDS_PER_DAY` (6 h of speech in a rolling day), is the same for everyone and never sold, as M4's M-4.
   - The Pan's speech (`voice_tts`) is recorded for unit economics and never counted against the player.
   - At the limit voice "rests" until a date. The utterance in flight is finished, and text carries on.
   - The resting line never names the Guild.

   — Business doc §C: "60 minutes of voice a month", the Guild "fair-use unlimited", §B.11. Counting the Pan's own talk would charge the player for our verbosity. — The numbers are constants. A calendar month instead of a rolling window is a one-function change. **[founder]**
6. Ruling: **The accessibility need is sealed (C-19).** `voice_settings(user_id pk, sealed, updated_at)` holds `{ accessibility: boolean }`, sealed per user. It needs `health_data`: the toggle shows the Form 3-C consent card inline when that is missing. It is erased by a `health_data` withdraw-with-delete, exported decrypted and deleted with the account. The plain `accessibility_voice` entitlement kind is retired: `grant` refuses it, and a migration deletes any such rows. No real accounts exist yet, so nothing is lost. — The compliance doc says "seal it or keep it out of plain columns". An entitlement row is a plain disability signal. — A player who declines `health_data` gets the free allowance, not unmetered voice. Counsel may prefer a no-consent basis (necessary for the service the player asked for). That would be a change to the consent check only. **[founder]** / **[lawyer]**
7. Ruling: **Hold-to-talk is the default everywhere.**
   - **Hands-free** (VAD, continuous) exists only in cook mode, behind a per-device toggle that is off by default.
   - **Barge-in** works in both modes: pressing talk always stops the Pan, and in hands-free mode speech of `BARGE_IN_MIN_MS` or more above the raised threshold stops it.
   - **Hands-free turns itself off** after `HANDS_FREE_IDLE_MS` (10 min) without speech, when cook mode is left, and when the page is hidden.
   - **Silence never leaves the device:** only frames from `PRE_ROLL_MS` before detected speech to its end are sent.
   - The echo check is a manual browser checklist in `apps/voice/README.md`.

   — The spike: hold-to-talk avoids echo entirely. §7.7: hands-free is for cook mode. — Should the browser checklist fail, hands-free ships hidden. That is one flag, and the code stays.
8. Ruling: **Voice needs a signed-in account.** Allowance, consent and metering are per account, and the voice socket rides the session. Signed out, the talk control is hidden and text works as before. — There is no anonymous allowance to meter. — Signed-out players get no voice until a device allowance exists (not planned).
9. Ruling: **Family Table has no microphone at all in M7.** No talk control, no hands-free toggle, no `getUserMedia` and no socket. `VoiceController` throws if it is constructed in Family Table mode, as the panel already does for the AI backend. §19's on-device fixed commands ("next", "repeat", "timer") are designed in but not built. Core `cookCommand` is the grammar they will use, and `apps/game/src/voice/device-commands.ts` declares the `DeviceCommandRecognizer` interface with no implementation, for M13 after counsel's answer on the biometric question (C-45). — The fixed decision for M7, and the strictest reading of §19 "no voice path to the AI". — Families wait for M13 for spoken commands. **[founder]**
10. Ruling: **Barge-in cancels audio, not writes.** Playback stops, queued speech is dropped and the voice service cancels synthesis. A mentor turn already posted still completes, and its cards and lines are drawn (not spoken), because a grammar check-off may already have ticked. — §7.0: "Every write shows as a small card". Discarding a reply could hide a write. — The player sees one more reply than they "cancelled".
11. Ruling: **Cook mode reads a canon step aloud only when it is safe to.** The API speaks a canon step only when the dish checks ✅ for the player on their local date, with no 🔁 substitution and no stall swap this week. Otherwise it speaks `voice.step_on_screen` (a plain line pointing at the screen). Pantry Frame steps are not read aloud in M7, though the commands work. — Speaking a step's original ingredient when the screen shows a swap would undo a safety label by ear. — Players with swaps hear less. Swap-aware step speech is deferred.
12. Ruling: **A spoken yes is a typed yes.** A transcript that is exactly core's strict yes confirms a non-severe card, through the same `shortReply` guard, with channel `spoken_yes` (a new `PROPOSAL_CHANNELS` value). Severe cards stay tap-only (`tap_required`), and heard cards are tap-only (Ruling 4). — §7.6b.1 "a tap or a confirmed spoken yes for others". The strict yes grammar is the confirmation. — If the founder wants a tap for every voice write, the channel is refused in `writes.ts`, one line.
13. Ruling: **The Pan's prompt and tools are unchanged.** The model is not told a turn was spoken. Transcripts reach it as text, after the heard check. Four transcript cases join the eval (V01–V04). — R9 means only tool calls count, and a smaller prompt change keeps the one eval run focused. — If the eval shows transcript-specific failures, a prompt line is the next step, with a second eval run.
14. Ruling: **The GPL boundary is the process.** Piper runs as its own `piper` binary process. The Kokoro worker (which loads espeak-ng) is our Python file `apps/voice/worker/kq_voice_worker.py`, with a `GPL-3.0-or-later` header. Node code talks to it over stdio only. Nothing GPL is bundled into the game or the API, and no voice-service binary is distributed to anyone. — Spike: "A self-hosted server that is not distributed is fine under GPL; distributing it is not. Needs legal sign-off." — If counsel objects, Kokoro moves to the misaki/espeak-free phonemiser, or Piper is dropped. **[lawyer]**

## Tasks

- [ ] [Step 1 — Core: voice protocol, heard check and the mishearing gate, speech text, cook commands](step-1.md)
- [ ] [Step 2 — apps/voice: the service, engine seam, licence manifest and the memory-only proof](step-2.md)
- [ ] [Step 3 — apps/voice: the Python worker, model pins and the operator latency benchmark](step-3.md)
- [ ] [Step 4 — API: voice consent, the sealed accessibility need (C-19), the voice allowance and usage](step-4.md)
- [ ] [Step 5 — API: the voice socket (session, origin, consent, child, allowance, upstream, speak rendering)](step-5.md)
- [ ] [Step 6 — API: transcript turns, the heard gate, spoken yes and the Pan's voice lines](step-6.md)
- [ ] [Step 7 — M6 batched eval carries and the one eval run](step-7.md)
- [ ] [Step 8 — Game: the voice client (capture, VAD, socket, playback, providers, controller)](step-8.md)
- [ ] [Step 9 — Game: talking to the Pan (hold-to-talk, heard card, fillers, spoken replies, Settings, Family Table)](step-9.md)
- [ ] [Step 10 — Game: hands-free cook mode (VAD loop, commands, step reading, barge-in)](step-10.md)
- [ ] [Step 11 — Voice e2e, never-rules and free-forever sweep, compliance record](step-11.md)

**Deferred, on purpose:**
- cooks' and stall keepers' voices, and casting beyond the Pan (M10 content and art);
- on-device Family Table commands (M13, Ruling 9);
- streaming STT (sherpa-onnx zipformer, the spike's next try) and speculative STT start (only if the benchmark misses on STT time);
- swap-aware step speech and reading Pantry Frame steps (Ruling 11);
- GPU hosting (only on a benchmark miss, Ruling 3);
- real-microphone WER across accents (an operator task, Step 3's `--recordings`; spike open item);
- FDC values for `plum`, `rice_grain`, `squash` and `tortilla` (M10 graph pass, as the M6 final review assigned).
