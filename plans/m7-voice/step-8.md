# Step 8 — Game: the voice client (capture, VAD, socket, playback, providers, controller)

This step builds the device half of voice as a lazy library with no UI: microphone capture to 16 kHz frames, the browser VAD (spike: "Silero-style detector", here an energy detector with an adaptive floor), the socket, playback with instant stop (barge-in), the local earcon, the three provider adapters (Ruling 1), and the controller state machine that refuses to exist in Family Table mode (Ruling 9). Steps 9 and 10 put it on screen. Nothing here touches an `EVAL_FILES` path.

**Files:**
- Create:
  - `apps/game/src/voice/capture-worklet.ts`: an AudioWorkletProcessor that downmixes to mono, resamples to 16 kHz and posts 20 ms `Int16Array` frames plus each frame's RMS dBFS;
  - `apps/game/src/voice/capture.ts`, `vad.ts`, `socket.ts`, `playback.ts`, `earcon.ts`, `providers.ts`, `browser-speech.ts`, `controller.ts`, `speak-plan.ts`, `device-commands.ts` (interface only, Ruling 9), `index.ts`;
  - tests beside each;
  - `apps/game/build/voice-provider.ts` (+ test).
- Modify:
  - `apps/game/vite.config.ts`: `ws: true` on the `/api` proxy; the `kqVoiceProvider()` plugin;
  - `apps/game/index.html`: CSP adds `connect-src 'self'` (same-origin `wss:` for CSP3 browsers; older Safari needs the explicit directive) and `media-src 'self'`;
  - `apps/game/src/state/store.ts`: `settings.voice = { on: false, readAloud: true, handsFree: false }`, with the parse defaults for stored state;
  - `apps/game/src/mentor/dialogue.ts`: `Said.index` (the variant used);
  - `apps/game/src/virtual.d.ts`: `VITE_VOICE_PROVIDER`;
  - `apps/game/build/budget-plugin.ts` and its test: the voice chunk is not first paint; first paint ≤ M6's end value + 2 KB.

**Interfaces:**
- Consumes: core `ClientMsg`, `ServerMsg`, `parseServerMsg`, `encodeFrame`, `decodeFrame`, `SpeakItem`, `VoiceState`, `VoiceCloseReason`, and the constants (Step 1); `GET /voice/status`, `PUT /voice/accessibility` (Step 4); the `/api/voice` socket (Step 5).
- Produces:
```ts
// capture.ts
export interface Mic { onFrame(fn: (pcm: Int16Array, db: number) => void): void; close(): void }   // close stops every track
export function openMic(win: Window): Promise<Mic>;
//   getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } })
// vad.ts — pure, frame-driven
export interface VadOptions { startDb?: number; hangoverMs: number; minSpeechMs: number; preRollMs: number; raisedDb: number }
export interface Vad {
  push(pcm: Int16Array, db: number, tMs: number): { start?: Int16Array[] /* pre-roll */; speech?: Int16Array; end?: true };
  setPanSpeaking(on: boolean): void;   // raises the threshold by raisedDb and requires BARGE_IN_MIN_MS
}
export function createVad(opts: VadOptions): Vad;
// socket.ts
export interface VoiceSocket {
  send(m: ClientMsg): void; frame(id: number, pcm: Int16Array): void;
  on(fn: (m: ServerMsg) => void): () => void; onAudio(fn: (id: number, pcm: Int16Array) => void): () => void;
  close(): void; readonly closed: Promise<VoiceCloseReason | 'network'>;
}
export function openVoiceSocket(win: Window, hello: Extract<ClientMsg, { t: 'hello' }>): Promise<VoiceSocket>;   // wss://<origin>/api/voice
// playback.ts
export interface Player { play(id: number, pcm: Int16Array, sampleRate: number): void; stop(): void; readonly speaking: boolean; onIdle(fn: () => void): () => void }
export function createPlayer(win: Window): Player;
// earcon.ts
export function sizzle(win: Window): void;   // ~250 ms of filtered noise, procedural (no audio file); silent on failure
// providers.ts — THE game-side seam (Ruling 1)
export interface VoiceProvider {
  readonly kind: 'service' | 'browser';
  hello(conversationId: string | null, localDate: string): Promise<VoiceState>;
  listen(mode: VoiceMode): Utterance;
  speak(items: SpeakItem[], said: readonly string[]): Speech;   // browser speaks `said` locally; service sends items
  close(): void;
}
export interface Utterance { push(pcm: Int16Array): void; end(): Promise<{ text: string; tooLong: boolean }>; cancel(): void }
export interface Speech { readonly done: Promise<void>; stop(): void }
export function serviceProvider(win: Window): VoiceProvider;
export function browserProvider(win: Window): VoiceProvider;   // SpeechRecognition + speechSynthesis; dev only
export function providerKind(): 'service' | 'browser';         // import.meta.env.VITE_VOICE_PROVIDER, default 'service'
// speak-plan.ts — what is spoken is what is on screen, nothing else
export function speakPlan(items: readonly PanItem[], cards: readonly CardView[], said: (ref: LineRef) => Said): { items: SpeakItem[]; said: string[] };
//   'said' items and 'go' chips' lines, then each new card's readback lines, in screen order; never retry text, quick
//   labels, choices labels or anything not a Said with an index
// controller.ts
export type VoicePhase = 'off' | 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'resting';
export interface VoiceController {
  readonly phase: VoicePhase;
  press(): void; release(): void;                 // hold-to-talk; press while speaking = barge-in
  startHandsFree(): void; stopHandsFree(): void;  // Step 10
  say(reply: { items: SpeakItem[]; said: string[] }): void;
  onTranscript(fn: (text: string, tooLong: boolean) => void): () => void;
  onPhase(fn: (p: VoicePhase, state: VoiceState | null) => void): () => void;
  close(reason?: 'family_table' | 'child' | 'signed_out' | 'off'): void;   // stops mic tracks, closes the socket, at once
}
export function createVoiceController(deps: { win: Window; store: PlayerStore; provider: VoiceProvider; conversationId: () => string | null; childOn: () => boolean }): VoiceController;
//   throws 'Family Table mode never opens the microphone' when store.get().settings.familyTable (Ruling 9);
//   subscribes to the store and closes itself the moment familyTable turns on or voice.on turns off (Review Focus 4)
// device-commands.ts
export interface DeviceCommandRecognizer { start(onCommand: (c: CookCommand) => void): void; stop(): void }   // no implementation in M7
```
- `build/voice-provider.ts`: `kqVoiceProvider()` fails a production `vite build` when `VITE_VOICE_PROVIDER=browser`. The message names Ruling 1: the browser recogniser is an unreviewed processor.

- [ ] **8.1 Write the failing tests.**
```ts
// vad.test.ts — synthetic dB sequences
test('speech ≥ MIN_SPEECH_MS above the floor starts with PRE_ROLL_MS of pre-roll; end comes VAD_HANGOVER_MS after it falls', ...);
test('a 120 ms clatter does not start speech; a slowly rising noise floor is tracked, not reported as speech', ...);
test('while the Pan speaks, playback-shaped energy at the old threshold never starts speech; real speech above raisedDb for BARGE_IN_MIN_MS does (Review Focus 3)', ...);
test('frames between end and the next start are never returned (silence never leaves the device)', ...);
// socket.test.ts (a fake WebSocket)
test('hello first; binary frames carry the id; a malformed server message closes with bad_message; the close reason is surfaced', ...);
// playback.test.ts (fake AudioContext)
test('stop() halts the current buffer and drops the queue at once; audio for a stale id is ignored', ...);
// providers.test.ts
test('serviceProvider maps listen/end/cancel/speak to the protocol; a failed or closed socket ends the utterance with text ""', ...);
test('browserProvider speaks the `said` strings and never opens the voice socket or calls the API (WebSocket and fetch spies); providerKind defaults to service', ...);
// speak-plan.test.ts
test('speaks said lines and new card readbacks in screen order with their variant indexes; never a retry, quick or choices label', ...);
// controller.test.ts (fake provider, fake mic)
test('constructing in Family Table mode throws and never calls getUserMedia (spy) or opens a socket', ...);
test('turning Family Table on, or voice off, while listening stops every mic track and closes the socket at once; nothing more is sent', ...);
test('press while speaking = barge-in: playback stops, speech cancelled, a new utterance starts', ...);
test('release ends the utterance and plays the sizzle at once; a resting state goes to phase resting and opens no mic', ...);
test('a socket drop mid-utterance → phase idle, onTranscript not called, nothing retried from audio (Review Focus 5)', ...);
test('no transcript or frame is ever written to the store or localStorage (store and storage spies)', ...);
// capture.test.ts
test('openMic asks for echoCancellation, noiseSuppression and autoGainControl; close() stops every track', ...);
// voice-provider.test.ts
test('a production build with VITE_VOICE_PROVIDER=browser fails naming Ruling 1; development passes', ...);
// budget-plugin.test.ts (extended): no voice module in the first-paint graph; first paint ≤ M6 end + 2 KB
```
- [ ] **8.2 Run** `npm test -w @kitchenquest/game -- voice budget` → FAIL.
- [ ] **8.3 Implement.**
  - The worklet ships as a bundled module (`new URL('./capture-worklet.ts', import.meta.url)`), never a `blob:` URL, so `script-src 'self'` holds.
  - The VAD's `startDb` default is the floor + 12 dB.
  - The voice library is reached only by `import('../voice')`.
- [ ] **8.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, `npm run build -w @kitchenquest/game` (record first paint) → PASS. `git diff --stat` since Step 7 shows no `EVAL_FILES` path.
- [ ] **8.5 Commit** `feat(game): the voice client — capture, VAD, socket, playback, providers and the controller`
