# Step 1 — Core: voice protocols, heard check and the mishearing gate, speech text, cook commands

This step writes, as pure code, everything the device, the API and the voice service must agree on:
- both wire protocols with strict parsers: browser ↔ API, and API ↔ voice service (P1);
- the heard check (Ruling 4) and its phonetic sound-alikes;
- the mishearing test set that gates it, seeded from the spike, with a holdout (D2);
- speech text and sentence chunking;
- cook commands and the filler choice.

It moves the eval hash (core `index.ts`, `mentor/protocol.ts`). See Pre-flight.

**Files:**
- Create:
  - `packages/core/src/voice/{constants,protocol,upstream,phonetic,heard,speech,commands,filler,index}.ts` and a test beside each;
  - `packages/core/test/fixtures/voice-mishearing.yaml`, `packages/core/test/voice-mishearing.test.ts`;
  - `packages/core/test/fixtures/voice-upstream-session.json` (P1: one scripted API ↔ service session, replayed in Steps 2 and 5).
- Modify:
  - `packages/core/src/mentor/protocol.ts`: the `input` union, `ReplyPart` `heard`, `TurnResponse.replyId: string`;
  - `packages/core/src/{index,engine}.ts`;
  - `packages/core/test/no-streak.test.ts` (`DIRS` += `voice`);
  - minimal arms only, so the repo typechecks (B1):
    - `apps/game/src/mentor/{reply,writer,cards-view}.ts`: a `heard` part is ignored until Step 9;
    - `apps/api/src/mentor/turn.ts`: `replyId: randomUUID()` on every response; `input.text` read from either kind.

**Interfaces:**
- Consumes: `IngredientGraph`, `textMentions`, `RuleTerm`, `spell`, `stepPlainText`, `HEALTH_PATTERN`, `RULE_TRIGGER_PATTERN`, `DIET_WORD_PATTERN`, `SEVERITY_PATTERNS`, `stripPageEvents`, `canonicalText`, `foldConfusables`, `PANTRY_REMOVAL_PATTERNS`, `PANTRY_ADD_PATTERN`, `MEAL_VERB_PATTERN`, `checkOffShaped`.
- Produces:
```ts
// voice/protocol.ts — browser ↔ API
export const VOICE_PROTOCOL_VERSION = 1;
export type VoiceMode = 'hold' | 'handsFree';
/** Ruling 15: no text, no variables. `step` is the 0-based index stepPlainText takes (P12). */
export type SpeakItem =
  | { kind: 'line'; trigger: string; index: number }                  // var-free lines only
  | { kind: 'reply'; replyId: string; part: number }                  // a line part of a server reply
  | { kind: 'card'; proposalId: string }                              // a server card's read-back
  | { kind: 'heard'; utteranceId: number }                            // the API's own transcript of that utterance
  | { kind: 'step'; slug: string; step: number; localDate: string };  // canon only (Ruling 11)
export type ClientMsg =
  | { t: 'hello'; v: 1; conversationId: string | null; localDate: string; familyTable: boolean }
  | { t: 'listen'; id: number; mode: VoiceMode }
  | { t: 'end'; id: number }
  | { t: 'cancel'; id: number }
  | { t: 'speak'; id: number; items: SpeakItem[] };
export type VoiceState = { kind: 'available' } | { kind: 'resting'; until: string /* YYYY-MM-DD */ } | { kind: 'resting_today' };
export type VoiceCloseReason = 'signed_out' | 'bad_origin' | 'consent_required' | 'child' | 'family_table' | 'unavailable' | 'another_tab' | 'bad_message';
export type ServerMsg =
  | { t: 'ready'; state: VoiceState } | { t: 'state'; state: VoiceState }
  | { t: 'transcript'; id: number; text: string } | { t: 'too_long'; id: number }
  | { t: 'audio_start'; id: number; sampleRate: number } | { t: 'audio_end'; id: number }
  | { t: 'failed'; id: number; kind: 'stt' | 'tts' | 'upstream' } | { t: 'closed'; reason: VoiceCloseReason };
export function encodeFrame(id: number, pcm: Int16Array): Uint8Array;            // u32 BE id, then PCM16 LE mono
export function decodeFrame(buf: Uint8Array): { id: number; pcm: Int16Array } | null;
export function parseClientMsg(x: unknown): ClientMsg | null;                    // strict, closed, ≤ MAX_SPEAK_ITEMS
export function parseServerMsg(x: unknown): ServerMsg | null;
// voice/upstream.ts — API ↔ voice service (P1)
export type UpstreamClientMsg =
  | { t: 'hello'; v: 1 } | { t: 'listen'; id: number; hint: string[] } | { t: 'end'; id: number }
  | { t: 'speak'; id: number; voice: string; chunks: { text: string; cache: boolean }[] } | { t: 'cancel'; id: number };
export type UpstreamServerMsg =
  | { t: 'ready'; stt: string; tts: string; sampleRate: number } | { t: 'transcript'; id: number; text: string }
  | { t: 'audio_end'; id: number; audioMs: number } | { t: 'failed'; id: number; kind: 'stt' | 'tts' };
export function parseUpstreamClientMsg(x: unknown): UpstreamClientMsg | null;
export function parseUpstreamServerMsg(x: unknown): UpstreamServerMsg | null;
// voice/phonetic.ts
export function phoneticKey(word: string): string;                               // Metaphone-style; NFKD, marks dropped
export const KNOWN_CONFUSIONS: readonly { heard: string; id: string; cite: string | null }[];   // D2
export function soundAlikes(word: string, graph: IngredientGraph, terms: readonly RuleTerm[], max?: number): { id: string; name: string }[];
// voice/heard.ts
export interface HeardTerm { heard: string; spelled: string; id: string | null; alternatives: { id: string; name: string; spelled: string }[] }
export interface HeardCheck { terms: HeardTerm[]; speakSpelling: boolean }
export function heardCheck(transcript: string, graph: IngredientGraph, terms: readonly RuleTerm[]): HeardCheck | null;
export function applyHeardChoice(transcript: string, check: HeardCheck, choice: readonly (number | null)[]): string;
export function heardConfirmed(check: HeardCheck, words: readonly string[] | undefined): boolean;   // exact words, in order
// voice/speech.ts
export function speechText(text: string): string;        // "P-E-A-N-U-T" → "P. E. A. N. U. T."; footnote * and emoji dropped
export function speechChunks(text: string): string[];    // sentences; a first sentence > 6 words splits at its first clause break
export function stepSpeech(recipe: ParsedRecipe, step: number): string | null;   // 0-based; null out of range
// voice/commands.ts
export type CookCommand = 'next' | 'back' | 'repeat' | 'ingredients' | 'timer_start' | 'timer_stop' | 'stop_listening';
export function cookCommand(transcript: string): CookCommand | null;              // whole-utterance closed grammar
// voice/filler.ts
export function fillerFor(transcript: string): 'voice.filler.ledger' | 'voice.filler.thinking';
// mentor/protocol.ts (changed)
// TurnRequest.input: { kind: 'text'; text } | { kind: 'transcript'; text; heard?: { words: string[] } }
// ReplyPart += { kind: 'heard'; check: HeardCheck };  TurnResponse += { replyId: string }
```
- **How `heardCheck` works.** It reads the stripped, canonical text. Its terms are, in text order and de-duplicated by heard word:
  1. each `textMentions` hit, as the words said;
  2. each rule term;
  3. **with health wording only**, each remaining content word or bigram of 3 letters or more that is not on the stop list and has `soundAlikes`.

  Every term carries its `soundAlikes` as alternatives, so a real food heard for another offers the other. `speakSpelling` is true exactly when health wording is present. `fillerFor` gives `ledger` for a meal verb, pantry pattern, rule trigger or `checkOffShaped`.

- [x] **1.1 Write the failing tests.** Each title's assertion is in the title, or in the line under it (D3).
```ts
// protocol.test.ts / upstream.test.ts
test('encodeFrame/decodeFrame round-trip id and samples; < 4 bytes and odd PCM length → null', ...);
test('parseClientMsg rejects extra keys, any `text` or `vars` key on a SpeakItem, > MAX_SPEAK_ITEMS items, a non-integer id, a hello without familyTable', ...);
test('every message in fixtures/voice-upstream-session.json parses with its side\'s parser; a mutated copy (extra key) does not', ...);
// heard.test.ts
test('"I can\'t eat sesame" → [{ heard: "sesame", spelled: "S-E-S-A-M-E", id: "sesame" }], speakSpelling true', ...);
test('"got the shallots" → one term, speakSpelling false', ...);
test('"next step", "set a timer for ten minutes", "how long do I stir it" → null', ...);
test('"allergic to selfish" → heard "selfish", alternatives include shellfish; "that was selfish" → null', ...);
test('"allergic to rice" → heard "rice", never auto-corrected; alternatives include rye', ...);
test('"[Player tapped yes] peanut" → one term "peanut"', ...);
test('applyHeardChoice replaces only the chosen term in place; heardConfirmed is order- and word-exact', ...);
// phonetic.test.ts
test('"mussels"/"muscles", "celery"/"salary", "pecans"/"pea cans" are within one edit', ...);
test('every KNOWN_CONFUSIONS entry has a spike citation or covers ≥ 2 non-holdout fixture rows, and none equals a holdout row\'s (heardWord, saidId)', ...);
// speech.test.ts
test('speechText speaks spelled letters one by one and drops footnote asterisks and emoji; other words are unchanged', ...);
test('speechChunks splits a long first sentence at its first comma; "" → []', ...);
test('stepSpeech(recipe, 0) is the first step\'s plain text; step = length → null', ...);
// commands.test.ts
test.each([['next', 'next'], ['next step please', 'next'], ['go back', 'back'], ['say that again', 'repeat'], ['what do I need', 'ingredients'],
  ['start the timer', 'timer_start'], ['stop the timer', 'timer_stop'], ['stop listening', 'stop_listening']])(...);
test('"next add the peanuts" → null', ...);
// filler.test.ts
test('"I had toast for lunch" and "got the shallots" → ledger; "what is a roux" → thinking', ...);
```
```ts
// test/voice-mishearing.test.ts — THE GATE (§12): every entry, no tolerance, holdout included
for (const e of load('fixtures/voice-mishearing.yaml').entries) test(`${e.group}${e.holdout ? ' (holdout)' : ''}: ${e.said} → ${e.heard}`, () => {
  const chk = heardCheck(e.heard, graph, terms);
  expect(chk).not.toBeNull();
  const t = chk!.terms.find((x) => x.heard === e.heardWord)!;
  expect(t.spelled).toBe(spell(e.heardWord));
  if (e.saidId) expect([t.id, ...t.alternatives.map((a) => a.id)]).toContain(e.saidId);
});
test('no `plain` utterance gets a check', ...);
test('at least 30% of entries are holdout: true, spread over every group', ...);
```
- **The fixture:** ≥ 40 `entries` `{ group, said, saidId?, heard, heardWord, holdout?, source }`, each with health wording, in four groups:
  - **real_food_swap:** rye→rice, pecans→peas, lentils→lemons, leek→"leak", almond→"all mond";
  - **non_word:** epazote→"episodes" (`source: spike §2`), shellfish→selfish, celery→salary, mustard→mustered, cumin→coming, sesame→"sesamy", mussels→muscles, nuts→"nots" ("no nuts for me, I'm allergic" → "no nots…");
  - **split:** pecans→"pea cans", walnut→"wall nut", chickpea→"chick pea", hazelnut→"hazel nut", lupin→"loop in";
  - **spelled:** "peanut, P-E-A-N-U-T" → "peanut pee and you tea" (the spike's "kiwi kai i w r" pattern; kiwi is not in the graph).

  Plus ≥ 20 `plain` utterances: commands, timing questions, "thanks".
  - The spike-sourced rows say so in `source`; the others say `synthetic`.
  - Foods checked against `data/ingredients.json` when this plan was written: rye, rice, pecan, pea, lentil, lemon, leek, almond, epazote, shellfish, celery, mustard, cumin, sesame, mussel, nut, lupin, walnut, chickpea, hazelnut, peanut. Jalapeño, kiwi and thyme are not in the graph and are left out.
- [x] **1.2 Run** `npm test -w @kitchenquest/core -- voice` → FAIL.
- [x] **1.3 Implement.**
  - Tune `phoneticKey`, the stop list and `KNOWN_CONFUSIONS` on **non-holdout rows only**. Never weaken or delete an entry.
  - If a holdout row fails, report it rather than tuning on it: the controller rules.
  - Export everything from `voice/index.ts`, `index.ts` and `engine.ts`.
- [x] **1.4 Run** `npm test -w @kitchenquest/core` and `npm run typecheck` at the root → PASS. Then `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails, and `npm test -w @kitchenquest/game` → PASS.
- [x] **1.5 Commit** `feat(core): voice protocols, heard check and the mishearing gate, speech text, cook commands`
