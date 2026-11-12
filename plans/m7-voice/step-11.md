# Step 11 — Voice e2e, never-rules and free-forever sweep, compliance record

Three things close the milestone, as in M6 Step 11:
- **Voice end to end in a real browser.** The tests use Chromium's fake microphone (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`), with `page.routeWebSocket('**/api/voice')` scripting the server.
- **The promises, pinned:** §7.6 spell-back, §7.7 audio never stored and text always available, §16 free forever and never rules 7 and 8, and §19 no microphone for children, across every voice surface in standard and Family Table mode.
- **The compliance record and the founder list.**

**Pre-flight:**
- Steps 1–10 are merged, and Step 7's eval record is in.
- This step must not modify any `EVAL_FILES` path. A decision-code fix found here goes back to its step, and **a second eval run happens only on a controller ruling** (B10).
- The e2e build sets `VITE_HANDS_FREE=on` with a test-only `latest.json` fixture under `e2e/fixtures/voice/`. The gate's path is overridable for tests only.

**Files:**
- Create: `apps/game/e2e/voice.e2e.test.ts`, `apps/game/e2e/voice-fake.ts`, `apps/game/e2e/fixtures/voice/{make.mjs,*.wav,latest.json}`. The clips are tone-shaped synthetic utterances; no human voice.
- Modify:
  - game e2e: `apps/game/e2e/{never-rules,free-forever,a11y}.e2e.test.ts`, `apps/game/e2e/screens.ts`, `apps/game/vitest.e2e.config.ts`;
  - API: `apps/api/test/free-forever.test.ts`;
  - compliance: `docs/compliance/{ROADMAP.md,data-inventory.md,dpia.md,risk-register.md,processors.json}`, `docs/compliance/2026-11-09-health-data-compliance.md` (the C-19 row now names `voice_settings`, C7), `docs/compliance/notices/voice-v1.md` (`[lawyer]` flags only);
  - `content/README.md`, `README.md`.

**What the tests pin:**
- **Voice e2e** (`/api/**` and `/api/voice` mocked; at 400 px and 1280 px):
  1. Settings → Voice → "Talk out loud" → the voice consent card → I agree. `getUserMedia` is called only now.
  2. Hold to talk → the transcript "I'm allergic to sesame" → the heard card shows "S-E-S-A-M-E". No `/mentor/turn` has been sent, and the speak message is `{ kind: 'heard', utteranceId }` with no text or vars.
  3. "Yes, that's what I said" → one `/mentor/turn` with `input.kind: 'transcript'` and `heard.words: ['sesame']` → the rule card. A spoken "yes" to a severe card → `tap_required`'s line.
  4. "got the shallots" → heard card → yes → the check-off card is ticked with an Undo.
  5. A 2 s mocked turn: the sizzle plays and `voice.filler.ledger` is sent before the reply. The reply's speak items are `reply` / `card` items for exactly what is on screen.
  6. Press during the Pan's speech → `cancel` sent, playback stopped, the card still drawn.
  7. Hands-free in cook parippu (✅) → "next" → the second step is on screen and `{ kind: 'step', step: 1 }` is sent (P12). With a 🔁 swap → `voice.step_on_screen`. A Pantry Frame → no step item.
  8. `state: resting` → "Voice is resting until …"; `resting_today` → "for today". The text box works, and no frame is sent after.
  9. Family Table on → `PUT /voice/family-table {on:true}`, no talk button, no hands-free toggle, no `getUserMedia` (init-script spy) and no socket, on every screen in `screens.ts`.
  10. The server closes with `child` or `family_table` → the mic stops and the button is gone.
- **Never rules and no pressure** (every voice surface, every mode):
  - no `role="timer"`, `<progress>` or `<meter>`;
  - no `/\b\d+\s*(s|sec|seconds|min|minutes)\s*(left|remaining)\b/i`, "x of y" or streak word;
  - no `/\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i` in any voice line or state;
  - no "HIPAA" or "medical-grade".
- **Accessibility (axe):** the heard card, Settings → Voice and the pill pass. Hold-to-talk works with Space and Enter.
- **No audio at rest (game, D1):** after the flow, `localStorage`, `sessionStorage`, IndexedDB and Cache Storage hold no transcript string or audio. The service worker caches no `/api/voice`. A positive-control page script that stores a transcript must make the check fail.
- **The production bundle** (built without `import.meta.env.DEV`) contains no `webkitSpeechRecognition` (C6).
- **Free forever (API + game):**
  - zero entitlements with the accessibility need: never resting after 10 h of speech in 30 days;
  - at the free limit: text, cook mode, every safety path, and export and delete still work;
  - the Guild is never named.

**Compliance record:**
- `data-inventory.md`:
  - V-1–V-4 built (memory only, the API route included). The hint is an in-memory health element under `health_data`. There are no partials.
  - `recentReplies` and the per-socket last transcripts are memory-only health elements (Ruling 15).
  - The per-user voice block is in memory, with no content (Ruling 17).
  - P-5 built (`voice_settings`, sealed, kept with `false`).
  - I-1: `spoken` inside the seal, and a heard-gated turn stores nothing.
  - U-1: the voice units. The §2 diagram and §6 columns.
- `processors.json`: `hetzner` adds "voice audio (memory only) and STT vocabulary hints". The browser speech adapter: "not usable in any build (Ruling 1); a processor review is needed first".
- `dpia.md` §6.1, the M7 re-review:
  - voice is the "innovative technology" criterion;
  - biometric-adjacent, with no voiceprint;
  - children never use the mic, and the server refuses it on a Family Table or child block (Ruling 17);
  - **gap:** a Family Table device that is wrong *and* never reported;
  - the residual risks R-15 and R-20;
  - the operator bench recordings (C8).
- `risk-register.md`:
  - R-15 adds the heard check, the mishearing gate and its holdout;
  - R-20 adds the memory-only tests, the positive controls and host hardening;
  - new risks: TTS as a free-text proxy (closed: no text or vars, `SpeakableText`), the Pan hearing itself or a timer (raised thresholds), a mic left open (idle, hidden, pill), a cross-site socket (Origin), the GPL boundary (Ruling 14), and a client lying about Family Table (the server block).
- `ROADMAP.md`:
  - tick C-18 and C-19, and add a ticked **M7 live voice** line;
  - open `[lawyer]` items: the GPL boundary; the accessibility need's basis; in-memory audio and hints as biometric or health processing; the voice notice; volunteer bench recordings;
  - founder actions: run the benchmark and decide CPU or GPU (Ruling 3); the browser echo checklist for `VITE_HANDS_FREE` (Ruling 7); the spec edits for §7.7's streaming sketch (Ruling 16) and §16's daily cap (Ruling 5).

  We never claim HIPAA compliance.
- `content/README.md` founder list:
  - every new `voice.*` trigger, safety ones first;
  - the open **[founder]** rulings (1, 2, 3, 4, 5, 6, 9), with the Ruling 4 narrowing option (D6);
  - the Pan's voice pick, for which a human must listen to samples.

- [ ] **11.1 Write the failing tests** above.
- [ ] **11.2 Run** `npm run test:e2e -w @kitchenquest/game -- voice never-rules free-forever a11y` and `npm test -w @kitchenquest/api -- free-forever` → FAIL where not yet covered.
- [ ] **11.3 Fix copy, never weaken a pattern** (M5 Ruling 24). Write the compliance record and the founder list.
- [ ] **11.4 Run** everything: `npm run typecheck`, `npm run lint`, `npm test` in every workspace, the game build and `npm run test:e2e -w @kitchenquest/game` → PASS. Record first paint, the voice chunk size and the gate state. No `EVAL_FILES` path changed since Step 7.
- [ ] **11.5 Commit** `test(m7): voice sweep — spell-back, no audio at rest, no mic for children, free accessibility voice; compliance record`
