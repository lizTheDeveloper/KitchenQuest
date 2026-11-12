# Step 9 — Game: talking to the Pan (hold-to-talk, heard card, fillers, spoken replies, Settings, Family Table)

This step puts voice in the mentor panel and in Settings:
- **The talk button.** The panel's "Hold to talk" stub (`voice.not_yet` until Step 6) becomes the real thing.
- **Transcripts.** A transcript is shown as the player's bubble, marked spoken. Before any backend sees it, core `heardCheck` runs on the device. A hit draws a **heard card**, and only a tap goes on (Ruling 4).
- **Spoken replies.** They are exactly what is on screen (`speakPlan`), with the sizzle at once and a scripted filler when the reply is slow (§7.6b.8).
- **Settings → Voice.** Turning voice on asks for the `voice` consent by tap.
- **Accessibility.** The need is set there, sealed (Ruling 6).
- **No upsell, no countdown.** The state is shown as words, never a number.
- **Family Table.** It shows none of it (Ruling 9).

**Files:**
- Create: `apps/game/src/mentor/heard-card.ts` (+ test), `apps/game/src/mentor/voice-turn.ts` (+ test), `apps/game/src/settings/voice-section.ts` (+ test).
- Modify:
  - `apps/game/src/mentor/panel.ts`: the talk button drives the controller, and is shown only when signed in, in standard mode, with `settings.voice.on`. Otherwise "Hold to talk" opens Settings → Voice, signed in; it is hidden signed out (Ruling 8) and in Family Table;
  - `apps/game/src/mentor/{index,reply,cards-view,child-flag}.ts`: `PanItem` += `{ kind: 'heard'; check: HeardCheck; onPick(choice): Promise<PanReply> }`; the child flag closes the controller;
  - `apps/game/src/mentor/{backend,ai-backend}.ts`: `MentorInput` += `{ kind: 'transcript'; text; heard?: { words } }`; the AI backend sends it as `input.kind: 'transcript'`; the scripted engine treats a confirmed transcript as text; `{ kind: 'voice' }` is removed;
  - `apps/game/src/settings/{settings-screen,mentor-section}.ts`: mount the Voice section after The Pan;
  - `apps/game/src/api/{client,types}.ts`: `voiceStatus()`, `setAccessibility(on)`;
  - `apps/game/src/content/{required,voice-allowlist}.ts`: the new copy;
  - `content/dialogue/pan.yaml` `ui.settings.voice.*` screen copy. This is game copy, not an `EVAL_FILES` path, and Step 6 already added the spoken triggers.

**Interfaces:**
- Consumes: `VoiceController`, `speakPlan`, `providerKind`, `serviceProvider`, `browserProvider`, `sizzle` (Step 8); core `heardCheck`, `applyHeardChoice`, `fillerFor`, `FILLER_AFTER_MS`; `voice.*` lines (Step 6); `renderConsentCard` (purpose `voice`); `GET /voice/status`, `PUT /voice/accessibility` (Step 4).
- Produces:
```ts
// voice-turn.ts — the one path from a transcript to a backend
export async function transcriptTurn(text: string, ctx: TurnContext, deps: {
  backend: MentorBackend; graph: IngredientGraph; ruleTerms: readonly RuleTerm[]; dialogue: Dialogue;
}): Promise<PanReply>;
//   '' → voice.didnt_catch; heardCheck → a reply holding the heard item and voice.heard_check(_spelled), nothing sent;
//   else backend.reply({ kind: 'transcript', text }, ctx)
export function confirmHeard(text: string, check: HeardCheck, choice: readonly (number | null)[], ctx: TurnContext, deps: Parameters<typeof transcriptTurn>[2]): Promise<PanReply>;
//   final = applyHeardChoice(text, check, choice); words = heardCheck(final)?.terms.map((t) => t.heard) ?? [];
//   backend.reply({ kind: 'transcript', text: final, heard: { words } }, ctx)  — a NEW turnKey
// heard-card.ts
export function renderHeardCard(check: HeardCheck, on: { yes(choice: (number | null)[]): void; again(): void; type(): void }): HTMLElement;
//   each term: the heard word, its spelling in large type (aria-label spells it letter by letter), alternative chips;
//   buttons "Yes, that's what I said", "Say it again", "Type it instead"; plain wording, no joke (voice §0.8)
// voice-section.ts
export function voiceSection(store: PlayerStore, client: ApiClient): { el: HTMLElement; stop(): void };
```
- **What Settings → Voice holds.** It is a lazy section, and only its toggle is in first paint.
  1. "Talk out loud". Turning it on shows the `voice` consent card (tap only, P-4). Granted → `settings.voice.on = true`. Not now → it stays off.
  2. "Read the Pan's replies aloud" (`readAloud`).
  3. "Hands-free in cook mode" (`handsFree`, Ruling 7).
  4. "I need voice to use Kitchen Quest". This is the accessibility need. It shows the Form 3-C `health_data` card inline when that is missing (Ruling 6), and the copy says it is never limited and needs no proof.
  5. Its state line: "Voice is ready" or "Voice is resting until {weekday, date}". Never minutes, a bar or a countdown.
  6. "Voice credits": the attribution of each allowed model in `data/voice-models.json`, bundled by the content build.

  Signed out, the section says voice needs an account, and nothing else. In Family Table, the section is absent.
- **One spoken turn.**
  1. Release: the sizzle, phase `transcribing`.
  2. Transcript: the bubble "you (spoken)", then `transcriptTurn`.
  3. No reply within `FILLER_AFTER_MS`: speak `fillerFor(text)` (cached on the service). Without `readAloud`, none.
  4. Reply: render as today, then `controller.say(speakPlan(...))` when `readAloud` is on.
  5. Barge-in while waiting or speaking: the audio stops, and the reply is still drawn when it lands (Ruling 10).
  6. A child flag set by the reply: the controller closes (`child`), and the button hides for that conversation.

- [ ] **9.1 Write the failing tests.**
```ts
// voice-turn.test.ts (fake backend)
test('"I can\'t eat sesame" → heard item, voice.heard_check_spelled, backend.reply never called', ...);
test('confirm as heard → backend gets { kind: "transcript", text, heard: { words: ["sesame"] } } with a new turnKey', ...);
test('an alternative chip ("rice" → "rye") sends the replaced text, and its words are the re-checked ones', ...);
test('"next step" → straight to the backend, no heard item; "" → voice.didnt_catch', ...);
// heard-card.test.ts
test('the spelling is shown and its aria-label spells it; no button is "yes" by voice (the card ignores transcripts)', ...);
// panel.test.ts (extended)
test('signed in + voice on: hold → release → transcript bubble marked spoken; a slow reply speaks voice.filler.ledger once; the reply is spoken from speakPlan', ...);
test('barge-in during a reply with a grammar check-off: audio stops, the ticked card and its Undo are still drawn (Ruling 10, Review Focus 5)', ...);
test('Family Table: no talk button, no hands-free control, getUserMedia never called; switching Family Table on mid-utterance closes the mic at once (Review Focus 4)', ...);
test('signed out: no talk button; voice off: the button opens Settings → Voice', ...);
test('a reply that sets the child flag closes the controller and hides the button for the conversation', ...);
test('the socket drops mid-utterance: voice.unavailable once, the text box focused, nothing resent (Review Focus 5)', ...);
// voice-section.test.ts
test('turning voice on shows the voice consent card; Not now leaves it off; granted turns it on', ...);
test('the accessibility toggle without health_data shows the Form 3-C card; on → PUT /voice/accessibility', ...);
test('the state line never contains a digit followed by min/minutes/s/left/remaining, a <progress>, <meter> or role=timer, nor "Guild", "upgrade" or "premium"', ...);
test('voice credits list every allowed model with an attribution', ...);
```
- [ ] **9.2 Run** `npm test -w @kitchenquest/game -- voice-turn heard-card panel voice-section content` → FAIL.
- [ ] **9.3 Implement.**
- [ ] **9.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, `npm run build -w @kitchenquest/game` (first paint within budget) → PASS. `git diff --stat` since Step 7 shows no `EVAL_FILES` path.
- [ ] **9.5 Commit** `feat(game): talk to the Pan — hold-to-talk, heard card, fillers, spoken replies, Settings → Voice`
