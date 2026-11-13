# Step 9 — Game: talking to the Pan (hold-to-talk, heard card, fillers, spoken replies, Settings, Family Table)

This step puts voice in the mentor panel and in Settings:
- **Hold to talk.** The panel's "Hold to talk" becomes real. A transcript is shown as the player's bubble, marked spoken.
- **The heard card.** Core `heardCheck` runs on the device before any backend sees the transcript. A hit draws a **heard card**, and only a tap goes on (Ruling 4). A heard part from the server (P7) draws the same card.
- **Spoken replies.** They are exactly what is on screen, as `SpeakItem`s with no text or variables (Ruling 15). The sizzle plays at once, and a scripted filler follows when the reply is slow.
- **Settings → Voice.** It asks for the `voice` consent by tap, and sets the sealed accessibility need. It reports Family Table to the server (Ruling 17).
- **Family Table** shows none of this (Ruling 9).

**Files:**
- Create: `apps/game/src/mentor/{heard-card,voice-turn}.ts` and `apps/game/src/settings/voice-section.ts`, with tests.
- Modify:
  - `apps/game/src/mentor/panel.ts`: the talk button drives the controller. It shows only signed in, in standard mode, with `settings.voice.on`. When voice is off it opens Settings → Voice. It is hidden signed out (Ruling 8) and in Family Table;
  - `apps/game/src/mentor/reply.ts`: `PanItem` += `{ kind: 'heard'; check; utteranceId: number | null; onPick }`, and a server `heard` part maps to it (P7);
  - `apps/game/src/mentor/{index,cards-view,child-flag}.ts`: the child flag closes the controller;
  - `apps/game/src/voice/speak-plan.ts` and its test (P8): a heard item → `{ kind: 'heard', utteranceId }`;
  - `apps/game/src/settings/{settings-screen,mentor-section}.ts`;
  - `apps/game/src/api/{client,types}.ts`: `voiceStatus()`, `setAccessibility(on)`, `setFamilyTable(on)`;
  - `apps/game/src/state/store.ts` subscriber: every change of `settings.familyTable`, and app start while signed in, calls `setFamilyTable` (Ruling 17);
  - `apps/game/src/content/{required,voice-allowlist}.ts`;
  - `content/dialogue/pan.yaml`: the `ui.settings.voice.*` screen copy (not an `EVAL_FILES` path);
  - `apps/game/build/budget-plugin.test.ts`: the final first-paint number (B8).

**Interfaces:**
- Consumes:
  - `VoiceController`, `speakPlan`, `providerKind`, `serviceProvider`, `sizzle` (Step 8);
  - core `heardCheck`, `applyHeardChoice`, `fillerFor`, `FILLER_AFTER_MS`;
  - the `MentorInput` transcript kind (Step 6) and the `voice.*` lines (Step 6);
  - `renderConsentCard` (purpose `voice`);
  - `GET /voice/status`, `PUT /voice/accessibility` (Step 4) and `PUT /voice/family-table` (Step 5).
- Produces:
```ts
// voice-turn.ts — the one path from a transcript to a backend
export async function transcriptTurn(text: string, utteranceId: number, ctx: TurnContext, deps: {
  backend: MentorBackend; graph: IngredientGraph; ruleTerms: readonly RuleTerm[]; dialogue: Dialogue;
}): Promise<PanReply>;
//   '' → voice.didnt_catch; a local heardCheck → a heard item (utteranceId) + voice.heard_check(_spelled), nothing sent;
//   else backend.reply({ kind: 'transcript', text }, ctx)
export function confirmHeard(text: string, check: HeardCheck, choice: readonly (number | null)[], ctx: TurnContext,
  deps: Parameters<typeof transcriptTurn>[3]): Promise<PanReply>;
//   final = applyHeardChoice(...); words = the SERVER's or local check's heard words for `final`
//   (re-run heardCheck on final; when the item came from a server heard part, use that part's words for the unchanged text);
//   backend.reply({ kind: 'transcript', text: final, heard: { words } }, ctx) with a new turnKey
// heard-card.ts
export function renderHeardCard(check: HeardCheck, on: { yes(choice: (number | null)[]): void; again(): void; type(): void }): HTMLElement;
// voice-section.ts
export function voiceSection(store: PlayerStore, client: ApiClient): { el: HTMLElement; stop(): void };
```
- **Settings → Voice** is lazy; only its toggle is in first paint. It holds:
  1. **"Talk out loud".** Turning it on shows the `voice` consent card (tap only).
  2. **"Read the Pan's replies aloud".**
  3. **"Hands-free in cook mode".** Only in builds with `VITE_HANDS_FREE=on` (C9).
  4. **"I need voice to use Kitchen Quest".** It shows Form 3-C inline without `health_data`. The copy says it is never limited by plan, needs no proof, and that a daily fair-use ceiling applies to everyone (C4).
  5. **A state line:** "Voice is ready", "Voice is resting until {weekday, date}" or "Voice is resting for today". Never a number.
  6. **"Voice credits".**

  Signed out, the section says voice needs an account. In Family Table mode the section is absent.
- **One spoken turn:**
  1. Release → the sizzle → transcript.
  2. The bubble "you (spoken)" → `transcriptTurn`.
  3. No reply within `FILLER_AFTER_MS` → speak `fillerFor(text)` as a `line` item.
  4. Reply → draw it, then `controller.say(speakPlan(...))` when `readAloud` is on.
  5. Barge-in → the audio stops; the reply is still drawn (Ruling 10).
  6. A child flag set → the controller closes and the button hides.

- [x] **9.1 Write the failing tests.**
```ts
// voice-turn.test.ts (fake backend)
test('"I can\'t eat sesame" → heard item with utteranceId and voice.heard_check_spelled; backend.reply never called', ...);
test('confirm as heard → backend gets { kind: "transcript", text, heard: { words: ["sesame"] } } with a new turnKey', ...);
test('an alternative chip ("rice" → "rye") sends the replaced text with the re-checked words', ...);
test('a server heard part for a word the device did not flag (an older device graph) renders the card, and confirming sends the server\'s words, which the server accepts (P7)', ...);
test('"next step" → straight to the backend; "" → voice.didnt_catch', ...);
// speak-plan.test.ts (extended, P8)
test('a heard item becomes { kind: "heard", utteranceId }; the plan carries no text or vars anywhere', ...);
// heard-card.test.ts
test('the spelling is shown with an aria-label spelling it; only the buttons confirm (a transcript "yes" does not)', ...);
// panel.test.ts (extended)
test('signed in + voice on: hold → release → bubble marked spoken; a slow reply speaks voice.filler.ledger once; the reply is spoken as reply/card items', ...);
test('barge-in during a reply with a grammar check-off: audio stops, the ticked card and its Undo are drawn (Ruling 10)', ...);
test('Family Table: no talk button, getUserMedia never called; switching Family Table on mid-utterance closes the mic at once and calls PUT /voice/family-table {on:true} (Review Focus 4)', ...);
test('signed out: no talk button; voice off: the button opens Settings → Voice', ...);
test('a reply that sets the child flag closes the controller and hides the button', ...);
test('the socket drops mid-utterance: voice.unavailable once, text box focused, nothing resent (Review Focus 5)', ...);
// voice-section.test.ts
test('voice on shows the voice consent card; Not now leaves it off; granted turns it on', ...);
test('accessibility without health_data shows Form 3-C; on → PUT /voice/accessibility; the copy names the fair-use ceiling', ...);
test('the state line has no digit followed by min/minutes/s/left/remaining, no <progress>, <meter> or role=timer, no "Guild", "upgrade" or "premium"; resting_today reads "for today"', ...);
test('the hands-free toggle is absent unless VITE_HANDS_FREE is on; voice credits list every allowed model\'s attribution', ...);
// budget-plugin.test.ts: first paint ≤ 359.6 KB (Step 7 baseline 357.6 KB + 2 KB, ruling round) with the toggle and the button in (B8)
```
- [x] **9.2 Run** `npm test -w @kitchenquest/game -- voice-turn heard-card speak-plan panel voice-section content budget` → FAIL.
- [x] **9.3 Implement.**
- [x] **9.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, the game build (first paint recorded) → PASS. No `EVAL_FILES` path changed since Step 7.
- [x] **9.5 Commit** `feat(game): talk to the Pan — hold-to-talk, heard card, fillers, spoken replies, Settings → Voice`
