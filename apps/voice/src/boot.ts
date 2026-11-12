// M7 P11: the voice service's start-up, separate from main.ts so tests can boot it with an env of their own.
//
// Order (Step 3): the config (which refuses what production must not run), then in production the latency bench gate
// (Ruling 3) and the sha256 pins of both models, then the worker pools (STT and TTS, each VOICE_WORKERS processes),
// then the server. Each step refuses before the next one costs anything.
import type { BenchRun } from '../bench/schema.js';
import { benchGate, loadLatestRun } from './bench-gate.js';
import { loadVoiceConfig, type VoiceConfig } from './config.js';
import { fakeStt, fakeTts } from './engines/fake.js';
import type { SttEngine, TtsEngine } from './engines/types.js';
import { WorkerPool, workerStt, workerTts, type WorkerEngineName } from './engines/worker.js';
import { createLogger } from './log.js';
import { allowedModel, castable, loadManifest, type VoiceManifest } from './models.js';
import { verifyPins } from './pins.js';
import { createVoiceServer } from './server.js';

export interface BootOptions {
  /** The latest benchmark run; tests pass one. Default: apps/voice/bench/latest.json. */
  latestRun?: () => BenchRun | null;
}

/** The worker engine that runs a manifest engine id. */
function ttsWorkerEngine(engine: string): WorkerEngineName {
  if (engine === 'piper-tts') return 'piper';
  if (engine === 'kokoro-onnx') return 'kokoro';
  throw new Error(`voice: no worker engine runs ${engine}`);
}

async function workerEngines(config: VoiceConfig, manifest: VoiceManifest): Promise<{ stt: SttEngine; tts: TtsEngine; pools: WorkerPool[] }> {
  const echo = config.workerEngine === 'echo';
  const base = { python: config.python, modelsDir: config.modelsDir, size: config.workers };
  const ttsEntry = castable(manifest, config.cast.model, config.cast.voice);
  const sttPool = new WorkerPool({ ...base, engine: echo ? 'echo' : 'whisper', model: config.sttModel });
  const ttsPool = new WorkerPool({ ...base, engine: echo ? 'echo' : ttsWorkerEngine(ttsEntry.engine), model: config.cast.model });
  const started = await Promise.allSettled([sttPool.start(), ttsPool.start()]);
  const failed = started.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed) {
    await Promise.all([sttPool.close(), ttsPool.close()]);
    throw failed.reason;
  }
  const rate = ttsPool.sampleRate;
  if (rate === null) throw new Error('voice: the TTS worker reported no sample rate');
  return {
    stt: workerStt(sttPool, echo ? 'echo-stt' : config.sttModel),
    tts: workerTts(ttsPool, echo ? 'echo-tts' : config.cast.model, rate),
    pools: [sttPool, ttsPool],
  };
}

export async function boot(env: NodeJS.ProcessEnv, opts: BootOptions = {}): Promise<{ port: number; close(): Promise<void> }> {
  const manifest = loadManifest();
  const config = loadVoiceConfig(env, manifest);
  if (config.production) {
    const gate = benchGate(config, (opts.latestRun ?? loadLatestRun)(), config.acceptLatencyMiss);
    if (!gate.ok) throw new Error(`voice: the latency bench gate (Ruling 3) refuses to start: ${gate.why}`);
  }
  let stt: SttEngine;
  let tts: TtsEngine;
  let pools: WorkerPool[] = [];
  if (config.engine === 'fake') {
    stt = fakeStt(() => 'this is the fake voice engine');
    tts = fakeTts();
  } else {
    if (config.workerEngine === 'real') {
      await verifyPins(allowedModel(manifest, config.sttModel, 'stt'), config.modelsDir);
      await verifyPins(castable(manifest, config.cast.model, config.cast.voice), config.modelsDir);
    }
    ({ stt, tts, pools } = await workerEngines(config, manifest));
  }
  const server = createVoiceServer({ config, stt, tts, log: createLogger() });
  let port: number;
  try {
    port = await server.listen(config.port);
  } catch (e) {
    await Promise.all(pools.map((p) => p.close()));
    throw e;
  }
  return {
    port,
    close: async () => {
      await server.close();
      await Promise.all(pools.map((p) => p.close()));
    },
  };
}
