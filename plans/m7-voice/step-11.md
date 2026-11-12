# Step 11 — Voice e2e, never-rules and free-forever sweep, compliance record

Three things close the milestone, as in M6 Step 11:
- **Voice end to end** in a real browser. This uses Chromium's fake microphone (`--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`) and `page.routeWebSocket('**/api/voice')` scripting the server. The spec asks for Playwright flows and an accessibility check on all HTML panels (§12).
- **The promises, pinned.** These are §7.6 spell-back, §7.7 audio never stored and text always available, §16 free forever (accessibility voice) and never rules 7 and 8, and §19 no microphone for children, across every voice surface in standard and Family Table mode.
- **The compliance record** (C-18, C-19, DPIA, processors, risk register) and the founder review list.

**Pre-flight:** Steps 1–10 are merged, and Step 7's eval record is in. This step must not modify any `EVAL_FILES` path. A fix to decision code found here goes back to its step, with one eval run.

**Files:**
- Create:
  - `apps/game/e2e/voice.e2e.test.ts`;
  - `apps/game/e2e/voice-fake.ts`: the scripted socket;
  - `apps/game/e2e/fixtures/voice/*.wav`: three 16 kHz clips of a tone-shaped "utterance" with silences, made by a script in `e2e/fixtures/voice/make.mjs` (no human voice).
- Modify: `apps/game/e2e/{never-rules,free-forever,a11y}.e2e.test.ts`, `apps/game/e2e/screens.ts`, `apps/game/vitest.e2e.config.ts` (the Chromium flags); `apps/api/test/free-forever.test.ts`; `docs/compliance/{ROADMAP.md,data-inventory.md,dpia.md,risk-register.md,processors.json}`; `docs/compliance/notices/voice-v1.md` (`[lawyer]` flags only); `content/README.md` (the founder review list); `README.md` (voice: running `apps/voice`, `.env` blocks, the benchmark, Settings → Voice).

**What the tests pin:**
- **Voice e2e** (mocked `/api/**` and `/api/voice`, at 400 px and 1280 px):
  1. Signed in, Settings → Voice → "Talk out loud" → the voice consent card → I agree. `getUserMedia` is asked only now.
  2. The Pan panel → hold to talk → the scripted transcript "I'm allergic to sesame" → the heard card shows "S-E-S-A-M-E". No `/mentor/turn` request has been sent yet.
  3. Tap "Yes, that's what I said" → one `/mentor/turn` whose body has `input.kind: 'transcript'` and `heard.words: ['sesame']` → the rule card. A severe card needs its tap; a spoken "yes" transcript is refused with `tap_required`'s line.
  4. "got the shallots" → heard card → yes → the check-off card is ticked with an Undo.
  5. A slow mocked turn (2 s): the sizzle and `voice.filler.ledger` speak items are sent before the reply, and the reply's speak items equal what is on screen.
  6. Press during the Pan's speech: a `cancel` is sent and playback stops. The turn's card is still drawn.
  7. Cook parippu (✅) with hands-free: "next" → step 2 is shown and a `step` speak item is sent. With a 🔁 swap → `voice.step_on_screen`. A Pantry Frame → no step item.
  8. The mocked `state: resting` → "Voice is resting until …", the text box works, and no frame is sent after it.
  9. Family Table on → no talk button, no hands-free toggle, no `getUserMedia` call (init-script spy) and no socket, in every screen of `screens.ts`.
  10. The socket is closed by the server with `child` → the mic stops and the button is gone for that conversation.
- **Never rules and no pressure (game e2e):** on every voice surface (panel, heard card, Settings → Voice, the cook pill), in every mode, there is:
  - no `role="timer"`, `<progress>` or `<meter>`;
  - no `/\b\d+\s*(s|sec|seconds|min|minutes)\s*(left|remaining)\b/i`, no "x of y", no streak word;
  - no `/\b(guild|upgrade|subscri\w*|premium)\b|\$\s?\d/i` in any voice line or state (never rule 7);
  - no "HIPAA" or "medical-grade".
- **Accessibility (axe):** the heard card, Settings → Voice and the Listening pill pass. Hold-to-talk works with Space and Enter. The heard card's spelling has an aria-label spelling it.
- **No audio at rest (game):** after the full flow, `localStorage`, `sessionStorage`, IndexedDB and the Cache Storage hold no transcript string and no audio. The service worker caches no `/api/voice` response. Checked with `page.evaluate`.
- **Free forever (API + game):** a player with zero entitlements:
  - with the accessibility need is never resting after 10 h of speech in 30 days;
  - at the free limit keeps text, cook mode, every safety path and export / delete;
  - never sees the Guild named on any voice line.

**Compliance record:**
- `data-inventory.md`:
  - V-1–V-4 built: memory only, the API route included; the hint as an in-memory health element under `health_data`; partials none;
  - P-5 built (`voice_settings`, sealed);
  - I-1: transcripts are stored as conversation text with `spoken` inside the seal, and a heard-checked turn stores nothing until confirmed;
  - U-1: the `voice_stt` / `voice_tts` units;
  - the §2 diagram: the voice service behind the API, private;
  - the §6 columns.
- `processors.json`: the `hetzner` entry's purpose and data categories add "voice audio (memory only, never stored) and speech-to-text vocabulary hints". There is no new processor. The browser speech adapter is noted as "not used in production (Ruling 1); a processor review is needed before it is".
- `dpia.md` §6.1, the M7 re-review (N-11):
  - voice is the "innovative technology" criterion;
  - biometric-adjacent but no voiceprint (P-7, BIPA/CUBI);
  - the mic is never used by children (§19);
  - the residual risks are R-15 (mishearing) and R-20.
- `risk-register.md`:
  - R-15 adds the heard check and the mishearing gate;
  - R-20 adds the memory-only tests and host hardening;
  - new risks: TTS as a free-text proxy (closed: speak items only), the Pan hearing itself (VAD raise + min duration), a mic left open (idle off, hidden off, pill), a cross-site socket (Origin check) and the GPL boundary (Ruling 14).
- `ROADMAP.md`:
  - tick **C-18** and **C-19** with the steps that landed them;
  - add a ticked **M7 live voice** line in the M5 and M6 style;
  - add open `[lawyer]` items:
    - the GPL process boundary (Ruling 14);
    - the accessibility need's basis (Ruling 6: consent vs necessary for the service);
    - whether in-memory audio and STT hints are biometric or health processing in any launch state;
    - the voice notice wording;
  - add a founder action: run the latency benchmark on the target box and decide CPU vs GPU (Ruling 3).

  We never claim HIPAA compliance.
- `content/README.md` founder list: every new `voice.*` trigger (`ai: never`, safety ones first), the open **[founder]** rulings (1, 2, 3, 4, 5, 6, 9), and the Pan's voice pick (Ruling 2: a human must listen to the samples, as the spike's open item says).

- [ ] **11.1 Write the failing tests** above.
- [ ] **11.2 Run** `npm run test:e2e -w @kitchenquest/game -- voice never-rules free-forever a11y` and `npm test -w @kitchenquest/api -- free-forever` → FAIL where not yet covered.
- [ ] **11.3 Fix copy, never weaken a pattern** (M5 Ruling 24). Write the compliance record and the founder list.
- [ ] **11.4 Run** everything: `npm run typecheck`, `npm run lint`, `npm test` in every workspace, `npm run build -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS. Record first paint, the voice chunk size and the eval gate state in the report. `git diff --stat` since Step 7 shows no `EVAL_FILES` path.
- [ ] **11.5 Commit** `test(m7): voice sweep — spell-back, no audio at rest, no mic for children, free accessibility voice; compliance record`
