# Step 3 — apps/voice: the Python worker, model pins and the operator latency benchmark

This step connects the engines the spike measured: faster-whisper for STT, and Piper or Kokoro for TTS. They run in a Python worker process behind Step 2's seam, which is also the GPL boundary (Ruling 14). It adds:
- sha256 pins for the model files;
- the operator benchmark the spec asks for (§12), with its documented results file;
- the production gate on that file (Ruling 3).

CI has no GPU or weights. It runs the worker's stdlib-only `echo` engine as `python3 -I -S` to prove the stdio contract (D4), and it never runs the benchmark.

**Files:**
- Create:
  - `apps/voice/worker/kq_voice_worker.py`: header `SPDX-License-Identifier: GPL-3.0-or-later`; engines `echo` (stdlib only), `whisper`, `kokoro`, and `piper` via a `piper --output-raw` subprocess; it imports nothing from the repo;
  - `apps/voice/worker/requirements.txt` (exact pins; operator only);
  - `apps/voice/src/engines/worker.ts`, `apps/voice/src/pins.ts`, `apps/voice/src/bench-gate.ts`;
  - `apps/voice/bench/{run,stats,schema,phrases}.ts`, `apps/voice/bench/results/.gitkeep`;
  - `apps/voice/README.md`: running, deploying and benchmarking; the browser echo/barge-in checklist (Ruling 7); host hardening;
  - `apps/voice/deploy/kq-voice.service`;
  - `apps/voice/test/{worker-contract,pins,bench-stats,bench-schema,bench-gate,deploy}.test.ts`.
- Modify:
  - `apps/voice/src/config.ts` and its test (P11): `workerEngine: 'echo' | 'real'`, `modelsDir`, `python`, `workers`, `acceptLatencyMiss`;
  - `apps/voice/src/boot.ts`: builds two `WorkerPool`s (STT and TTS) when `engine: 'worker'`, then runs `benchGate`;
  - `.env.example`: Step 2's `# Voice service (apps/voice)` block gains `VOICE_ENGINE=worker`, `VOICE_WORKER_ENGINE=real`, `VOICE_MODELS_DIR=apps/voice/models`, `VOICE_PYTHON=python3`, `VOICE_WORKERS=` (default: CPU count) and `# VOICE_ACCEPT_LATENCY_MISS=`.

**Interfaces:**
- Consumes: `SttEngine`, `TtsEngine`, `VoiceManifest`, `castable`, `VoiceConfig`, `boot` (Step 2); core `encodeFrame`, `UpstreamClientMsg`.
- Produces:
```ts
// worker stdio framing, both directions: u32 BE header length, JSON header, u32 BE payload length, payload
//   → { op:'stt', id, sampleRate:16000, hint } + PCM16      ← { op:'stt', id, text }
//   → { op:'tts', id, voice, text }  ← { op:'pcm', id, sampleRate } + PCM16 (repeated)  ← { op:'done', id }
//   → { op:'cancel', id }  → { op:'ping' } ← { op:'pong', engines }   ← { op:'error', id, kind:'stt'|'tts'|'model' } (kind only)
// echo engine test triggers (B3): a hint word "__kq_crash__" makes the process exit mid-job; tts text "__kq_long__" streams 10 s of PCM
export class WorkerPool {
  constructor(opts: { python: string; engine: 'echo' | 'whisper' | 'kokoro' | 'piper'; model: string; modelsDir: string; size: number });
  start(): Promise<void>; close(): Promise<void>;
}
export function workerStt(pool: WorkerPool, model: string): SttEngine;
export function workerTts(pool: WorkerPool, model: string, sampleRate: number): TtsEngine;
// src/pins.ts
export function verifyPins(entry: ModelEntry, modelsDir: string): Promise<void>;   // throws naming the first mismatch
// bench/schema.ts
export interface BenchRun {
  date: string; box: string; cpu: string; gpu: string | null;
  stack: { stt: string; tts: string; voice: string; llm: string; providers: string[] };
  utterances: { source: 'synthetic' | 'recorded'; n: number; noise: ('clean' | '15dB' | '5dB')[]; consentRecord: string | null };
  ms: Record<'firstAudio' | 'replyAudio' | 'stt' | 'turn' | 'ttsFirst', { p50: number; p90: number; p95: number }>;
  wer: { hinted: number; unhinted: number }; termRecall: { hinted: number; unhinted: number };
  meetsTarget: boolean;                       // replyAudio.p50 ≤ 1500 && replyAudio.p90 ≤ 2500
  manual?: { browser: 'chromium' | 'safari' | 'firefox'; echoBargeInPass: boolean }[];
}
export function parseBenchRun(x: unknown): BenchRun;   // recomputes meetsTarget; rejects a mismatch; consentRecord required when source = recorded
// bench/stats.ts
export function percentile(xs: readonly number[], p: number): number;   // nearest-rank
export function wer(ref: string, hyp: string): number;                   // the spike's normalisation
// src/bench-gate.ts
export function benchGate(cfg: VoiceConfig, latest: BenchRun | null, acceptMiss: string | undefined): { ok: true } | { ok: false; why: string };
```
- **What the worker does.**
  - It loads each engine once, offline (`HF_HUB_OFFLINE=1`), from `VOICE_MODELS_DIR`.
  - faster-whisper runs with `compute_type="int8"`, `beam_size=1` and `initial_prompt` = "Cooking assistant. Ingredients: " + hint.
  - Kokoro synthesises one chunk per call.
  - Python logging is at CRITICAL, and stderr carries only fixed kind words.
  - It writes no file, and drops each job's audio buffers when the job ends.
- **What the benchmark does.** `bench/run.ts` needs a running API (AI on, a throwaway database, a synthetic player) and a voice service with real engines, so it **cannot be exercised until Steps 5–6 exist**. Step 7 adds its `--selftest` (P15).
  1. **Utterances:** the spike's phrases plus 10 short openers, as synthetic speech mixed with clean, 15 dB and 5 dB noise. Or the operator's `--recordings <dir>`.
  2. **The round:** each utterance is streamed at real time, then `end`, then the transcript turn (with `heard` confirmed so the turn proceeds), then the reply is spoken.
  3. **The timings:** `firstAudio` (earcon or filler) and `replyAudio` (the gated number).
  4. **The output:** `bench/results/<date>-<box>.json`, copied to `bench/latest.json`.

  The first run measures the CPU default cast (Piper northern_english_male, C1). `tiny.en` and `base.en` are compared.
- **`apps/voice/README.md`** documents:
  - the results file: every `BenchRun` field, and that `latest.json` is what production boots against;
  - `--recordings` (C8): only volunteers' speech, with a written consent record named in `consentRecord`, deleted after the run, never copied into `results/`, never a player's;
  - how to read a miss: Ruling 3, in the spike's fallback order;
  - host hardening (C-18):
    - swap off on the voice and API hosts;
    - `LimitCORE=0` in `kq-voice.service` and, as a **manual duty**, in the API's unit (B3; no API unit exists in the repo yet);
    - `kernel.core_pattern=|/bin/false`;
    - the service bound to the private interface only (C-38);
  - the browser echo/barge-in checklist (Chromium, Safari, Firefox; speakers, no headphones), recorded in `manual[]`.

- [ ] **3.1 Write the failing tests.**
```ts
// worker-contract.test.ts — spawns `python3 -I -S worker/kq_voice_worker.py --engine echo` (fails, not skips, without python3)
test('ping → pong; stt echoes "echo <n samples>"; tts streams pcm then done; cancel stops a "__kq_long__" tts; an error carries a kind and no text', ...);
test('the -I -S run proves the echo path needs no site-packages: it starts and answers ping (D4)', ...);
test('"__kq_crash__" kills the worker mid-job: that job fails with kind upstream, the pool restarts it and serves the next job; stderr is counted, not logged (Review Focus 2)', ...);
test('cwd and TMPDIR snapshots are identical after a session; positive control: an echo run with --leak-for-test writes a file and the check fails (D1)', ...);
// pins.test.ts
test('verifyPins accepts matching sha256 and names the first mismatching or missing file', ...);
// bench-stats.test.ts
test('percentile is nearest-rank (1..10: p50 5, p90 9, p95 10); wer normalises "K-I-W-I" → "k i w i" and "12" → "twelve"', ...);
// bench-schema.test.ts
test('parseBenchRun rejects a missing field, a meetsTarget that disagrees with the numbers, and a recorded run with no consentRecord', ...);
test('every committed file under bench/results/ and bench/latest.json (if present) parses', ...);
// bench-gate.test.ts
test('no run → refused; another stack → refused; a miss → refused unless VOICE_ACCEPT_LATENCY_MISS equals its date; a pass → ok', ...);
test('boot({ NODE_ENV: "production", … }) rejects with the gate\'s reason; development boots without a run', ...);
// deploy.test.ts
test('kq-voice.service sets LimitCORE=0 and HF_HUB_OFFLINE=1 and binds VOICE_PORT on a private address variable', ...);
```
- [ ] **3.2 Run** `npm test -w @kitchenquest/voice -- worker-contract pins bench deploy config` → FAIL.
- [ ] **3.3 Implement.** CI never downloads a model.
- [ ] **3.4 Run** `npm test -w @kitchenquest/voice`, `npm run typecheck`, `npm run lint` → PASS. The repo's `npm test` → only `eval-gate.test.ts` fails.
- [ ] **3.5 Commit** `feat(voice): Python worker engines, model pins, the operator latency benchmark and its production gate`

**Operator task (not CI):** after Step 7, fill the `files` pins, run `npm run bench -w @kitchenquest/voice` on the target box, commit the results and `latest.json`, and report the numbers to the founder.
