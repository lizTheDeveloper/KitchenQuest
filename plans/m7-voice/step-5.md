# Step 5 — API: the voice socket (session, origin, consent, child, allowance, upstream, speak rendering)

The only public door to voice is `GET /voice`, a WebSocket on the API. The game reaches it same-origin at `/api/voice`. The route:
- authenticates the session cookie and checks the Origin (cross-site WebSocket hijacking);
- checks that voice is enabled, the `voice` consent, the conversation's child flag and the allowance;
- proxies frames to `apps/voice` over the private network (C-38), with the speech-to-text vocabulary hint;
- meters seconds into `usage_events`;
- renders `SpeakItem`s, so TTS never receives free text (§7.6b.5).

It holds audio in memory only, as `apps/voice` does, and has its own memory-only test.

**Files:**
- Create:
  - `apps/api/src/voice/routes.ts`: `voiceRoutes`;
  - `apps/api/src/voice/upstream.ts`: `VoiceUpstream`, `wsUpstream`;
  - `apps/api/src/voice/speak.ts`: `renderSpeak`;
  - `apps/api/src/voice/hint.ts`: `sttHint`;
  - `apps/api/test/helpers/fake-upstream.ts`;
  - `apps/api/test/{voice-socket,voice-speak,voice-hint,voice-memory-only}.test.ts`.
- Modify:
  - `apps/api/package.json`: `@fastify/websocket` and `ws`, exact pins;
  - `apps/api/src/app.ts`: register `@fastify/websocket` and `voiceRoutes` when `config.voice` is set; `Deps.voiceUpstream?: VoiceUpstream`;
  - `apps/api/src/config.ts`: `voice: { serviceUrl: URL; token: Buffer } | null` from `VOICE_ENABLED`, `VOICE_SERVICE_URL`, `VOICE_SERVICE_TOKEN`;
    - production requires `wss://`, or a host in 10/8, 172.16/12 or 192.168/16;
    - production refuses `VOICE_ENABLED=true` until `processors.json` lists the voice host's processor (`hetzner`) as `dpa_status: "signed"` (P-11, reusing `ai/processors.ts`'s check);
  - `apps/api/src/mentor/lines.ts`: `PanBank.lineAt(trigger, index, vars): string | null` (the resolved trigger's line `index`, filled by core `fillLine`; null when the trigger, the index or a var is missing);
  - `apps/api/src/logging/redact.ts`: the `/voice` route logs no body, header or query beyond the status code;
  - `apps/api/test/{config,logging,architecture}.test.ts`;
  - `.env.example`: an API voice block.

**Interfaces:**
- Consumes:
  - Step 1's protocol, `parseClientMsg`, `decodeFrame` / `encodeFrame`, `speechChunks`, `speechText`, `stepSpeech`, `HINT_MAX_WORDS`, `MAX_UTTERANCE_MS`, `MAX_SPEAK_CHARS`;
  - Step 4's `voiceState`, `recordVoice`;
  - `hasConsent`, `MentorState.childFlags`, session lookup from `auth/session.ts`;
  - `filterReply`;
  - the recipe index and core `check` with the player's active rules (`rules/service.ts`), and the open run's stock swaps (`week/market-service.ts`);
  - `loadManifest().cast.pan` (read from `data/voice-models.json` by path, no import from `apps/voice`).
- Produces:
```ts
// voice/upstream.ts — the API-side provider seam
export interface VoiceLink {
  listen(id: number, hint: readonly string[]): void;
  frame(id: number, pcm: Int16Array): void;
  end(id: number): Promise<{ text: string; speechMs: number }>;
  speak(id: number, voice: string, chunks: readonly string[], cache: boolean, onPcm: (pcm: Int16Array, sampleRate: number) => void): Promise<{ audioMs: number }>;
  cancel(id: number): void;
  close(): void;
}
export interface VoiceUpstream { open(signal: AbortSignal): Promise<VoiceLink> }
export function wsUpstream(url: URL, token: Buffer): VoiceUpstream;          // Authorization: Bearer; one link per player socket
// voice/speak.ts
export type Rendered = { chunks: string[]; cache: boolean } | null;          // null: say nothing for this item
export function renderSpeak(items: readonly SpeakItem[], ctx: {
  bank: PanBank; stepOk(slug: string, step: number, localDate: string): Promise<boolean>; recipes: RecipeIndex;
}): Promise<{ chunks: string[]; cache: boolean }>;
//   line: bank.lineAt → each var must pass filterReply(var, { finish: 'stop' }) or the item is dropped; cache = (vars empty)
//   step: stepOk (Ruling 11: ✅ on localDate, no 🔁, no stall swap this week) ? stepSpeech : the line 'voice.step_on_screen'
//   the total text is capped at MAX_SPEAK_CHARS (later items dropped); chunks = speechChunks(speechText(text))
// voice/hint.ts
export async function sttHint(db: Db, keyring: Keyring, catalog: Catalog, userId: string, now: Date): Promise<string[]>;
//   with health_data: active rule targets' names, then pantry names, then the open run's row names; always then the
//   graph's major allergens (core isMajorAllergen), de-duplicated, capped at HINT_MAX_WORDS words. In memory only.
```
- **The connection.**
  1. **Open.** No live session → `closed: signed_out` (4401). Origin ≠ `APP_ORIGIN` → `bad_origin` (4403). `config.voice` null → `unavailable`. No current `voice` grant → `consent_required`. An older socket of the same user is closed with `another_tab`.
  2. **`hello`.** The conversation's child flag set (`childFlags.has(\`${userId}:${conversationId}\`)`) → `closed: child`. Otherwise `ready { state }`.
  3. **`listen`.** Resting → `state { resting }`, and frames are ignored. Otherwise the route opens or reuses the upstream link, sends `listen` with `sttHint`, and forwards each frame for that id. Frames past `MAX_UTTERANCE_MS` → `too_long`, then the utterance ends itself.
  4. **`end`.** The route awaits the transcript, then `recordVoice('voice_stt', speechMs)` and `transcript`. `speechMs` is the frames forwarded × `FRAME_MS`, counted by the API rather than reported by the service. The transcript is never logged.
  5. **`speak`.** Resting → nothing spoken, `state`. Otherwise `renderSpeak` → upstream `speak` → `audio_start` / frames / `audio_end` → `recordVoice('voice_tts', audioMs)`.
  6. **`cancel`.** Upstream `cancel`. Nothing is recorded for a cancelled utterance; for cancelled speech, only the audio already sent.
  7. **Child flag set later:** `routes.ts` exports an in-memory registry, `voiceSockets.closeFor(userId, conversationId, reason)`. Step 6 calls it from the turn when a turn sets the child flag.
  8. **Upstream down or erroring:** `failed { kind: 'upstream' }`, and the socket stays open for the next try.
  9. **Close:** the buffers are dropped and the link is closed.

- [ ] **5.1 Write the failing tests.**
```ts
// voice-socket.test.ts — Fastify inject-free: app.listen on port 0, a ws client, FakeUpstream (scripted transcripts)
test('no cookie → closed signed_out; a cross-site Origin → closed bad_origin; no voice grant → closed consent_required', ...);
test('hello in a conversation with the child flag → closed child; voiceSockets.closeFor closes only that user\'s socket in that conversation', ...);
test('listen + 25 frames + end → transcript; one voice_stt row with units = ceil(speech seconds); no other table written', ...);
test('frames past MAX_UTTERANCE_MS → too_long then the transcript of what came; frames for a stale id are dropped', ...);
test('resting (free player at 3600 s) → listen answered with state resting and nothing forwarded upstream; accessibility on → available', ...);
test('allowance runs out during an utterance: that utterance finishes and is transcribed; the next listen rests (Review Focus 5)', ...);
test('a second socket for the same user closes the first with another_tab', ...);
test('upstream down → failed upstream, socket stays open, the next listen works when it is back (Review Focus 5)', ...);
test('a bad message (free-text speak, unknown t) → closed bad_message', ...);
// voice-speak.test.ts
test('a line item renders its exact variant with vars; an unknown trigger, index or missing var → dropped; a var failing filterReply ("it\'s safe") → dropped', ...);
test('a var-free line is cache: true; a line with vars is cache: false', ...);
test('a step is spoken only when the dish is ✅ with no swap; with a 🔁 or a stall swap → voice.step_on_screen (Ruling 11)', ...);
test('the total is capped at MAX_SPEAK_CHARS; spelled letters reach the upstream as "P. E. A. N. U. T."', ...);
test('there is no code path from a model `text` part to upstream.speak without filterReply (renderSpeak is the only caller; architecture grep)', ...);
// voice-hint.test.ts
test('without health_data the hint has no rule or pantry names, only major allergens; with it, rules first; ≤ HINT_MAX_WORDS', ...);
// voice-memory-only.test.ts (as Step 2's, for the API process)
test('a session with marker PCM, a transcript token and a throwing upstream leaves no file and no token or marker in the log', ...);
test('the Fastify error hook on /voice logs kind and status only (Review Focus 2)', ...);
// config.test.ts (extended)
test('production refuses VOICE_ENABLED=true with ws:// to a public host, a short token, or hetzner\'s DPA not signed', ...);
```
- [ ] **5.2 Run** `npm test -w @kitchenquest/api -- voice-socket voice-speak voice-hint voice-memory-only config logging` → FAIL.
- [ ] **5.3 Implement.** Frame forwarding allocates no copy beyond the decoded view. Nothing on the route holds a reference to a frame after it is forwarded.
- [ ] **5.4 Run** `npm test -w @kitchenquest/api` → only `eval-gate.test.ts` fails. `npm run typecheck`, `npm run lint` → PASS.
- [ ] **5.5 Commit** `feat(api): the voice socket — session, origin, consent, child, allowance, upstream proxy and speak rendering`
