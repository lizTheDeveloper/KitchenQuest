# Step 5 — API: the voice socket, the per-user voice block and server-side speak rendering

The only public door to voice is `GET /voice`, a WebSocket on the API, which the game reaches same-origin at `/api/voice`. The route:
- authenticates the session cookie and checks the Origin;
- checks voice is enabled, the `voice` consent, the **per-user voice block** (Ruling 17: a child flag in any conversation, or a Family Table report) and the allowance;
- proxies frames to `apps/voice` over the private network under core's upstream protocol, with the STT hint;
- meters seconds into `usage_events`;
- resolves `SpeakItem`s from server-held data into branded `SpeakableText` (Ruling 15).

It holds audio in memory only and has its own memory-only test with a positive control.

**Files:**
- Create:
  - `apps/api/src/voice/registry.ts` (P3: imports no Fastify, mentor or upstream code);
  - `apps/api/src/voice/recent-replies.ts`;
  - `apps/api/src/voice/{routes,upstream,speak,hint,family-routes}.ts`;
  - `apps/api/test/helpers/fake-upstream.ts`;
  - `apps/api/test/{voice-socket,voice-block,voice-speak,voice-hint,voice-memory-only,voice-upstream-contract}.test.ts`.
- Modify:
  - `apps/api/package.json`: `@fastify/websocket` and `ws`, exact;
  - `apps/api/src/app.ts`: register `@fastify/websocket`, `voiceRoutes` and `voiceFamilyRoutes` when `config.voice` is set; `Deps.voiceUpstream?`; `Deps.voiceEnabled = config.voice !== null` (P6);
  - `apps/api/src/config.ts`: `voice: { serviceUrl: URL; token: Buffer } | null` from `VOICE_ENABLED`, `VOICE_SERVICE_URL` and `VOICE_SERVICE_TOKEN`:
    - production requires `wss://` or an RFC 1918 host;
    - production refuses `VOICE_ENABLED=true` until `processors.json` lists `hetzner` as `dpa_status: "signed"` (P-11);
  - `apps/api/src/ai/processors.ts`: its check is generalised to take a processor id (B5);
  - `apps/api/src/mentor/lines.ts`: `PanBank.lineAt(trigger, index, vars): string | null`, and `PanBank.varsOf(trigger): string[]`;
  - `apps/api/src/logging/redact.ts`: `/voice` logs status only;
  - `apps/api/test/{config,logging,architecture}.test.ts`;
  - `.env.example`: its own block, `# Voice (API)` (P14).

**Interfaces:**
- Consumes:
  - from Step 1: core `ClientMsg`, `parseClientMsg`, `UpstreamClientMsg` / `UpstreamServerMsg` and their parsers, `decodeFrame` / `encodeFrame`, `SpeakItem`, `heardCheck`, `spell`, `speechText`, `speechChunks`, `stepSpeech`, and the constants;
  - from Step 4: `voiceState`, `recordVoice`;
  - `hasConsent`, `filterReply`, session lookup, the sealed `mentor_proposals` read (`proposals.ts`), the recipe index, core `check` with active rules, the open run's stock swaps;
  - the manifest's `cast.pan` (read from `data/voice-models.json` by path).
- Produces:
```ts
// voice/registry.ts (P3, Ruling 17) — in memory, per user
export const voiceRegistry: {
  add(userId: string, sock: { close(reason: VoiceCloseReason): void }): () => void;    // returns remove
  childFlagged(userId: string, nowMs: number): void;        // closes every socket of the user with 'child'
  setFamilyTable(userId: string, on: boolean): void;        // on closes every socket with 'family_table'
  blocked(userId: string, nowMs: number): VoiceCloseReason | null;   // 'child' (within the child-flag TTL) | 'family_table' | null
};
// voice/recent-replies.ts — memory only, last RECENT_REPLIES per user, RECENT_REPLY_TTL_MS (Ruling 15)
export const recentReplies: { put(userId: string, replyId: string, parts: readonly ReplyPart[]): void;
  line(userId: string, replyId: string, part: number): LineRef | null; clear(userId: string): void };
// voice/family-routes.ts
//   PUT /voice/family-table { on: boolean } (zod-strict, requireUser) → 204; sets the registry flag (the game calls it on every change and at start)
// voice/upstream.ts
export interface VoiceLink {
  listen(id: number, hint: readonly string[]): void; frame(id: number, pcm: Int16Array): void;
  end(id: number): Promise<{ text: string }>;                       // P1: speechMs is counted by the route
  speak(id: number, voice: string, text: SpeakableText, onPcm: (pcm: Int16Array, sampleRate: number) => void): Promise<{ audioMs: number }>;
  cancel(id: number): void; close(): void;
}
export interface VoiceUpstream { open(signal: AbortSignal): Promise<VoiceLink> }
export function wsUpstream(url: URL, token: Buffer): VoiceUpstream;
// voice/speak.ts
declare const brand: unique symbol;
export type SpeakableText = { readonly chunks: readonly { text: string; cache: boolean }[]; readonly [brand]: true };   // only renderSpeak makes one (D4)
export function renderSpeak(items: readonly SpeakItem[], ctx: {
  userId: string; bank: PanBank; lastTranscript(utteranceId: number): string | null;
  card(proposalId: string): Promise<LineRef[] | null>; stepOk(slug: string, step: number, localDate: string): Promise<boolean>; recipes: RecipeIndex;
}): Promise<SpeakableText>;
//   line: bank.varsOf(trigger) must be empty, else voice.check_screen
//   reply: recentReplies.line(userId, replyId, part)        card: ctx.card(proposalId) (sealed, the player's own)
//   heard: heardCheck(lastTranscript(id)) → voice.heard_check(_spelled) with spell() from code (§7.6b.2)
//   step: stepOk ? stepSpeech : voice.step_on_screen (Ruling 11)
//   every var: filterReply(v, { finish: 'stop' }).ok and length ≤ SPEAK_VAR_MAX, else THAT item → voice.check_screen;
//   a total over MAX_SPEAK_CHARS: the items past it → voice.check_screen (once); unknown ids → voice.check_screen.
//   chunks = speechChunks(speechText(text)); cache = (chunk came from a var-free line) — per chunk (B5)
// voice/hint.ts
export async function sttHint(db: Db, keyring: Keyring, catalog: Catalog, userId: string, now: Date): Promise<string[]>;
//   with health_data: rule targets, pantry names, open-run rows; always the graph's major allergens; ≤ HINT_MAX_WORDS
```
- **The connection.**
  1. **Open.** No session → `signed_out` (4401). A missing or foreign Origin → `bad_origin` (4403). `config.voice` null → `unavailable`. No `voice` grant → `consent_required`. Any older socket of the user is closed (`another_tab`). The socket is added to `voiceRegistry`.
  2. **Before `hello`,** any other message → `bad_message` (B5).
  3. **`hello`.**
     - `familyTable: true` → `setFamilyTable(userId, true)` and `closed: family_table`.
     - Otherwise, if `voiceRegistry.blocked(userId)` is set → closed with its reason, whatever the `conversationId`, `null` included (Ruling 17).
     - Otherwise `ready { state }`.
  4. **`listen`.**
     - Re-check `blocked`; set → closed with the reason.
     - Resting → `state`, and frames are ignored.
     - Otherwise: upstream `listen` with `sttHint`, frames forwarded. Past `MAX_UTTERANCE_MS` → `too_long`.
  5. **`end`.** Await the text. `speechMs` = frames forwarded × `FRAME_MS`. `recordVoice('voice_stt', speechMs)`. Keep the text in this socket's memory for `heard` items (`lastTranscript`, the last 4 utterances, dropped on close), then send `transcript`. It is never logged.
  6. **`speak`.** Resting → `state`. Otherwise `renderSpeak` → upstream `speak` → `audio_start` / frames / `audio_end` → `recordVoice('voice_tts', audioMs)`.
  7. **`cancel`.** Upstream `cancel`. A cancelled utterance is not recorded.
  8. **Upstream down** → `failed { kind: 'upstream' }`, and the socket stays open.
  9. **Close** → buffers and transcripts dropped, link closed, removed from the registry.

- [ ] **5.1 Write the failing tests.**
```ts
// voice-socket.test.ts (app.listen(0), a ws client, FakeUpstream)
test('no cookie → signed_out; no Origin header → bad_origin; a cross-site Origin → bad_origin; no voice grant → consent_required', ...);
test('listen before hello → closed bad_message (B5)', ...);
test('listen + 25 frames + end → transcript; exactly one voice_stt row, units = ceil(25 × 20 ms / 1000) = 1; no other table written', ...);
test('frames past MAX_UTTERANCE_MS → too_long, then the transcript; frames for a stale id are dropped', ...);
test('resting (free, 3600 s) → state resting and nothing forwarded; accessibility on → available', ...);
test('the allowance runs out during an utterance: it finishes and is transcribed; the next listen rests (Review Focus 5)', ...);
test('a second socket of the same user closes the first with another_tab', ...);
test('upstream down → failed upstream; the socket stays open and the next listen works once it is back', ...);
// voice-block.test.ts — Ruling 17, both flags (override P4/C2)
test('a child flag in conversation A closes a socket that said hello with conversationId B, and one that said hello with null', ...);
test('hello with conversationId null while a child flag is set in any of the user\'s conversations → closed child', ...);
test('PUT /voice/family-table {on:true} closes the open socket with family_table; a new hello and a listen are refused even though that client sends familyTable:false (the device is wrong)', ...);
test('hello with familyTable:true sets the server flag; PUT {on:false} clears it and voice opens again', ...);
test('another user is never affected by these flags', ...);
// voice-speak.test.ts
test('a line item with vars in its trigger → voice.check_screen; a var-free line renders its exact variant', ...);
test('a reply item resolves its LineRef from recentReplies with the server\'s vars; an unknown replyId → voice.check_screen', ...);
test('a card item reads the sealed proposal\'s read-back for that user only; another user\'s proposalId → voice.check_screen', ...);
test('a heard item for "allergic to sesame, peanut and shellfish" speaks the spelling from code, "S. E. S. A. M. E., P. E. A. N. U. T., …", nothing dropped', ...);
test('a var over SPEAK_VAR_MAX (a 90-char dish name) → voice.check_screen, never silently dropped; same for a var failing filterReply ("it\'s safe")', ...);
test('a total over MAX_SPEAK_CHARS: the items before the cut are spoken, then voice.check_screen once', ...);
test('a step is spoken only when ✅ with no swap; with a 🔁 or a stall swap → voice.step_on_screen', ...);
test('cache is per chunk: var-free chunks true, var-filled chunks false', ...);
test('VoiceLink.speak accepts only SpeakableText: passing a plain object is a compile error (// @ts-expect-error) (D4)', ...);
// voice-upstream-contract.test.ts (P1): a ws server in the test replays packages/core/test/fixtures/voice-upstream-session.json
test('wsUpstream sends exactly the fixture\'s client messages and parses every server reply', ...);
// voice-hint.test.ts
test('without health_data: only major allergens; with it: rule targets first; ≤ HINT_MAX_WORDS', ...);
// voice-memory-only.test.ts (as Step 2's, D1)
test('a session with marker PCM, a transcript token and a throwing upstream reaches transcript and audio_end, leaves identical dir snapshots and no marker in logs', ...);
test('positive control: a leaking FakeUpstream (logs the transcript via app.log) fails the assertions', ...);
test('the Fastify error hook on /voice logs kind and status only (Review Focus 2)', ...);
// config.test.ts
test('production refuses VOICE_ENABLED=true with ws:// to a public host, a short token, or hetzner\'s DPA not signed', ...);
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/api -- voice- config logging` → FAIL.
- [ ] **5.3 Implement.** Forwarding keeps no reference to a frame. `registry.ts` and `recent-replies.ts` import only core types.
- [ ] **5.4 Run** `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails. `npm run typecheck`, `npm run lint` → PASS.
- [ ] **5.5 Commit** `feat(api): the voice socket, the per-user voice block, server-side speak rendering`
