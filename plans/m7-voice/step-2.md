# Step 2 — apps/voice: the service, engine seam, licence manifest and the memory-only proof

The `voice` service from spec §9 is a stateless WebSocket server on the private network. It turns frames into a transcript and speech chunks into PCM. It knows no user, keeps nothing and logs only numbers and enums. This step builds it with fake engines. Step 3 adds the real ones. It also adds the checked licence manifest and cast (Rulings 2 and 14), and the C-18 test that proves audio never leaves memory.

**Files:**
- Create:
  - `apps/voice/package.json`: `@kitchenquest/voice`, private, `type: module`; scripts `dev`, `test`, `typecheck`, `bench` (Step 3); dependencies `@kitchenquest/core`, `ws` (exact pin); devDependencies `vitest`, `tsx`, `@types/node`, `@types/ws`;
  - `apps/voice/tsconfig.json`, `apps/voice/vitest.config.ts`;
  - `apps/voice/src/config.ts`, `src/log.ts`, `src/engines/types.ts`, `src/engines/fake.ts`, `src/models.ts`, `src/session.ts`, `src/server.ts`, `src/main.ts`;
  - `data/voice-models.json`: the manifest and the cast;
  - tests: `apps/voice/test/{licences,config,session,server,memory-only,log}.test.ts`.
- Modify: `knip.json` (the `apps/voice` workspace: entry `src/main.ts`, `test/**/*.test.ts`, `bench/*.ts`); `.dependency-cruiser.cjs` (`voice-no-api`: `^apps/voice` must not import `^apps/(api|game)/`; `api-no-voice` and `game-no-voice` likewise); `.gitignore` (`apps/voice/models/`, `apps/voice/bench/audio/`).

**Interfaces:**
- Consumes: core `voice/` (Step 1): `ClientMsg`'s frame codec, `speechText`, `speechChunks`, `SAMPLE_RATE_IN`, `MAX_UTTERANCE_MS`, `HINT_MAX_WORDS`.
- Produces:
```ts
// src/engines/types.ts — THE provider seam (Ruling 1)
export interface SttEngine {
  readonly model: string;                     // manifest id
  /** pcm is 16 kHz mono; the engine must not keep a reference after it resolves. */
  transcribe(pcm: Int16Array, hint: readonly string[], signal: AbortSignal): Promise<string>;
}
export interface TtsEngine {
  readonly model: string;
  readonly sampleRate: number;
  /** One chunk at a time; yields PCM pieces; stops on abort. */
  synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Int16Array>;
}
export function fakeStt(script: (pcm: Int16Array) => string): SttEngine;          // tests
export function fakeTts(sampleRate?: number): TtsEngine;                           // 50 ms of sine per word

// API ↔ voice service upstream protocol (JSON text frames + core binary frames), service side:
//   → { t:'hello', v:1 }                       ← { t:'ready', stt: model, tts: model, sampleRate }
//   → { t:'listen', id, hint: string[] }  → frames(id)  → { t:'end', id }   ← { t:'transcript', id, text }
//   → { t:'speak', id, voice, chunks: string[], cache: boolean }   ← frames(id)… ← { t:'audio_end', id, audioMs }
//   → { t:'cancel', id }                                           ← { t:'failed', id, kind } on an engine error
export function createVoiceServer(opts: { config: VoiceConfig; stt: SttEngine; tts: TtsEngine; log: Logger }): { listen(port: number): Promise<number>; close(): Promise<void> };

// src/models.ts
export interface ModelEntry {
  id: string; kind: 'stt' | 'tts'; engine: string; source: string;
  licence: string; commercial: boolean; attribution: string | null;
  status: 'allowed' | 'excluded' | 'unverified'; reason?: string;
  voices?: string[]; files: { path: string; sha256: string }[];
}
export interface EngineEntry { id: string; licence: string; boundary: 'in-process' | 'separate-process' }
export interface VoiceManifest { models: ModelEntry[]; engines: EngineEntry[]; cast: Record<'pan', { model: string; voice: string }>; fallbackCast: Record<'pan', { model: string; voice: string }> }
export const ALLOWED_LICENCES: ReadonlySet<string>;   // MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC-BY-4.0, CC-BY-SA-4.0
export function loadManifest(file?: URL): VoiceManifest;          // throws on any rule below
export function castable(m: VoiceManifest, model: string, voice: string): ModelEntry;   // throws unless allowed + voice listed

// src/config.ts
export interface VoiceConfig {
  production: boolean; port: number; token: Buffer;              // VOICE_SERVICE_TOKEN, base64, ≥ 32 bytes
  engine: 'worker' | 'fake';                                     // 'fake' refused when production
  sttModel: string; cast: { model: string; voice: string };      // VOICE_STT_MODEL, VOICE_TTS_MODEL + VOICE_PAN_VOICE (default: manifest cast)
  maxConnections: number;                                        // VOICE_MAX_CONNECTIONS, default 50
}
export function loadVoiceConfig(env: NodeJS.ProcessEnv, manifest: VoiceManifest): VoiceConfig;

// src/log.ts — numbers and enums only, by type
export type LogKind = 'conn_open' | 'conn_close' | 'stt_done' | 'tts_done' | 'engine_error' | 'bad_message' | 'auth_fail';
export type Logger = (kind: LogKind, fields?: Record<string, number | boolean>) => void;
```
- `data/voice-models.json` starts with:
  - `faster-whisper-tiny.en`, `-base.en` and `-small.en`: MIT, allowed;
  - `kokoro-82m-v1.0`: Apache-2.0, allowed, voices `bm_fable`, `bm_george`, `af_heart`;
  - `piper-en_GB-northern_english_male-medium`: CC-BY-SA-4.0, allowed, with an attribution;
  - `piper-en_US-ryan-high`: CC-BY-NC-SA-4.0, **excluded**, "non-commercial (spike licence table)";
  - `piper-en_US-lessac-medium`, `piper-en_GB-alan-medium`, `piper-en_US-amy-medium`: unverified;
  - engines: `faster-whisper`, `ctranslate2`, `onnxruntime`, `kokoro-onnx` (in-process, MIT, `[verify]` in a comment field), `piper-tts` and `espeak-ng` (GPL-3.0-or-later, separate-process);
  - `cast.pan` = kokoro `bm_fable`, `fallbackCast.pan` = piper northern_english_male.

  `files` arrays are empty: the operator fills them in Step 3.

- [ ] **2.1 Write the failing tests.**
```ts
// licences.test.ts — the checked manifest (spec §7.7 licensing)
test('every allowed model has a licence in ALLOWED_LICENCES, commercial: true, and an attribution when the licence is CC-BY*', ...);
test('no allowed model or engine is NC or ND; ryan-high is present and excluded', ...);
test('cast and fallbackCast name allowed models and listed voices', ...);
test('GPL engines are separate-process only; no in-process engine is GPL', ...);
test('loadVoiceConfig refuses VOICE_TTS_MODEL=piper-en_US-ryan-high and any unverified model, naming the model', ...);
test('every model id the code or .env.example names is in the manifest (grep of src/, worker/ and .env.example)', ...);
// config.test.ts
test('production refuses engine=fake, a token shorter than 32 bytes, and an allowed model with no file pins', ...);
// session.test.ts — fake engines
test('listen → frames → end gives one transcript; frames for another id are dropped; frames after MAX_UTTERANCE_MS end the utterance (too_long, then the transcript)', ...);
test('the hint is capped at HINT_MAX_WORDS words and passed to transcribe; never stored on the session after end', ...);
test('speak synthesises chunk by chunk through speechText; cancel mid-chunk stops further frames and sends no audio_end', ...);
test('cache: true chunks are synthesised once per (voice, text) and replayed from memory; cache: false never enter the cache', ...);
test('the utterance buffer is zero-filled and released after end, cancel and close (the session holds no Int16Array afterwards)', ...);
// server.test.ts
test('a connection without Authorization: Bearer <token> is closed with 4401 and logged as auth_fail only', ...);
test('a bad JSON or unknown message closes with bad_message; maxConnections+1 is refused', ...);
// log.test.ts
test('the logger writes one JSON line of kind + numeric/boolean fields; a string field is a type error (expectTypeOf) and is dropped at runtime', ...);
```
```ts
// memory-only.test.ts — C-18 "a test greps the service's filesystem and logs after a session"
test('a full session writes no file and logs no audio or transcript', async () => {
  // TMPDIR, HOME and cwd point at a fresh empty dir; fs write APIs are spied (writeFile*, appendFile*, createWriteStream,
  // open with a write flag, mkdtemp); stdout and stderr are captured.
  // The PCM carries a marker pattern (0x4B51 repeated); the fake STT returns the token "zebrapeanut71"; a speak chunk
  // carries "quagga-lentil-42".
  // run: hello, listen, 50 frames, end, speak, cancel, a second listen closed mid-utterance, a throwing engine
  //   (its Error.message contains "zebrapeanut71").
  // assert: no fs write spy was called; the temp dirs are still empty; captured output contains neither token, nor the
  //   marker as hex, base64 or decimal runs.
});
```
- [ ] **2.2 Run** `npm test -w @kitchenquest/voice` → FAIL.
- [ ] **2.3 Implement.**
  - **Sessions.** One `Session` per connection, holding at most one utterance and one speech at a time. Frames append to a preallocated `Int16Array` sized to `MAX_UTTERANCE_MS`, which is zero-filled on release.
  - **Engine errors** send `failed` and log `engine_error` with no message.
  - **The upstream token** is compared in constant time.
  - **`main.ts`** reads config, builds the engines (Step 3 adds `worker`), refuses to start in production without Step 3's bench gate (stubbed to refuse until Step 3), and listens on `VOICE_PORT`.
- [ ] **2.4 Run** `npm test -w @kitchenquest/voice`, `npm run typecheck`, `npm run lint` → PASS. The whole repo's `npm test` → only `eval-gate.test.ts` fails.
- [ ] **2.5 Commit** `feat(voice): the voice service with fake engines, licence manifest and the memory-only proof`
