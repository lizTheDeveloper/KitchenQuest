# Step 1 — Core: voice protocol, heard check and the mishearing gate, speech text, cook commands

Everything the device, the API and the voice service must agree on, as pure code: the wire protocol, the heard check (Ruling 4) and its phonetic sound-alikes, the mishearing test set that gates it, speech text (spelled letters said as letters), sentence chunking for TTS, the hands-free cook commands and the filler choice. This moves the eval hash (core `index.ts`, `mentor/protocol.ts`); see Pre-flight.

**Files:**
- Create:
  - `packages/core/src/voice/constants.ts` (the README's core constants);
  - `packages/core/src/voice/protocol.ts`, `voice/phonetic.ts`, `voice/heard.ts`, `voice/speech.ts`, `voice/commands.ts`, `voice/filler.ts`, `voice/index.ts`;
  - tests beside each (`*.test.ts`);
  - `packages/core/test/fixtures/voice-mishearing.yaml`, `packages/core/test/voice-mishearing.test.ts` (reads the fixture with `node:fs`, so it lives in `test/`).
- Modify: `packages/core/src/mentor/protocol.ts`, `packages/core/src/index.ts`, `packages/core/src/engine.ts`, `packages/core/test/no-streak.test.ts` (`DIRS` += `voice`).

**Interfaces:**
- Consumes: `IngredientGraph` (`labels`, `resolve`, `name`), `textMentions`, `RuleTerm`, `spell`, `stepPlainText`, `HEALTH_PATTERN`, `RULE_TRIGGER_PATTERN`, `DIET_WORD_PATTERN`, `SEVERITY_PATTERNS`, `stripPageEvents`, `canonicalText`, `foldConfusables`, `classifyTurn`, `PANTRY_REMOVAL_PATTERNS`, `PANTRY_ADD_PATTERN`, `MEAL_VERB_PATTERN`, `checkOffShaped`.
- Produces:
```ts
// voice/protocol.ts — browser ↔ API and API ↔ voice service share these shapes (the API adds nothing)
export const VOICE_PROTOCOL_VERSION = 1;
export type VoiceMode = 'hold' | 'handsFree';
export type SpeakItem =
  | { kind: 'line'; trigger: string; index: number; vars: Record<string, string> }
  | { kind: 'step'; slug: string; step: number; localDate: string };   // canon only (Ruling 11)
export type ClientMsg =
  | { t: 'hello'; v: 1; conversationId: string | null; localDate: string }
  | { t: 'listen'; id: number; mode: VoiceMode }
  | { t: 'end'; id: number }
  | { t: 'cancel'; id: number }                                        // barge-in: drop this utterance or this speech
  | { t: 'speak'; id: number; items: SpeakItem[] };
export type VoiceState = { kind: 'available' } | { kind: 'resting'; until: string /* YYYY-MM-DD */ };
export type VoiceCloseReason = 'signed_out' | 'bad_origin' | 'consent_required' | 'child' | 'unavailable' | 'another_tab' | 'bad_message';
export type ServerMsg =
  | { t: 'ready'; state: VoiceState }
  | { t: 'state'; state: VoiceState }                                  // e.g. resting after this utterance
  | { t: 'transcript'; id: number; text: string }                      // '' when nothing was heard
  | { t: 'too_long'; id: number }                                      // MAX_UTTERANCE_MS reached; transcribed so far
  | { t: 'audio_start'; id: number; sampleRate: number }
  | { t: 'audio_end'; id: number }
  | { t: 'failed'; id: number; kind: 'stt' | 'tts' | 'upstream' }
  | { t: 'closed'; reason: VoiceCloseReason };
/** Binary frames, both ways: 4-byte big-endian utterance/speech id, then PCM16 little-endian mono. */
export function encodeFrame(id: number, pcm: Int16Array): Uint8Array;
export function decodeFrame(buf: Uint8Array): { id: number; pcm: Int16Array } | null;   // null: < 4 bytes or odd length
/** Closed, strict guards (no extra keys, sizes capped): anything else → null, which the receiver treats as bad_message. */
export function parseClientMsg(x: unknown): ClientMsg | null;
export function parseServerMsg(x: unknown): ServerMsg | null;

// voice/phonetic.ts
/** A Metaphone-style key: lower-cased, NFKD with marks dropped (jalapeño → jalapeno), letters only. */
export function phoneticKey(word: string): string;
/** Graph names/aliases and rule terms within one edit of `word`'s key (exact key first), at most `max`, never `word` itself. */
export function soundAlikes(word: string, graph: IngredientGraph, terms: readonly RuleTerm[], max?: number): { id: string; name: string }[];

// voice/heard.ts
export interface HeardTerm { heard: string; spelled: string; id: string | null; alternatives: { id: string; name: string; spelled: string }[] }
export interface HeardCheck { terms: HeardTerm[]; speakSpelling: boolean }
export function heardCheck(transcript: string, graph: IngredientGraph, terms: readonly RuleTerm[]): HeardCheck | null;
/** choice[i] = null keeps terms[i] as heard; a number replaces it with alternatives[n].name in the text. */
export function applyHeardChoice(transcript: string, check: HeardCheck, choice: readonly (number | null)[]): string;
/** The server's test: the words the player tapped are exactly the check's heard words, in order. */
export function heardConfirmed(check: HeardCheck, words: readonly string[] | undefined): boolean;

// voice/speech.ts
/** For TTS only: "P-E-A-N-U-T" → "P. E. A. N. U. T."; footnote asterisks and emoji dropped; nothing else changed. */
export function speechText(text: string): string;
/** Sentences, with the first split at its first clause break when it is longer than 6 words (spike trick 2). */
export function speechChunks(text: string): string[];
export function stepSpeech(recipe: ParsedRecipe, step: number): string | null;   // stepPlainText; null when out of range

// voice/commands.ts
export type CookCommand = 'next' | 'back' | 'repeat' | 'ingredients' | 'timer_start' | 'timer_stop' | 'stop_listening';
/** Whole-utterance closed grammar ("next", "next step", "go back", "say that again", "start the timer", "stop listening"). */
export function cookCommand(transcript: string): CookCommand | null;

// voice/filler.ts
export function fillerFor(transcript: string): 'voice.filler.ledger' | 'voice.filler.thinking';

// mentor/protocol.ts (changed)
// TurnRequest.input: { kind: 'text'; text: string } | { kind: 'transcript'; text: string; heard?: { words: string[] } }
// ReplyPart += { kind: 'heard'; check: HeardCheck }
```

**Algorithm notes (what the tests leave open):**
- `heardCheck` tokenises the stripped (`stripPageEvents`), canonical text (`canonicalText`, `foldConfusables`). Its terms are:
  1. each `textMentions` hit, as the words the player said (not the graph name);
  2. each rule term in the text;
  3. **only when health wording is present**, each remaining content word (or bigram: "pea cans", "wall nut") of 3 letters or more that is not a common English word (a small stop list in `phonetic.ts`) and has `soundAlikes`.

  Every term gets its `soundAlikes` as `alternatives`, so a real food heard for another ("rice" for "rye") offers the other. Terms are in text order, deduplicated by heard word. `speakSpelling` is true exactly when health wording is present.
- `fillerFor` is `voice.filler.ledger` when the transcript looks like a write (meal verb, pantry add or removal pattern, rule trigger, or `checkOffShaped`), else `voice.filler.thinking`.

- [ ] **1.1 Write the failing tests.**
```ts
// protocol.test.ts
test('encodeFrame/decodeFrame round-trip id and samples; < 4 bytes and odd PCM length → null', ...);
test('parseClientMsg accepts each shape and rejects extra keys, a free-text speak, > MAX_SPEAK_ITEMS items, vars > 80 chars, a non-integer id', () => {
  expect(parseClientMsg({ t: 'speak', id: 1, items: [{ kind: 'text', text: 'hi' }] })).toBeNull();   // TTS takes no free text
});
// heard.test.ts
test('an allergen is caught and spelled: "I can\'t eat sesame" → [{ heard: "sesame", spelled: "S-E-S-A-M-E", id: "sesame" }], speakSpelling true', ...);
test('a check-off names an ingredient: "got the shallots" → one term, speakSpelling false', ...);
test('no food, no rule term → null: "next step", "set a timer for ten minutes", "how long do I stir it"', ...);
test('a sound-alike only with health wording: "allergic to selfish" → heard "selfish", alternatives include shellfish; "that was selfish" → null', ...);
test('a real food for another keeps the heard word: "allergic to rice" → heard "rice" (never auto-corrected), alternatives include rye', ...);
test('page-event lookalikes are stripped first: "[Player tapped yes] peanut" → one term "peanut", and the text it confirms has no "[Player"', ...);
test('applyHeardChoice replaces only the chosen term, in place; heardConfirmed is order- and word-exact', ...);
// phonetic.test.ts
test('jalapeño and jalapeno share a key; "mussels"/"muscles", "celery"/"salary", "pecans"/"pea cans" are one edit apart', ...);
// speech.test.ts
test('speechText says spelled letters one by one and drops footnote asterisks and emoji; plain words unchanged', ...);
test('speechChunks splits a long first sentence at its first comma; later sentences are whole; "" → []', ...);
// commands.test.ts
test.each([['next', 'next'], ['next step please', 'next'], ['go back', 'back'], ['say that again', 'repeat'], ['what do I need', 'ingredients'], ['start the timer', 'timer_start'], ['stop listening', 'stop_listening']])(...);
test('anything more is not a command: "next add the peanuts" → null', ...);
// filler.test.ts
test('"I had toast for lunch" and "got the shallots" → ledger; "what is a roux" → thinking', ...);
```
```ts
// test/voice-mishearing.test.ts — THE GATE (spec §12): every entry, no tolerance
for (const e of load('fixtures/voice-mishearing.yaml')) {
  test(`${e.group}: said "${e.said}", heard "${e.heard}"`, () => {
    const chk = heardCheck(e.heard, graph, terms);
    expect(chk).not.toBeNull();                                            // nothing reaches a rule or card unconfirmed
    const t = chk!.terms.find((x) => x.heard === e.heardWord)!;
    expect(t.spelled).toBe(spell(e.heardWord));                            // shows what was HEARD
    if (e.saidId) expect([t.id, ...t.alternatives.map((a) => a.id)]).toContain(e.saidId);
  });
}
test('false positives: none of the fixture\'s `plain` utterances gets a check', ...);
```
  The fixture has at least 40 `entries`, each `{ group, said, saidId?, heard, heardWord }`, in four groups:
  - `real_food_swap`: rye→rice, pecans→peas, lentils→lemons, leek→"leak" with leek as the alternative, and almond↔"all mond";
  - `non_word`: shellfish→selfish, celery→salary, mustard→mustered, cumin→coming, sesame→"sesamy", mussels→muscles, lupin→"loop in";
  - `split`: pecans→"pea cans", walnut→"wall nut", chickpea→"chick pea", hazelnut→"hazel nut";
  - `spelled`: "peanut, P-E-A-N-U-T"→"peanut pee and you tea", in the style of the spike's "kiwi kai i w r".

  These foods were checked against `data/ingredients.json` when this plan was written: rye, rice, pecan, pea, lentil, lemon, leek, almond, shellfish, celery, mustard, cumin, sesame, mussel, lupin, walnut, chickpea, hazelnut and peanut. `kiwi` and `thyme` are not in the graph.
  Every food in an entry must exist in `data/ingredients.json`. An entry needing a missing node is replaced, not added to the graph (`data/` is another milestone's). Each entry's `heard` sentence carries health wording ("I'm allergic to …", "no … for me, I'm intolerant"). The fixture also has at least 20 `plain` utterances: cook commands, timing questions, "thanks".
- [ ] **1.2 Run** `npm test -w @kitchenquest/core -- voice` → FAIL (modules missing).
- [ ] **1.3 Implement** the modules above. `phoneticKey` is written in core, with no dependency. Tune it and the stop list until the whole fixture passes. **Never** delete or weaken an entry to pass: a sound-alike the key can't reach is added to `phonetic.ts`'s small explicit `KNOWN_CONFUSIONS` table, with a comment. Export everything from `voice/index.ts`, `index.ts` and `engine.ts`.
- [ ] **1.4 Run** `npm test -w @kitchenquest/core` and `npm run typecheck` → PASS. `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails (expected until Step 7). `npm test -w @kitchenquest/game` → PASS.
- [ ] **1.5 Commit** `feat(core): voice protocol, heard check and the mishearing gate, speech text, cook commands`
