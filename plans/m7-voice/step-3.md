# Step 3 — apps/voice: the Python worker, model pins and the operator latency benchmark

This step connects the real engines the spike measured: faster-whisper for STT, and Kokoro or Piper for TTS. They run in a Python worker process behind Step 2's seam, which is also the GPL boundary (Ruling 14). It adds sha256 pins for the model files and the operator benchmark the spec asks for (§12: "latency benchmark (end of speech → first audio, p50/p95) on the target box"), with its documented results file, and the production gate on it (Ruling 3). CI has no GPU or weights. It runs the worker's stdlib-only `echo` engine to prove the stdio contract, and never runs the benchmark.

**Files:**
- Create:
  - `apps/voice/worker/kq_voice_worker.py`: header `SPDX-License-Identifier: GPL-3.0-or-later` (Ruling 14). Engines `echo` (stdlib only), `whisper`, `kokoro` and `piper` (the last via a `piper` subprocess, `--output-raw`). It imports nothing from the repo;
  - `apps/voice/worker/requirements.txt`: exact pins, operator only;
  - `apps/voice/src/engines/worker.ts`: `WorkerPool`, `workerStt`, `workerTts`;
  - `apps/voice/src/pins.ts`;
  - `apps/voice/bench/run.ts`, `bench/stats.ts`, `bench/schema.ts`, `bench/phrases.ts`, `bench/results/.gitkeep`;
  - `apps/voice/README.md`: running, deploying and benchmarking; the echo/barge-in browser checklist (Ruling 7); host hardening;
  - `apps/voice/deploy/kq-voice.service`: a systemd unit;
  - tests: `apps/voice/test/{worker-contract,pins,bench-stats,bench-schema,bench-gate,deploy}.test.ts`.
- Modify: `apps/voice/src/main.ts` (the `worker` engine, the bench gate); `.env.example` (a `# Voice service (apps/voice)` block: `VOICE_PORT`, `VOICE_SERVICE_TOKEN=`, `VOICE_ENGINE=worker`, `VOICE_STT_MODEL=faster-whisper-base.en`, `VOICE_TTS_MODEL=kokoro-82m-v1.0`, `VOICE_PAN_VOICE=bm_fable`, `VOICE_MODELS_DIR=apps/voice/models`, `VOICE_PYTHON=python3`, `VOICE_WORKERS=` (default: CPU count), `# VOICE_ACCEPT_LATENCY_MISS=`).

**Interfaces:**
- Consumes: `SttEngine`, `TtsEngine`, `VoiceManifest`, `castable`, `loadVoiceConfig` (Step 2); core `speechChunks`, `encodeFrame`.
- Produces:
```ts
// worker stdio framing (both directions): u32 BE header length, JSON header, u32 BE payload length, payload bytes
//   → { op:'stt', id, sampleRate:16000, hint:string }  + PCM16     ← { op:'stt', id, text }
//   → { op:'tts', id, voice, text }                                ← { op:'pcm', id, sampleRate } + PCM16 (repeated)  ← { op:'done', id }
//   → { op:'cancel', id }   → { op:'ping' } ← { op:'pong', engines:[…] }   ← { op:'error', id, kind:'stt'|'tts'|'model' }  (kind only, never text)
export class WorkerPool {                      // VOICE_WORKERS processes; one job per process (spike §6: one thread per STT job)
  constructor(opts: { python: string; engine: 'echo' | 'whisper' | 'kokoro' | 'piper'; model: string; modelsDir: string; size: number });
  start(): Promise<void>;                      // ping each; throws when one does not answer within 30 s
  close(): Promise<void>;
}
export function workerStt(pool: WorkerPool, model: string): SttEngine;
export function workerTts(pool: WorkerPool, model: string, sampleRate: number): TtsEngine;
// src/pins.ts
export function verifyPins(entry: ModelEntry, modelsDir: string): Promise<void>;   // sha256 every file; throws naming the first mismatch
// bench/schema.ts
export interface BenchRun {
  date: string; box: string; cpu: string; gpu: string | null;
  stack: { stt: string; tts: string; voice: string; llm: string; providers: string[] };
  utterances: { source: 'synthetic' | 'recorded'; n: number; noise: ('clean' | '15dB' | '5dB')[] };
  ms: Record<'firstAudio' | 'replyAudio' | 'stt' | 'turn' | 'ttsFirst', { p50: number; p90: number; p95: number }>;
  wer: { hinted: number; unhinted: number }; termRecall: { hinted: number; unhinted: number };
  meetsTarget: boolean;                         // replyAudio.p50 ≤ 1500 && replyAudio.p90 ≤ 2500
  manual?: { browser: string; echoBargeInPass: boolean }[];
}
export function parseBenchRun(x: unknown): BenchRun;   // throws; recomputes meetsTarget and rejects a mismatch
// bench/stats.ts
export function percentile(xs: readonly number[], p: number): number;   // nearest-rank
export function wer(ref: string, hyp: string): number;                   // the spike's normalisation
// main.ts bench gate (Ruling 3)
export function benchGate(cfg: VoiceConfig, latest: BenchRun | null, acceptMiss: string | undefined): { ok: true } | { ok: false; why: string };
```
- **What the worker does.**
  - Each engine is loaded once, offline (`HF_HUB_OFFLINE=1`), from `VOICE_MODELS_DIR`, with `faster-whisper` `compute_type="int8"`, `beam_size=1` and `initial_prompt` = "Cooking assistant. Ingredients: " + hint.
  - Kokoro synthesises one chunk per call (spike §3: its stream does not yield per sentence).
  - Python logging is set to CRITICAL. `sys.stderr` carries only fixed `kind` words.
  - The worker writes no file. Audio stays in `bytes` and `numpy` arrays dropped after each job.
- **What the benchmark does.** It needs a running API (AI on, a throwaway database with a synthetic player, as `eval:mentor`) and a running voice service with real engines.
  1. For each phrase in `bench/phrases.ts` (the spike's 10 cooking phrases plus 10 short Pan-turn openers) it builds an utterance: the TTS's own voices, as in the spike, mixed with `clean`, `15dB` and `5dB` noise, or the operator's `--recordings <dir>`.
  2. It streams the utterance to `/api/voice` at real time, sends `end`, posts the transcript as a transcript turn (with `heard` confirmed when a check comes back, so the turn proceeds) and speaks the reply.
  3. It times end → first earcon/filler audio (`firstAudio`) and end → first reply PCM frame (`replyAudio`, the gated number).
  4. It writes `bench/results/<date>-<box>.json` and copies it to `bench/latest.json`.
- `apps/voice/README.md` documents the results file:
  - each field of `BenchRun`, and that `latest.json` is what production boots against;
  - that `--recordings` audio is the operator's own or a consenting volunteer's, never a player's, and is never committed (`bench/audio/` is ignored);
  - how to read a miss: Ruling 3's options, in the spike's fallback order.
- **What the README's host hardening says.** These are C-18 duties no test can check:
  - swap off on the voice host (`swapoff -a`, no swap partition) and on the API host;
  - core dumps off (`LimitCORE=0` in `kq-voice.service` and in the API's unit; `kernel.core_pattern=|/bin/false`);
  - no `journald` capture of worker stderr beyond the kind words;
  - the service binds the private interface only (C-38).

- [ ] **3.1 Write the failing tests.**
```ts
// worker-contract.test.ts — runs `python3 worker/kq_voice_worker.py --engine echo` (CI has python3; the test fails, not skips, without it)
test('ping → pong; stt echoes "echo <n samples>"; tts streams pcm then done; cancel stops a long tts; an error reply carries a kind and no text', ...);
test('the worker writes no file: cwd and TMPDIR are fresh empty dirs and stay empty after a session', ...);
test('a worker that crashes mid-job fails that job with kind upstream, is restarted, and the pool keeps serving; its stderr is counted, not logged', ...);
test('the echo engine imports only the standard library (static scan of the echo code path for import lines)', ...);
// pins.test.ts
test('verifyPins accepts matching sha256 files and names the first mismatching or missing file', ...);
// bench-stats.test.ts
test('percentile is nearest-rank (p50 of 1..10 is 5, p90 is 9, p95 is 10); wer matches the spike normalisation ("K-I-W-I" → "k i w i", "12" → "twelve")', ...);
// bench-schema.test.ts
test('parseBenchRun accepts a full run and rejects a missing field or a meetsTarget that disagrees with the numbers', ...);
test('every committed file under bench/results/ and bench/latest.json (if present) parses', ...);
// bench-gate.test.ts
test('benchGate: no run → refused; a run of another stack → refused; a miss → refused unless VOICE_ACCEPT_LATENCY_MISS equals its date; a pass → ok', ...);
test('main refuses to boot in production when benchGate refuses, naming why; development boots without a run', ...);
// deploy.test.ts (Review Focus 2)
test('deploy/kq-voice.service sets LimitCORE=0, binds no public address in its ExecStart env, and sets HF_HUB_OFFLINE=1', ...);
```
- [ ] **3.2 Run** `npm test -w @kitchenquest/voice -- worker-contract pins bench` → FAIL.
- [ ] **3.3 Implement.** Then smoke-test by hand only if the operator box is available. CI never downloads a model.
- [ ] **3.4 Run** `npm test -w @kitchenquest/voice`, `npm run typecheck`, `npm run lint` → PASS. The whole repo's `npm test` → only `eval-gate.test.ts` fails.
- [ ] **3.5 Commit** `feat(voice): Python worker engines, model pins, the operator latency benchmark and its production gate`

**Operator task (not CI, not blocking the PR):** fill `files` pins in `data/voice-models.json` for the cast models. Run `npm run bench -w @kitchenquest/voice` on the target box (CPU first). Commit the results file and `latest.json`, and report the numbers to the founder.
