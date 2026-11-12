# Milestone 7: Live voice — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own step file.

**Goal:** The player can talk to the Pan out loud and cook hands-free (spec §7.7, §13 item 7). It runs on a self-hosted speech-to-text and text-to-speech service (`apps/voice`) with browser voice activity detection (VAD), barge-in and a hands-free cook mode. Text stays the default and always works. Every allergen or health word the recogniser hears is spelled back for a tap before it can reach a rule or a card. Audio never leaves memory. Children and Family Table never open the microphone, and the server refuses speech-to-text for them even if a device gets that wrong.

**Architecture:**
- **One provider seam per side.**
  - The game's `VoiceProvider` has two adapters: `service` (the default) and `browser` (Web Speech). `browser` exists only in the dev server; every `vite build` strips and refuses it (Ruling 1, C6).
  - The API's `VoiceUpstream` has two: the real WebSocket client and a test fake.
  - `apps/voice` has its `SttEngine` / `TtsEngine` interfaces: real engines in a Python worker process, plus fakes.
  - Swapping the stack (spec §15 open question 5) means a new adapter, not a new milestone.
- **Path.** Browser mic → AudioWorklet (16 kHz PCM16, 20 ms frames) → browser VAD → `wss://<origin>/api/voice`.
  - The API authenticates the session and checks the Origin, the `voice` consent, the per-user voice block (child flag in any conversation, or a Family Table report) and the allowance.
  - It then proxies frames to `apps/voice` on the private network, under core's upstream protocol. `apps/voice` never sees a user id.
  - faster-whisper turns the audio into a transcript. The game sends the transcript as an ordinary `POST /mentor/turn` with `input.kind: 'transcript'`.
- **Under M4 Ruling R9 the model's text is never shown, so it is never spoken.** A spoken reply is the same scripted lines and card read-backs the panel draws.
  - **What the game sends.** `SpeakItem`s that carry **no variables and no text** (Ruling 15): a var-free line, a part of a server reply (`replyId`), a server card (`proposalId`), the API's own last transcript (`heard`), or a canon step.
  - **What the API does.** It resolves each from data it holds, screens every variable with `filterReply`, and turns over-long or failing items into `voice.check_screen`, never into silence.
  - **The one path to TTS.** Only `renderSpeak` can produce the branded `SpeakableText` that `VoiceLink.speak` takes. **TTS accepts no free text.**
  - The API alone applies `speechText` → `speechChunks`. The service speaks chunks verbatim.
- **Latency.** A turn's reply is known only once the model's tool call returns. The design never streams model text, a deviation from §7.7's pipeline sketch recorded in Ruling 16. So every AI turn hides its latency as §7.6b.8 and the spike describe:
  - a local sizzle earcon at once;
  - a pre-synthesised scripted filler (`voice.filler.ledger` for likely writes, `voice.filler.thinking` otherwise) if the reply is slow.

  Code-routed turns answer in well under a second.
- **Safety.** Core `heardCheck` runs on the device before any backend sees a transcript. The API runs it again before the check-off grammar, the health gate, code cards and the model.
  - A transcript naming any ingredient, rule term or sound-alike of one gets a heard card, which shows the words spelled, with alternatives.
  - The turn goes on only after a tap.
  - A **mishearing test set** of similar-sounding foods, seeded from the spike's real mishearings with a 30% held-out part, is a CI gate.
- **Shared code.** `packages/core/src/voice/` holds everything the device, the API and the voice service must agree on: both wire protocols (browser ↔ API, API ↔ service) with their parsers, the heard check, phonetic keys, speech text and chunking, cook commands and the filler choice.

**Tech Stack:**
- Node 22, Fastify 5.12, drizzle 0.45, Postgres 16, zod 4, Vitest 5, Vite 8 and Playwright 1.63.0 (`page.routeWebSocket`, Chromium's fake media stream).
- New runtime dependencies, each MIT: `@fastify/websocket` 11.x and `ws` 8.x in `apps/api`; `ws` 8.x in `apps/voice`. Pin each exactly at install.
- An operator-only Python 3.11+ worker, pinned in `apps/voice/worker/requirements.txt` and never installed in CI:
  - faster-whisper (MIT), ctranslate2 (MIT), kokoro-onnx (MIT; loads espeak-ng, GPL, inside the worker process), onnxruntime (MIT) and numpy;
  - the separate `piper` binary (GPL-3.0, its own process).
- CI runs the worker's stdlib-only `--engine echo` mode as `python3 -I -S`.

**Spec:** `docs/superpowers/specs/2026-11-09-kitchenquest-design.md`:
- §1.1 (live voice is a working default) and §2.7 ("Talk, don't type");
- §7.0 (writes need a yes; spoken yes), **§7.6 (all)**, §7.6b.1, .2, .4, .5, .8, .9 (binding), **§7.7 (all, including the spike results and licensing)**, §7.5 (failure behaviour);
- §9 (`apps/voice`, data and privacy), **§12 Voice** (the latency benchmark and the allergen mishearing set);
- §13 item 7 and §15 question 5;
- §16 (the free tier's capped voice, `usage_events` without content, "unlimited voice for players who need it for accessibility", never rules 1, 7 and 8);
- **§19 Family Mode** ("Children and the AI", "Server speech-to-text is off", "Never stored … voice", "designed into M3 and M7");
- §20 (accessibility voice needs and transcripts are health data; not HIPAA).

Also:
- `docs/spikes/2026-11-09-voice-latency.md` (all of it);
- `docs/style/voice.md` §0 and §3;
- `docs/business/2026-11-09-value-chain-monetization.md` §B.11 and §C (60 free minutes a month, Guild fair use, accessibility unmetered);
- `docs/compliance/2026-11-09-health-data-compliance.md` C-12, C-15, **C-18, C-19**, C-34, C-38, C-40, P-7, P-9 and P-11;
- `docs/compliance/data-inventory.md` V-1–V-4, P-5, I-1 and U-1;
- `ROADMAP.md`, `dpia.md`, `risk-register.md` (R-15, R-20) and `processors.json`;
- `plans/m6-market/README.md` (Ruling 22 and "spoken check-off by voice (M7)");
- `.superpowers/sdd/README-m6-market/progress.md` and `final-review.md` (the parked eval carries, Step 7);
- `.superpowers/sdd/README-m7-voice/preflight.md` (the 40 pre-flight findings, ruled below).

## Global Constraints

Quoted from the spec unless marked. Every task's requirements include this section and the M2–M6 Global Constraints (`plans/m2-api/README.md` … `plans/m6-market/README.md`).

- **§7.6:** "Speech-to-text output is treated as untrusted user text." · "For rules, the Pan spells out and shows on screen the ingredient it heard ('kiwi, K-I-W-I'), because mishearing an allergen is the worst failure mode." · "Severe rules always need a tap on the on-screen card in addition to the spoken yes."
  - Plan rule (Ruling 4): every transcript naming an ingredient, a rule term or a sound-alike of one is stopped by a **heard card**, confirmed only by a tap, before any rule, card or model call.
- §7.6b.1: "`save_rule` is rejected unless … the yes arrived through the UI: a tap for severe rules, or a tap or a confirmed spoken yes for others."
- §7.6b.2: "Read-backs and allergen spelling come from code, not the model." The spoken spelling of a heard card is rendered by the API from its own transcript with core `spell` (Ruling 15).
- §7.6b.4: "Card taps and system events never arrive as user text." A heard-card tap travels as the structured field `input.heard`. Page-event lookalikes are stripped from transcripts as from text.
- §7.6b.5: "Output filter before display or speech."
  - Plan rule: TTS takes only `SpeakableText`, made only by `renderSpeak` from `SpeakItem`s that carry no text or variables.
  - Every server-held variable passes `filterReply`.
  - A failing or over-long item is spoken as `voice.check_screen`, never dropped silently.
- §7.6b.8: "Tool turns speak a scripted filler line ('Let me write that in the ledger…') while the tool runs."
- §7.7 latency (as revised by the spike): **p50 ≤ 1.5 s and p90 ≤ 2.5 s**, end of speech → first spoken reply audio. p95 is reported too (§12). It is measured by the operator benchmark (Step 3), never in CI.
- §7.7: "Barge-in: the player can interrupt the Pan. Detected speech stops playback and cancels the in-flight turn." Plan rule (Ruling 10): audio is cancelled, and a reply already sent is still drawn.
- §7.7: "hold-to-talk by default; a hands-free mode with voice activity detection for cook mode." · "Launch with hold-to-talk. Hands-free with barge-in follows once echo handling is tested in browsers." Plan rule (Ruling 7, C9): the hands-free control is behind a build flag that the build refuses unless the recorded browser echo checklist passed.
- §7.7: "**Audio is processed in memory and never stored.** Transcripts are kept only as the conversation text, under the same retention rules as other conversation data." C-18: "no disk, no swap-backed buffers, no logging of audio or partial transcripts. A test greps the service's filesystem and logs after a session … No speaker identification or voiceprints." P-7: "No voiceprints, speaker identification or face analysis, ever."
- §7.7 licensing:
  - "The Piper engine and espeak-ng are GPL-3.0 … never linked into or shipped with our code."
  - "`ryan-high` is non-commercial and **excluded**. Others need a licence check before use."
  - "Kokoro-82M is Apache-2.0, the preferred voice once on GPU."
  - Plan rule: every model is in `data/voice-models.json` with its licence, and a test enforces it (Step 2). The GPL boundary is the worker process (Ruling 14).
- §7.7: "Text mode is always available and is the default where voice isn't permitted." Plan rule: voice is off until the player turns it on, and text input never disappears.
- §7.7 alternatives: browser speech is "acceptable as a development stand-in only" (Ruling 1).
- **§19:** "children never talk to the AI." · "Server speech-to-text is off." · "Never stored: … voice."
  - Plan rule (Rulings 9 and 17): in Family Table mode, and once any child flag is set, the game never calls `getUserMedia`, never opens the voice socket and shows no talk control.
  - The API keeps a per-user voice block: a Family Table report from the device, or a child flag in **any** of the user's conversations. The block refuses `hello` (also with `conversationId: null`) and `listen`, and closes every open voice socket of that user.
- **§16:**
  - "A `usage_events` table that records AI and voice usage and cost per call, without storing content."
  - Free forever: "unlimited voice for players who need it for accessibility."
  - Never rule 7: "the Pan never mentions the Guild unprompted."
  - Never rule 8: no streaks.
  - Plan rule: the allowance UI shows only a state (`available`; `resting` until a date; `resting` for today). There is no number, countdown, meter, progress bar, timer, streak or upsell, in any mode.
- **§20 / C-19:** accessibility voice needs are health data (Ruling 6). They are sealed, need `health_data`, are exported and deleted, and never reach a prompt or a log. "We never claim 'HIPAA compliant'": "HIPAA" and "medical-grade" appear in no copy.
- C-13 and C-15 carry on:
  - the STT vocabulary hint (rule targets and pantry names only with `health_data`) goes to the self-hosted service only;
  - the voice service gets no user id;
  - transcripts reach OpenRouter only as M4 turns do.
- **Eval gate (M6 Ruling 22, controller ruling):**
  - Core `index.ts`, `mentor/*`, the API's `mentor/*`, `app.ts`, `usage/usage.ts`, `entitlements/entitlements.ts`, `consent/notices.ts` and the turn's import closure are in `EVAL_FILES`. So `eval-gate.test.ts` fails from Step 1 until Step 7 records **one** passing `npm run eval:mentor` run.
  - Never set `MENTOR_EVAL_GATE=skip-no-network`.
  - Steps 1–7 get one PR, after that pass, with separate commits and PR sections for voice and for the M6 carries (D5).
  - Steps 8–11 must not modify any `EVAL_FILES` path. A decision-code fix found later goes back to its step, and **a second eval run happens only on a controller ruling** (B10).
- **Tests never touch the network, a microphone, a GPU or model weights.** CI uses fake engines, a fake upstream, the worker's `echo` engine and Chromium's fake media device.
- **Absence tests have positive controls (D1):**
  - every "nothing was written or logged" test also runs a deliberately leaking fake and must fail on it;
  - it asserts the flow reached `transcript` / `audio_end`;
  - it compares directory snapshots, not spies alone.
- **Tests state their assertions (D3):** each test title in a step comes with its assertion in the step text. Type-level rules use `// @ts-expect-error` under `tsc`, plus a runtime check.
- **First paint:** voice modules are lazy chunks. First paint may grow by at most 2 KB over M6's end value, asserted in Steps 8 and 9 (B8).
- **No voice logic written twice.** The protocols, `heardCheck`, phonetic keys, speech text, chunking, cook commands and the filler choice live in core `voice/`, exported from `index.ts` and `engine.ts`.
- **Logs:** `apps/voice` logs only enums and numbers (a typed `logEvent`). The API voice route logs no message body, frame, transcript or hint. Worker stderr is counted, never forwarded.
- New error and close codes go in the doc comment on `ApiError` and in core `VoiceCloseReason`.
- Constants (tunable, one place each):
  - core `voice/constants.ts`: `SAMPLE_RATE_IN = 16_000`, `FRAME_MS = 20`, `MAX_UTTERANCE_MS = 30_000`, `PRE_ROLL_MS = 300`, `VAD_HANGOVER_MS = 300`, `MIN_SPEECH_MS = 200`, `BARGE_IN_MIN_MS = 250`, `FILLER_AFTER_MS = 600`, `HANDS_FREE_IDLE_MS = 600_000`, `MAX_SPEAK_ITEMS = 8`, `MAX_SPEAK_CHARS = 600`, `SPEAK_VAR_MAX = 80`, `HINT_MAX_WORDS = 60`, `MAX_ALTERNATIVES = 3`, `RECENT_REPLIES = 8`, `RECENT_REPLY_TTL_MS = 600_000`;
  - API `voice/constants.ts`: `FREE_VOICE_SECONDS_PER_30_DAYS = 3600`, `VOICE_ABUSE_SECONDS_PER_DAY = 21_600`, `VOICE_COST_MICROUSD_PER_SECOND = 25`.

## Review Focus

1. **A misheard food that is itself a real food.** "Rye" heard as "rice", "pecans" as "pea cans", "mussels" as "muscles", "celery" as "salary", "no nuts" as "no nots", "epazote" as "episodes" (spike). The heard card must show the word as heard, spelled, with the sound-alike as an alternative, and nothing may reach a rule, a check-off or the model before the tap. → Step 1 (fixture groups and holdout), Step 6 (HTTP probe per group), Step 7 (eval case V05).
2. **Audio or transcript escaping memory on an error path.** An engine throwing with the transcript in its message, a worker crash, a socket closed mid-utterance, a Fastify error hook, a core dump. → Step 2 (throwing engine plus a leaking positive control), Step 3 (worker crash, `LimitCORE=0` in the voice unit), Step 5 (route error hook).
3. **The Pan hearing itself, or the kitchen.** TTS re-entering the mic in hands-free mode, a cook timer's alarm, a radio. There must be no barge-in below the raised threshold or under `BARGE_IN_MIN_MS`, and silence never leaves the device. → Step 8 (VAD with playback- and alarm-shaped energy), Step 10.
4. **Child or Family Table arriving mid-session, or before any conversation exists.** A child flag in any conversation, or a Family Table report, closes every voice socket of the user. A `hello` with `conversationId: null` is refused while blocked, and the server refuses STT even if the device opens a socket. → Step 5 (registry, both flags), Step 6 (turn sets the block), Steps 9 and 10.
5. **Voice failing mid-turn.** The service down or slow, the socket dropping, or the allowance running out during an utterance. The player gets a plain line and the text box, nothing is retried from stored audio, and a turn already sent still shows its cards. → Step 5, Step 9.

## Pre-flight

**Gates:**
- **M6 is merged with its final fix wave.** Re-read `final-review.md` §"Parked items" against the merged code before Step 7, and drop any carry already closed.
- **The eval hash moves from Step 1.** Steps 1–6 run the API suite and report `eval-gate.test.ts` failures as expected; every other test passes. Step 7 recomputes `EVAL_FILES`, makes the one implementer eval run (`OPENROUTER_API_KEY=proxy-injected NODE_USE_ENV_PROXY=1`, synthetic data, no re-roll; a failure is BLOCKED for the controller) and commits `last-pass.json`.
- **Order:**
  - Step 1 first.
  - After it, Steps 2 → 3 (apps/voice) and Step 4 (API) can run in parallel.
  - Step 5 needs Steps 2 and 4: the cast comes from the manifest, and the upstream protocol test replays core's shared fixture.
  - Step 6 follows Step 5. Step 7 follows Step 6.
  - Steps 8 → 9 → 10 run after Step 7 merges. Step 11 is last.
  - Steps 3 and 5 each own a separately marked `.env.example` block (P14).
- **Dispatch note for Step 7:** the controller confirms whether the `neutral_oil` edges land now (`progress.md` says M7; `final-review.md` line 149 says M10). The default is M7 (B7).
- **[founder]** rulings are dispatched on their defaults unless overridden before the step that uses them.

Earlier-milestone files each task touches (new files are listed in each step):

| Step | Earlier-milestone files modified |
|---|---|
| 1 | `packages/core/src/{index,engine}.ts`, `packages/core/src/mentor/protocol.ts` (`input` union, `ReplyPart` `heard`, `TurnResponse.replyId`), `packages/core/test/no-streak.test.ts`; minimal exhaustive arms so the repo typechecks: `apps/game/src/mentor/{reply,writer,cards-view}.ts`, `apps/api/src/mentor/turn.ts` (B1) |
| 2 | `knip.json`, `.dependency-cruiser.cjs` (`voice-no-api`, `api-no-voice`, `game-no-voice`), `.gitignore`, `.env.example` (block `# Voice service (apps/voice)`) |
| 3 | `.env.example` (the same block: worker variables) |
| 4 | `apps/api/src/db/schema.ts`, `apps/api/src/entitlements/entitlements.ts`, `apps/api/src/mentor/allowance.ts` (comment), `apps/api/src/consent/{notices,health-data}.ts`, `apps/api/src/account/routes.ts`, `apps/api/src/app.ts`, `apps/api/src/errors.ts`, `apps/api/scripts/grant.ts`, `apps/api/test/{entitlements-boundary,account,consent,inventory,free-forever}.test.ts`, `docs/compliance/data-inventory.md`, `docs/business/2026-11-09-value-chain-monetization.md` (the accessibility setting, C7) |
| 5 | `apps/api/package.json`, `apps/api/src/{app,config}.ts`, `apps/api/src/mentor/lines.ts` (`lineAt`), `apps/api/src/ai/processors.ts`, `apps/api/src/logging/redact.ts`, `apps/api/test/{config,logging,architecture}.test.ts`, `.env.example` (block `# Voice (API)`) |
| 6 | `apps/api/src/mentor/{routes,turn,memory,conversations,writes,proposals}.ts`, `apps/api/src/db/schema.ts`, `content/dialogue/pan.yaml`, `content/README.md`, `apps/api/eval/{cases,run,checks}.ts`, `apps/game/src/mentor/{backend,ai-backend,scripted}.ts` (the whole `MentorInput` change, P9) |
| 7 | the carry files in step-7.md, `apps/api/eval/{hash,cases,checks}.ts`, `apps/api/test/{eval-gate,mentor-gate}.test.ts`, `apps/api/eval/last-pass.json`, `apps/voice/bench/run.ts` (`--selftest`) |
| 8 | `apps/game/vite.config.ts`, `apps/game/index.html`, `apps/game/build/budget-plugin.ts` (+ test), `apps/game/src/state/store.ts`, `apps/game/src/mentor/dialogue.ts`, `apps/game/src/virtual.d.ts` |
| 9 | `apps/game/src/mentor/{panel,index,reply,cards-view,child-flag}.ts`, `apps/game/src/voice/speak-plan.ts` (P8), `apps/game/src/settings/{settings-screen,mentor-section}.ts`, `apps/game/src/api/{client,types}.ts`, `apps/game/src/content/{required,voice-allowlist}.ts`, `apps/game/build/budget-plugin.test.ts` |
| 10 | `apps/game/src/cook/{cook-mode,cook-screen,frame-cook,timers,wake-lock}.ts` |
| 11 | `apps/game/e2e/*` (voice, never-rules, free-forever, a11y, screens), `apps/api/test/free-forever.test.ts`, `docs/compliance/{ROADMAP.md,data-inventory.md,dpia.md,risk-register.md,processors.json,2026-11-09-health-data-compliance.md}` (C-19 row, C7), `docs/compliance/notices/voice-v1.md`, `content/README.md`, `README.md` |

## Rulings

The form is `Ruling: <decision> — <why> — <cost if wrong>`. **[founder]** marks those the founder should confirm before the step that uses them is dispatched.

1. Ruling: **The voice stack is the spec's working default.** It is a self-hosted STT/TTS service around Qwen via OpenRouter, behind provider seams on all three sides. The game's `browser` adapter (Web Speech) is selectable with `VITE_VOICE_PROVIDER=browser` **in the dev server only**: its module sits behind `import.meta.env.DEV`, and the `kqVoiceProvider` plugin fails any `vite build` (keyed on `command === 'build'`, whatever the mode) that asks for it. A test greps the built output for `webkitSpeechRecognition`. Text is the default. — Spec §15 Q5 is open. Chrome's recogniser sends audio to Google, an unreviewed processor, and the CSP does not govern it. — If the founder picks another production stack, that is one adapter plus a processor review, a notice and a DPA (C-34). **[founder]**
2. Ruling: **The starting cast is CPU-first (C1).**
   - STT: faster-whisper `base.en`, int8, beam 1, with a vocabulary hint. `tiny.en` and `small.en` are allowed by config, and the benchmark decides between tiny and base.
   - TTS on CPU (the default cast): Piper `en_GB-northern_english_male-medium` (CC BY-SA 4.0, attribution in Settings).
   - The GPU cast: Kokoro-82M `bm_fable` (Apache-2.0), the spec's "preferred voice once on GPU".
   - `ryan-high` is excluded and refused at boot. Lessac, Alan and Amy are unverified and cannot be cast. Cooks are cast in M10.
   - Step 3's first benchmark measures the northern_english_male voice, which the spike never measured.

   — The spike measured Kokoro on CPU at about 2.0 s p50. Even base.en + Piper lessac measured 1.64 s, so the default must be the cheapest stack, and the gate decides the rest. — The Pan's voice is an art-direction call: a cast change, not code. **[founder]**
3. Ruling: **Hosting and the latency gate.** Phase 1 is one CPU box. Production `apps/voice` refuses to boot unless `apps/voice/bench/latest.json` records a run of the configured stack that meets p50 ≤ 1.5 s and p90 ≤ 2.5 s (on `replyAudio`). The one exception is `VOICE_ACCEPT_LATENCY_MISS=<that run's id: date-box-8hex, as the refusal prints>` (amended in Step 3 fix round 1: a bare date could accept a different run), which the founder sets after reading the miss. A miss means moving to `tiny.en`, a GPU box (Kokoro), or the spike's other fallbacks, in order. — Evidence before launch, mirroring P-11. — The founder can acknowledge a miss explicitly. **[founder]**
4. Ruling: **The heard check is the safety gate for speech.**
   - **When it fires:** core `heardCheck` fires on any graph ingredient (name, alias or plural), any rule term, or a word within one phonetic edit of one. Sound-alikes are searched only when health wording is present.
   - **The card:** it shows the words as heard, spelled, with up to `MAX_ALTERNATIVES` alternatives. Its buttons are "Yes, that's what I said", "Say it again" and "Type it instead". **Only a tap confirms it**, as `input.heard.words`; a spoken yes never does.
   - **Speech:** spelling is spoken only with health wording.
   - **Order:** emergency and child checks run first.
   - **Hands-free (D6):** "how thin should the onions be" needs a tap. The narrowing option (gate only when a write or health wording is present) is on the founder list; it is a core change costing one eval run.

   — §7.6, and the spike's "about half correct" ingredient recognition. — One extra tap on spoken check-offs and on food questions in hands-free mode. **[founder]**
5. Ruling: **The voice allowance is a state, not a number (C3, C4).**
   - **The numbers:**
     - free: `FREE_VOICE_SECONDS_PER_30_DAYS = 3600` seconds of the player's speech, rolling;
     - Guild kinds: fair use;
     - the accessibility need: unmetered;
     - the abuse ceiling, `VOICE_ABUSE_SECONDS_PER_DAY` (6 h of speech in 24 h), applies to everyone, accessibility included, and is never sold. The accessibility copy says this ceiling exists (C4).
   - **What counts:** the Pan's speech is recorded (`voice_tts`) but never counted.
   - **At the limit:** the utterance in flight finishes, and the state reads "resting until <date>", or `voice.resting_today` when it lifts the same day (B4). It never names the Guild.
   - **Source:** the business doc §C ("60 minutes of voice a month"), which **deviates from spec §16's "capped daily allowance"**. The spec edit, or a daily cap instead, is the founder's call.

   — A monthly allowance suits occasional cooks, and counting the Pan's talk would charge players for our verbosity. — The constants and the window function change. **[founder]**
6. Ruling: **The accessibility need is sealed (C-19).**
   - **Storage:** `voice_settings(user_id pk, sealed, updated_at)` holds `{ accessibility: boolean }`, sealed.
   - **The row is kept** once the player touches the setting, with `false` sealed when off, so its existence reveals nothing (B4). It is deleted only by a `health_data` withdraw-with-delete or account delete.
   - **Consent:** it needs `health_data`, so the toggle shows Form 3-C inline.
   - **The entitlement kind:** the plain `accessibility_voice` kind is retired (`grant` refuses it; a migration deletes such rows).
   - **Docs:** the business doc and the compliance doc's C-19 text are updated to match (C7).

   — "Seal it or keep it out of plain columns." — A player who declines `health_data` gets the free allowance; counsel may prefer the "necessary for the service" basis. **[founder]** / **[lawyer]**
7. Ruling: **Hold-to-talk is the default.**
   - **Hands-free** is cook mode only, off by default, and reachable only in a build with `VITE_HANDS_FREE=on`. The `kqHandsFree` plugin refuses that flag unless `apps/voice/bench/latest.json` records `manual[]` entries for Chromium, Safari and Firefox, all with `echoBargeInPass: true` (C9).
   - **Barge-in:** pressing talk always stops the Pan. In hands-free mode, speech of `BARGE_IN_MIN_MS` or more above the raised threshold stops it. The threshold is also raised while a cook timer's alarm sounds (B9).
   - **Hands-free turns itself off** after `HANDS_FREE_IDLE_MS`, on leaving cook mode, and on hiding the page.
   - **Silence never leaves the device:** only frames from `PRE_ROLL_MS` before detected speech to its end are sent.

   — §7.7: echo must be tested in browsers first. — Until the checklist passes, only hold-to-talk ships.
8. Ruling: **Voice needs a signed-in account.** There is no anonymous allowance to meter. — Signed-out players have text only.
9. Ruling: **Family Table has no microphone in M7.** There is no talk control, no hands-free control, no `getUserMedia` and no socket. `VoiceController` throws if constructed in Family Table mode. §19's on-device fixed commands are designed in (core `cookCommand`, plus the `DeviceCommandRecognizer` interface with no implementation) and built in M13 after counsel (C-45). — §19, at its strictest. — Families wait for M13 for spoken commands. **[founder]**
10. Ruling: **Barge-in cancels audio, not writes.** A mentor turn already posted completes, and its cards are drawn but not spoken. — §7.0: every write shows a card. — The player sees one more reply than they "cancelled".
11. Ruling: **Cook mode reads a canon step aloud only when it is safe.** The API speaks a step (0-based `step` index, as `stepPlainText` takes, P12) only when the dish checks ✅ on the player's local date with no 🔁 and no stall swap. Otherwise it speaks `voice.step_on_screen`. Pantry Frame steps are not read. — Reading an original ingredient over an on-screen swap would undo a safety label by ear. — Players with swaps hear less.
12. Ruling: **A spoken strict yes confirms non-severe cards** (channel `spoken_yes`). Severe cards and heard cards stay tap-only. — §7.6b.1. — If the founder wants a tap for every voice write, refusing the channel is one line.
13. Ruling: **The Pan's prompt and tools are unchanged.** Transcripts reach the model as text, after the heard check. — R9: only tool calls count. — A transcript-specific failure in the eval leads to a prompt line and a second run, on a controller ruling.
14. Ruling: **The GPL boundary is the worker process (B2).**
    - `apps/voice/worker/kq_voice_worker.py` is `GPL-3.0-or-later` and loads kokoro-onnx and espeak-ng inside its own process. The manifest records them as `boundary: 'in-worker-process'`.
    - Piper is a further separate `piper` process.
    - Node code talks to the worker over stdio only.
    - Nothing GPL is bundled into the game or the API, and no voice binary is distributed.

    — The spike: self-hosted and undistributed is fine, but needs legal sign-off. — If counsel objects, Kokoro moves to an espeak-free phonemiser, or Piper is dropped. **[lawyer]**
15. Ruling (overrides preflight P5): **`SpeakItem`s carry no text and no variables.**
    - **The kinds:**
      - `line` (a var-free trigger and its variant index);
      - `reply` (a `replyId` from `TurnResponse` and a part index, resolved from the API's in-memory `RecentReplies`);
      - `card` (a `proposalId`, whose read-back comes from the sealed `mentor_proposals` row);
      - `heard` (an utterance id, rendered by the API from its own transcript with core `heardCheck` and `spell`);
      - `step`.
    - **Screening:** every variable comes from server-held data, the player's own stored words that already passed R5, and passes `filterReply` again.
    - **Failures:** a variable over `SPEAK_VAR_MAX`, a total over `MAX_SPEAK_CHARS`, or a filter failure turns that item into the scripted `voice.check_screen` ("It's on the screen; read it there."), never into silence.
    - **Device-only lines with variables** (the scripted engine with the AI off, local cards) are spoken as `voice.check_screen` too.

    — A client-supplied variable is free text in the Pan's voice, and a silently dropped spelling would lose the read-back. — AI-off spoken replies are less complete: the screen carries them.
16. Ruling: **The model's text is never streamed or spoken (C5).** This deviates from §7.7's "streamed tokens → sentence chunker" sketch, because M4 Ruling R9 governs. The chunker and the first-clause split apply to scripted lines. The benchmark measures `firstAudio` (earcon or filler) and `replyAudio` separately. The spec edit is a founder action. — R9 is binding. — Free-form spoken answers wait for M8's grounded Q&A.
17. Ruling (overrides preflight P4/C2): **The voice block is per user, and server-held.**
    - **The registry:** `apps/api/src/voice/registry.ts` (no Fastify, no mentor imports) holds, in memory:
      - `child`: set when a child flag is set in **any** of the user's conversations, kept for the child-flag TTL;
      - `familyTable`: set by `PUT /voice/family-table { on }`, which the game calls whenever the setting changes and at every app start signed in; `hello.familyTable: true` sets it too.
    - **While either is set:**
      - `hello` (with any `conversationId`, `null` included) is closed with `child` or `family_table`;
      - `listen` is refused;
      - every open voice socket of the user is closed.
    - **Who imports it:** `mentor/turn.ts` and `voice/routes.ts` both import the registry, so the voice route stays out of the eval closure (P3).

    — §19: "Server speech-to-text is off." A device bug must not open it. — A Family Table device that never reports blocks nothing until it does, so the device rule stays primary. The DPIA records the gap: a device that is wrong and never reported.
18. Ruling (overrides preflight B6): **The eval runner gains a transcript input kind.** A case with `input: { kind: 'transcript', heardConfirmed: true }` sends `heard.words` computed by core `heardCheck(case.text)`, so V01–V04 pass the heard gate and reach the model; a check asserts the model was called. V05 sends an unconfirmed transcript naming a food, and passes only if the model was **not** called and no tool call or card came out. This lives in Step 6 (cases, runner) and Step 7 (checks, the run).

### Pre-flight findings and their rulings (`preflight.md`, 40 findings)

All 40 adopt the scan's proposed ruling unless marked *override*. The step named is where it lands.

| ID | Ruling | Step |
|---|---|---|
| P1 | Core `UpstreamClientMsg` / `UpstreamServerMsg` and parsers; the "API adds nothing" comment is gone. The shared fixture `packages/core/test/fixtures/voice-upstream-session.json` is replayed by an apps/voice integration test (real server, plain `ws` client) and by the API's `wsUpstream` test. `end()` → `{ text }`; the API counts `speechMs` | 1, 2, 5 |
| P2 | The API alone does `speechText` → `speechChunks`; the service speaks chunks verbatim and imports neither | 2, 5 |
| P3 | The registry lives in `voice/registry.ts`, imported by `turn.ts` and `routes.ts`; one small file joins the closure | 5, 6, 7 |
| P4 | *override*, Ruling 17: per-user block; `hello` with `null` checked; any conversation's child flag closes all | 5, 6 |
| P5 | *override*, Ruling 15: no vars or text from the client; server-held vars; `voice.check_screen` fallback, tested | 1, 5, 9 |
| P6 | `Deps.voiceEnabled?: boolean` (default false) feeds `GET /voice/status.enabled`; Step 5 wires it to `config.voice !== null` | 4, 5 |
| P7 | `reply.ts` maps a server `heard` part to a `PanItem` heard; test for a server-only heard card | 9 |
| P8 | Step 9 modifies `speak-plan.ts`: a heard item becomes `{ kind: 'heard', utteranceId }` | 9 |
| P9 | Step 6 does the whole `MentorInput` change (add `transcript`, remove `voice`); Step 9 builds on it | 6, 9 |
| P10 | The controller owns capture, VAD and the socket for both modes (`startHandsFree` in Step 8); Step 10's module is `cook-voice.ts` / `startCookVoice` | 8, 10 |
| P11 | Step 3 modifies `config.ts` (`modelsDir`, `python`, `workers`, `acceptLatencyMiss`, `workerEngine`); `benchGate` in `src/bench-gate.ts`; `main.ts` is a thin `boot()` the test calls | 3 |
| P12 | `step` is 0-based; Step 11 asserts `step: 1` when step 2 is on screen | 1, 10, 11 |
| P13 | Step 7's gate test also sends a transcript and asserts the heard card comes first | 7 |
| P14 | Separate marked `.env.example` blocks for Steps 3 and 5; the README uses Step 2's three rule names | 2, 3, 5 |
| P15 | `bench/run.ts` is unverified until Step 6; Step 7 adds `--selftest` against fake engines and an in-test stub API | 3, 7 |
| B1 | Step 1 adds minimal union arms so 1.4 passes; lupin→"loop in" moves to `split`; "no nuts"→"no nots" added; jalapeño dropped (not a graph node); a `timer_stop` case | 1 |
| B2 | The real boundary is recorded (`in-worker-process`); the licence test skips worker paths until Step 3, then requires them; Step 2 adds its own `.env.example` block | 2, 3 |
| B3 | Echo triggers: hint word `__kq_crash__` crashes the job; text `__kq_long__` streams 10 s. The API unit's `LimitCORE=0` is a manual README duty | 3 |
| B4 | The row is kept with sealed `false`; `voice.resting_today` | 4, 6 |
| B5 | `Rendered` dropped; `end()` per P1; tests for listen-before-hello (`bad_message`) and a missing Origin (`bad_origin`); `ai/processors.ts` listed; `cache` per chunk | 5 |
| B6 | *override*, Ruling 18 | 6, 7 |
| B7 | Files header reworded; M17 dropped ("No change needed now"); `neutral_oil` by controller dispatch note; the case count comes from `cases.ts` | 7 |
| B8 | CSP `connect-src 'self' wss://<KQ_APP_ORIGIN host>` from the build, tested on the built `index.html`; the budget asserted again in Step 9 | 8, 9 |
| B9 | Threshold raised while a timer alarm sounds, tested; Step 10's example is non-food (D6) | 8, 10 |
| B10 | "A second eval run only on a controller ruling" in the README and Step 11 | 11 |
| C1 | Ruling 2: CPU cast Piper northern_english_male, GPU cast Kokoro; the fallback voice is measured first | 2, 3 |
| C2 | *override*, Ruling 17: server-held Family Table / child block | 5 |
| C3 | Ruling 5 cites the business doc and records the deviation from §16 | 4 |
| C4 | The ceiling is kept and named in the accessibility copy (Ruling 5) | 4, 9 |
| C5 | Ruling 16 records the deviation | — |
| C6 | Ruling 1: `command === 'build'`, `import.meta.env.DEV`, a built-output grep | 8 |
| C7 | The business doc and C-19 text are updated | 4, 11 |
| C8 | `--recordings` only from volunteers with a written consent record, deleted after the run, never copied into `results/` | 3 |
| C9 | Ruling 7: the `VITE_HANDS_FREE` build flag, gated on the recorded echo checklist | 8, 10 |
| D1 | Positive controls, flow-reached assertions and directory snapshots in every absence test | 2, 5, 8, 11 |
| D2 | The fixture is seeded from the spike's mishearings; 30% `holdout: true`; each `KNOWN_CONFUSIONS` entry covers ≥ 2 non-holdout rows or cites the spike, and none matches a holdout row (tested) | 1 |
| D3 | Assertions stated in step text; `@ts-expect-error` plus a runtime check | all |
| D4 | Branded `SpeakableText`; the echo engine run as `python3 -I -S`; model ids checked by loading `.env.example` through `loadVoiceConfig`, not by grep | 2, 3, 5 |
| D5 | One eval run, with separate commits and PR sections; the controller reviews the carry set apart | 7 |
| D6 | Ruling 4 kept; Step 10's example changed; narrowing on the founder list | 4, 10, 11 |
| (note) | The scan's "not a git repository" note is ignored, per the controller | — |

## Tasks

- [ ] [Step 1 — Core: voice protocols, heard check and the mishearing gate, speech text, cook commands](step-1.md)
- [ ] [Step 2 — apps/voice: the service, engine seam, licence manifest and the memory-only proof](step-2.md)
- [ ] [Step 3 — apps/voice: the Python worker, model pins and the operator latency benchmark](step-3.md)
- [ ] [Step 4 — API: voice consent, the sealed accessibility need (C-19), the voice allowance and usage](step-4.md)
- [ ] [Step 5 — API: the voice socket, the per-user voice block and server-side speak rendering](step-5.md)
- [ ] [Step 6 — API: transcript turns, the heard gate, spoken yes, the Pan's voice lines, transcript eval cases](step-6.md)
- [ ] [Step 7 — M6 batched eval carries and the one eval run](step-7.md)
- [ ] [Step 8 — Game: the voice client (capture, VAD, socket, playback, providers, controller)](step-8.md)
- [ ] [Step 9 — Game: talking to the Pan (hold-to-talk, heard card, fillers, spoken replies, Settings, Family Table)](step-9.md)
- [ ] [Step 10 — Game: hands-free cook mode (commands, step reading, barge-in, idle off)](step-10.md)
- [ ] [Step 11 — Voice e2e, never-rules and free-forever sweep, compliance record](step-11.md)

**Deferred, on purpose:**
- cooks' and stall keepers' voices (M10);
- on-device Family Table commands (M13, Ruling 9);
- streaming STT (sherpa-onnx zipformer) and speculative STT start (only if the benchmark misses on STT time);
- swap-aware step speech, Pantry Frame step reading, and spoken variables for device-only lines (Rulings 11 and 15);
- GPU hosting (only on a benchmark miss, Ruling 3);
- real-microphone WER across accents (operator, Step 3 `--recordings`);
- FDC values for `plum`, `rice_grain`, `squash` and `tortilla` (M10 graph pass).
