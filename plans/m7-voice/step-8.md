# Step 8 — Game: the voice client (capture, VAD, socket, playback, providers, controller)

This step builds the device half of voice as a lazy library with no UI:
- capture to 16 kHz frames;
- the browser VAD, with an adaptive floor and raised thresholds while the Pan or a cook timer sounds (B9);
- the socket and playback with instant stop;
- the local earcon;
- the two provider adapters (Ruling 1; `browser` is dev-server only, C6);
- the controller, which **owns capture, VAD and the socket for both hold-to-talk and hands-free** (P10) and refuses to exist in Family Table mode (Ruling 9).

It also covers the build: the CSP `connect-src` (B8), the hands-free build gate (C9) and the first-paint budget. Nothing here touches an `EVAL_FILES` path.

**Files:**
- Create:
  - `apps/game/src/voice/{capture-worklet,capture,vad,socket,playback,earcon,providers,controller,speak-plan,device-commands,index}.ts`, and `apps/game/src/voice/browser-speech.ts` (imported only under `import.meta.env.DEV`);
  - tests beside each;
  - `apps/game/build/{voice-provider,hands-free-gate,csp}.ts`, with tests.
- Modify:
  - `apps/game/vite.config.ts`: `ws: true` on the `/api` proxy; the `kqVoiceProvider()`, `kqHandsFree()` and `kqCsp()` plugins;
  - `apps/game/index.html`: the CSP meta gains `connect-src 'self' %KQ_WS_ORIGIN%` and `media-src 'self'`. `kqCsp` fills the token from `KQ_APP_ORIGIN` (`wss://<host>`, or `ws://localhost:5173` in dev) and fails a build without `KQ_APP_ORIGIN`;
  - `apps/game/src/state/store.ts`: `settings.voice = { on: false, readAloud: true, handsFree: false }`, with parse defaults;
  - `apps/game/src/mentor/dialogue.ts`: `Said.index`;
  - `apps/game/src/virtual.d.ts`: `VITE_VOICE_PROVIDER`, `VITE_HANDS_FREE`;
  - `apps/game/build/budget-plugin.ts` and its test.

**Interfaces:**
- Consumes: core `ClientMsg`, `ServerMsg`, `parseServerMsg`, `encodeFrame`, `decodeFrame`, `SpeakItem`, `VoiceState`, `VoiceCloseReason`, `CookCommand` and the constants (Step 1); `/api/voice` (Step 5); `GET /voice/status`, `PUT /voice/family-table` (Steps 4 and 5).
- Produces:
```ts
// capture.ts
export interface Mic { onFrame(fn: (pcm: Int16Array, db: number) => void): void; close(): void }   // close stops every track
export function openMic(win: Window): Promise<Mic>;   // echoCancellation, noiseSuppression, autoGainControl, channelCount 1
// vad.ts — pure
export interface VadOptions { hangoverMs: number; minSpeechMs: number; preRollMs: number; raisedDb: number }
export interface Vad {
  push(pcm: Int16Array, db: number, tMs: number): { start?: Int16Array[]; speech?: Int16Array; end?: true };
  setRaised(source: 'pan' | 'timer', on: boolean): void;   // either raises the threshold by raisedDb and needs BARGE_IN_MIN_MS (B9)
}
export function createVad(opts: VadOptions): Vad;
// socket.ts
export interface VoiceSocket { send(m: ClientMsg): void; frame(id: number, pcm: Int16Array): void;
  on(fn: (m: ServerMsg) => void): () => void; onAudio(fn: (id: number, pcm: Int16Array) => void): () => void;
  close(): void; readonly closed: Promise<VoiceCloseReason | 'network'> }
export function openVoiceSocket(win: Window, hello: Extract<ClientMsg, { t: 'hello' }>): Promise<VoiceSocket>;
// playback.ts
export interface Player { play(id: number, pcm: Int16Array, sampleRate: number): void; stop(): void; readonly speaking: boolean; onIdle(fn: () => void): () => void }
export function createPlayer(win: Window): Player;
// earcon.ts
export function sizzle(win: Window): void;
// providers.ts — the game seam (Ruling 1)
export interface VoiceProvider {
  readonly kind: 'service' | 'browser';
  hello(conversationId: string | null, localDate: string): Promise<VoiceState>;
  listen(mode: VoiceMode): Utterance;
  speak(items: SpeakItem[], said: readonly string[]): Speech;    // browser: speaks `said` locally; service: sends items
  close(): void;
}
export interface Utterance { readonly id: number; push(pcm: Int16Array): void; end(): Promise<{ text: string; tooLong: boolean }>; cancel(): void }
export interface Speech { readonly done: Promise<void>; stop(): void }
export function serviceProvider(win: Window, store: PlayerStore): VoiceProvider;   // hello.familyTable from the store
export async function devBrowserProvider(win: Window): Promise<VoiceProvider>;    // throws outside import.meta.env.DEV
export function providerKind(): 'service' | 'browser';                            // always 'service' when !import.meta.env.DEV
// speak-plan.ts — only what is on screen, never text or vars (Ruling 15)
export function speakPlan(items: readonly PanItem[], cards: readonly CardView[], reply: { replyId: string | null }): { items: SpeakItem[]; said: string[] };
//   server line parts → { kind:'reply', replyId, part }; server cards → { kind:'card', proposalId };
//   device-only lines: var-free → { kind:'line', trigger, index }, else { kind:'line', trigger:'voice.check_screen', index:0 };
//   local cards → voice.check_screen; never retry, quick or choices labels
// controller.ts
export type VoicePhase = 'off' | 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'resting';
export interface VoiceController {
  readonly phase: VoicePhase; readonly lastUtteranceId: number | null;
  press(): void; release(): void;                          // press while speaking = barge-in
  startHandsFree(): void; stopHandsFree(): void;           // continuous VAD loop (P10)
  timerSounding(on: boolean): void;                        // B9
  say(plan: { items: SpeakItem[]; said: string[] }): void;
  onTranscript(fn: (text: string, tooLong: boolean, utteranceId: number) => void): () => void;
  onPhase(fn: (p: VoicePhase, state: VoiceState | null) => void): () => void;
  close(reason?: 'family_table' | 'child' | 'signed_out' | 'off'): void;
}
export function createVoiceController(deps: { win: Window; store: PlayerStore; provider: VoiceProvider; conversationId: () => string | null; childOn: () => boolean }): VoiceController;
//   throws in Family Table mode; closes itself the moment familyTable turns on, voice.on turns off or childOn() becomes true
// device-commands.ts
export interface DeviceCommandRecognizer { start(onCommand: (c: CookCommand) => void): void; stop(): void }   // no implementation (Ruling 9)
// build/hands-free-gate.ts (C9)
export function kqHandsFree(): Plugin;   // VITE_HANDS_FREE=on fails `vite build` unless apps/voice/bench/latest.json has manual[] for chromium, safari and firefox, all echoBargeInPass: true
// build/voice-provider.ts (C6)
export function kqVoiceProvider(): Plugin;   // command === 'build' with VITE_VOICE_PROVIDER=browser → fail, any mode
```

- [ ] **8.1 Write the failing tests.**
```ts
// vad.test.ts
test('speech ≥ MIN_SPEECH_MS above the floor starts with PRE_ROLL_MS of pre-roll; end comes VAD_HANGOVER_MS after it falls', ...);
test('a 120 ms clatter does not start speech; a slowly rising floor is tracked', ...);
test('with setRaised("pan"), playback-shaped energy at the old threshold never starts speech; speech above raisedDb for BARGE_IN_MIN_MS does (Review Focus 3)', ...);
test('with setRaised("timer"), a 2 s 880 Hz alarm envelope starts nothing (B9)', ...);
test('frames between end and the next start are never returned', ...);
// socket.test.ts / playback.test.ts / capture.test.ts (fakes)
test('hello first, carrying familyTable from the store; binary frames carry the id; a malformed server message closes with bad_message', ...);
test('stop() halts playback and drops the queue at once; audio for a stale id is ignored', ...);
test('openMic asks for echoCancellation, noiseSuppression and autoGainControl; close() stops every track', ...);
// providers.test.ts
test('serviceProvider maps listen/end/cancel/speak to the protocol; a closed socket ends the utterance with text ""', ...);
test('providerKind() is "service" and devBrowserProvider throws when import.meta.env.DEV is false', ...);
// speak-plan.test.ts
test('server parts → reply items with the replyId; server cards → card items; a device line with vars → voice.check_screen; no item has a text or vars key', ...);
// controller.test.ts (fake provider, fake mic)
test('constructing in Family Table mode throws; getUserMedia is never called and no socket opened (spies)', ...);
test('Family Table on, voice off, or childOn() true while listening → every track stopped and the socket closed at once; nothing more sent', ...);
test('press while speaking = barge-in: playback stops, cancel sent, a new utterance starts', ...);
test('startHandsFree: frames are sent only from pre-roll to end; a minute of hiss sends nothing', ...);
test('release plays the sizzle at once; a resting state → phase resting and no mic', ...);
test('a socket drop mid-utterance → phase idle, no onTranscript, nothing retried (Review Focus 5)', ...);
test('no transcript or frame is written to the store or localStorage: snapshots before/after, with a positive control that writes one and fails (D1)', ...);
// build tests
test('kqVoiceProvider: `vite build --mode staging` with VITE_VOICE_PROVIDER=browser fails; the production bundle contains no "webkitSpeechRecognition" or "SpeechRecognition" (grep of dist/)', ...);
test('kqHandsFree: VITE_HANDS_FREE=on fails without latest.json or with any failing browser, and passes with three passes', ...);
test('kqCsp: the built index.html has connect-src \'self\' wss://<KQ_APP_ORIGIN host>; a build without KQ_APP_ORIGIN fails', ...);
// budget-plugin.test.ts
test('no voice module is in the first-paint graph; first paint ≤ M6 end + 2 KB', ...);
```
- [ ] **8.2 Run** `npm test -w @kitchenquest/game -- voice build budget` → FAIL.
- [ ] **8.3 Implement.**
  - The worklet is a bundled module (`new URL('./capture-worklet.ts', import.meta.url)`), never a `blob:` URL.
  - The library is reached only by `import('../voice')`.
- [ ] **8.4 Run** `npm test -w @kitchenquest/game`, `npm run typecheck`, `KQ_APP_ORIGIN=https://example.test npm run build -w @kitchenquest/game` (record first paint) → PASS. Then check that no `EVAL_FILES` path changed since Step 7: `git diff --stat <step-7 commit>`.
- [ ] **8.5 Commit** `feat(game): the voice client — capture, VAD, socket, playback, providers, controller; CSP and build gates`
