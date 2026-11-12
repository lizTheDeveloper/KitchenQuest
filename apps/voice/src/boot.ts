// M7 P11: the voice service's start-up, separate from main.ts so tests can boot it with an env of their own.
import { loadVoiceConfig, type VoiceConfig } from './config.js';
import { fakeStt, fakeTts } from './engines/fake.js';
import type { SttEngine, TtsEngine } from './engines/types.js';
import { createLogger } from './log.js';
import { loadManifest } from './models.js';
import { createVoiceServer } from './server.js';

/**
 * Ruling 3: production boots only once the latency bench gate (Step 3, src/bench-gate.ts) finds a passing run of the
 * configured stack. Until that gate exists, production always refuses.
 */
function productionGate(config: VoiceConfig): void {
  if (config.production) throw new Error('voice: production boot needs the latency bench gate (M7 Step 3), which does not exist yet; refusing to start');
}

function engines(config: VoiceConfig): { stt: SttEngine; tts: TtsEngine } {
  if (config.engine === 'fake') return { stt: fakeStt(() => 'this is the fake voice engine'), tts: fakeTts() };
  throw new Error('VOICE_ENGINE=worker: the worker engine arrives in M7 Step 3');
}

export async function boot(env: NodeJS.ProcessEnv): Promise<{ port: number; close(): Promise<void> }> {
  const config = loadVoiceConfig(env, loadManifest());
  productionGate(config);
  const { stt, tts } = engines(config);
  const server = createVoiceServer({ config, stt, tts, log: createLogger() });
  const port = await server.listen(config.port);
  return { port, close: () => server.close() };
}
