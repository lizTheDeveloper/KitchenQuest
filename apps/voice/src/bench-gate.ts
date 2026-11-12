// M7 Ruling 3: production apps/voice boots only against evidence. apps/voice/bench/latest.json must record a run of the
// configured stack (STT model, TTS model and voice) that meets p50 ≤ 1.5 s and p90 ≤ 2.5 s on replyAudio, or a miss
// the founder has accepted by setting VOICE_ACCEPT_LATENCY_MISS to that run's date. The run is the operator's
// (`npm run bench -w @kitchenquest/voice` on the target box); apps/voice/README.md says how to read a miss.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LATENCY_TARGET_MS, parseBenchRun, type BenchRun } from '../bench/schema.js';
import type { VoiceConfig } from './config.js';

const LATEST_RUN = new URL('../bench/latest.json', import.meta.url);

/** The latest run, or null when the operator has not committed one. A file that does not parse throws, naming it. */
export function loadLatestRun(file: URL | string = LATEST_RUN): BenchRun | null {
  const path = typeof file === 'string' ? file : fileURLToPath(file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`${path}: cannot be read`);
  }
  try {
    return parseBenchRun(JSON.parse(text) as unknown);
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : 'not a benchmark run'}`);
  }
}

export function benchGate(cfg: VoiceConfig, latest: BenchRun | null, acceptMiss: string | undefined): { ok: true } | { ok: false; why: string } {
  if (latest === null)
    return { ok: false, why: 'no benchmark run in apps/voice/bench/latest.json: run `npm run bench -w @kitchenquest/voice` on this box and commit the result (Ruling 3)' };
  const want = { stt: cfg.sttModel, tts: cfg.cast.model, voice: cfg.cast.voice };
  const got = { stt: latest.stack.stt, tts: latest.stack.tts, voice: latest.stack.voice };
  if (want.stt !== got.stt || want.tts !== got.tts || want.voice !== got.voice)
    return {
      ok: false,
      why: `apps/voice/bench/latest.json (${latest.date}) measured another stack (${got.stt}, ${got.tts} ${got.voice}) than this service runs (${want.stt}, ${want.tts} ${want.voice}): benchmark this stack first`,
    };
  if (latest.meetsTarget || acceptMiss === latest.date) return { ok: true };
  const { p50, p90 } = latest.ms.replyAudio;
  return {
    ok: false,
    why:
      `the latest benchmark run (${latest.date}, ${latest.box}) missed the latency target: replyAudio p50 ${p50} ms, p90 ${p90} ms ` +
      `(target p50 ≤ ${LATENCY_TARGET_MS.p50} ms, p90 ≤ ${LATENCY_TARGET_MS.p90} ms). See "Reading a miss" in apps/voice/README.md; ` +
      `to accept this run, the founder sets VOICE_ACCEPT_LATENCY_MISS=${latest.date}`,
  };
}
