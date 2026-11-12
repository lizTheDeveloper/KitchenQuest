# Step 2 — apps/voice: the service, engine seam, licence manifest and the memory-only proof

The `voice` service from spec §9 is a stateless WebSocket server on the private network. It speaks core's upstream protocol (P1): it turns frames into a transcript, and it speaks the chunks the API sends **verbatim** (P2), returning PCM. It knows no user, keeps nothing and logs only numbers and enums.

This step builds it with fake engines; Step 3 adds the real ones. It also adds the checked licence manifest and cast (Rulings 2 and 14), and the C-18 memory-only test with a positive control (D1).

**Files:**
- Create:
  - `apps/voice/package.json`: `@kitchenquest/voice`, private, `type: module`; scripts `dev`, `test`, `typecheck`, `bench`; dependencies `@kitchenquest/core` and `ws` (exact); devDependencies `vitest`, `tsx`, `@types/node`, `@types/ws`;
  - `apps/voice/tsconfig.json`, `apps/voice/vitest.config.ts`;
  - `apps/voice/src/{config,log,models,session,server,boot,main}.ts`, `apps/voice/src/engines/{types,fake}.ts`;
  - `data/voice-models.json`;
  - `apps/voice/test/{licences,config,session,server,memory-only,log,upstream-contract}.test.ts`.
- Modify:
  - `knip.json`: the `apps/voice` workspace;
  - `.dependency-cruiser.cjs`: `voice-no-api` (`^apps/voice` must not import `^apps/(api|game)/`), `api-no-voice`, `game-no-voice`;
  - `.gitignore`: `apps/voice/models/`, `apps/voice/bench/audio/`;
  - `.env.example`: a block `# Voice service (apps/voice)` with `VOICE_PORT`, `VOICE_SERVICE_TOKEN=`, `VOICE_ENGINE=fake`, `VOICE_STT_MODEL=faster-whisper-base.en`, `VOICE_TTS_MODEL=piper-en_GB-northern_english_male-medium`, `VOICE_PAN_VOICE=northern_english_male`, `VOICE_MAX_CONNECTIONS=50` (B2). Step 3 extends this block.

**Interfaces:**
- Consumes: core `UpstreamClientMsg`, `UpstreamServerMsg`, `parseUpstreamClientMsg`, `encodeFrame`, `decodeFrame`, `MAX_UTTERANCE_MS`, `HINT_MAX_WORDS` (Step 1). It does **not** import `speechText` or `speechChunks` (P2).
- Produces:
```ts
// src/engines/types.ts — THE provider seam
export interface SttEngine { readonly model: string; transcribe(pcm: Int16Array, hint: readonly string[], signal: AbortSignal): Promise<string> }
export interface TtsEngine { readonly model: string; readonly sampleRate: number; synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Int16Array> }
export function fakeStt(script: (pcm: Int16Array) => string): SttEngine;
export function fakeTts(sampleRate?: number): TtsEngine;           // 50 ms of sine per word
// src/server.ts
export function createVoiceServer(opts: { config: VoiceConfig; stt: SttEngine; tts: TtsEngine; log: Logger }): { listen(port: number): Promise<number>; close(): Promise<void> };
// src/models.ts
export interface ModelEntry { id: string; kind: 'stt' | 'tts'; engine: string; source: string; licence: string; commercial: boolean;
  attribution: string | null; status: 'allowed' | 'excluded' | 'unverified'; reason?: string; voices?: string[]; files: { path: string; sha256: string }[] }
export interface EngineEntry { id: string; licence: string; boundary: 'in-process' | 'in-worker-process' | 'separate-process' }
export interface VoiceManifest { models: ModelEntry[]; engines: EngineEntry[];
  cast: { pan: { model: string; voice: string } };       // CPU default (C1): piper northern_english_male
  gpuCast: { pan: { model: string; voice: string } } }   // kokoro bm_fable
export const ALLOWED_LICENCES: ReadonlySet<string>;      // MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, CC-BY-4.0, CC-BY-SA-4.0
export function loadManifest(file?: URL): VoiceManifest;
export function castable(m: VoiceManifest, model: string, voice: string): ModelEntry;   // throws unless allowed + voice listed
// src/config.ts
export interface VoiceConfig { production: boolean; port: number; token: Buffer; engine: 'worker' | 'fake';
  sttModel: string; cast: { model: string; voice: string }; maxConnections: number }
export function loadVoiceConfig(env: NodeJS.ProcessEnv, manifest: VoiceManifest): VoiceConfig;
// src/log.ts
export type LogKind = 'conn_open' | 'conn_close' | 'stt_done' | 'tts_done' | 'engine_error' | 'bad_message' | 'auth_fail';
export type Logger = (kind: LogKind, fields?: Record<string, number | boolean>) => void;
// src/boot.ts — main.ts only calls boot(process.env); tests call boot with an env (P11)
export async function boot(env: NodeJS.ProcessEnv): Promise<{ port: number; close(): Promise<void> }>;
```
- **`data/voice-models.json`** holds:
  - the faster-whisper `tiny.en`, `base.en` and `small.en` models (MIT, allowed);
  - `kokoro-82m-v1.0` (Apache-2.0, allowed; voices `bm_fable`, `bm_george`, `af_heart`);
  - `piper-en_GB-northern_english_male-medium` (CC-BY-SA-4.0, allowed, with an attribution);
  - `piper-en_US-ryan-high` (CC-BY-NC-SA-4.0, **excluded**: "non-commercial");
  - Lessac, Alan and Amy, all unverified.

  Its engines are:
  - `faster-whisper`, `ctranslate2` and `onnxruntime`: `in-worker-process`, MIT;
  - `kokoro-onnx`: `in-worker-process`, MIT, `[verify]`;
  - `espeak-ng`: `in-worker-process`, GPL-3.0-or-later (B2: the worker itself is GPL, Ruling 14);
  - `piper-tts`: `separate-process`, GPL-3.0-or-later.

  `cast.pan` is Piper northern_english_male; `gpuCast.pan` is Kokoro `bm_fable`. The `files` arrays are filled by the operator in Step 3.

- [ ] **2.1 Write the failing tests.**
```ts
// licences.test.ts
test('every allowed model: licence ∈ ALLOWED_LICENCES, commercial true, attribution non-empty when CC-BY*', ...);
test('no allowed model or engine is NC or ND; ryan-high is present with status excluded', ...);
test('cast and gpuCast name allowed models and listed voices', ...);
test('every GPL engine is in-worker-process or separate-process; no in-process engine is GPL', ...);
test('loadVoiceConfig refuses ryan-high and every unverified model, naming the model', ...);
test('every VOICE_*_MODEL value in .env.example loads through loadVoiceConfig (D4: no grep)', ...);
test('apps/voice/worker/ is checked when present: its SPDX header is GPL-3.0-or-later (skipped with a message until Step 3 creates it, then required; B2)', ...);
// config.test.ts
test('production refuses engine=fake, a token < 32 bytes, and an allowed cast model with empty files', ...);
// session.test.ts (fake engines)
test('listen → frames → end gives one transcript; frames for another id are dropped; past MAX_UTTERANCE_MS the utterance ends with what came', ...);
test('the hint is capped at HINT_MAX_WORDS and passed to transcribe, and is gone from the session after end', ...);
test('speak synthesises each chunk\'s text exactly as sent (verbatim, P2); cancel mid-chunk stops frames and sends no audio_end', ...);
test('cache is per chunk: cache:true chunks synthesise once per (voice, text); cache:false chunks never enter the cache', ...);
test('the utterance buffer is zero-filled and released after end, cancel and close', ...);
// server.test.ts
test('no Authorization: Bearer <token> → closed 4401, logged as auth_fail only; bad JSON → bad_message; maxConnections+1 refused', ...);
// upstream-contract.test.ts (P1) — a plain ws client replays packages/core/test/fixtures/voice-upstream-session.json
test('the real server answers the fixture session message for message (fake engines), each reply passing parseUpstreamServerMsg', ...);
// log.test.ts
test('a string field is a compile error (// @ts-expect-error, checked by tsc in typecheck) and is dropped at runtime (D3)', ...);
```
```ts
// memory-only.test.ts — C-18, with a positive control (D1)
// Setup: TMPDIR, HOME and cwd are fresh empty dirs, snapshotted (recursive listing + sizes) before and after; stdout and
// stderr are captured; the fs write APIs are spied as a second net (fs and fs.promises write/append/open-for-write/cp/mkdtemp).
// Markers: the PCM carries 0x4B51 repeated; the fake STT returns "zebrapeanut71"; a speak chunk is "quagga-lentil-42".
test('a full session (hello, listen, 50 frames, end, speak, cancel, a second listen closed mid-utterance, a throwing engine whose message holds "zebrapeanut71") reaches transcript and audio_end, then: identical snapshots, no write spy call, neither marker nor the PCM as hex/base64/decimal in captured output', ...);
test('positive control: the same run with a deliberately leaking fake (writes the PCM to TMPDIR and logs the transcript) FAILS each assertion', ...);
```
- [ ] **2.2 Run** `npm test -w @kitchenquest/voice` → FAIL.
- [ ] **2.3 Implement.**
  - One `Session` per connection, holding at most one utterance and one speech at a time.
  - The frame buffer is a preallocated `Int16Array` sized to `MAX_UTTERANCE_MS`, zero-filled on release.
  - Engine errors send `failed` and log `engine_error` with no message.
  - The token is compared in constant time.
  - `boot` refuses production until Step 3's bench gate exists (a stub that always refuses).
- [ ] **2.4 Run** `npm test -w @kitchenquest/voice`, `npm run typecheck`, `npm run lint` → PASS. The repo's `npm test` → only `eval-gate.test.ts` fails.
- [ ] **2.5 Commit** `feat(voice): the voice service with fake engines, licence manifest and the memory-only proof`
