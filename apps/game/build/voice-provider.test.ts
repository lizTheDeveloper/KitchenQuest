import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { kqVoiceProvider, voiceProviderProblem } from './voice-provider';

const root = fileURLToPath(new URL('..', import.meta.url));
const SPEECH = /webkitSpeechRecognition|SpeechRecognition/;

afterEach(() => { vi.unstubAllEnvs(); });

/** The voice library alone, built as `npm run build` would build it (NODE_ENV production), its code returned. */
async function buildVoice(nodeEnv: 'production' | 'development'): Promise<string> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  const out = await build({
    configFile: false, root, logLevel: 'silent', mode: nodeEnv,
    build: { write: false, minify: false, lib: { entry: 'src/voice/index.ts', formats: ['es'], fileName: 'voice' } },
  });
  const outputs = (Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[];
  return outputs.flatMap((o) => o.output).map((c) => (c.type === 'chunk' ? c.code : typeof c.source === 'string' ? c.source : '')).join('\n');
}

describe('kqVoiceProvider (Ruling 1, C6)', () => {
  test('any `vite build` asking for the browser provider is refused, whatever the mode; the dev server and the service provider pass', () => {
    for (const mode of ['production', 'staging', 'development']) {
      expect(voiceProviderProblem('build', { VITE_VOICE_PROVIDER: 'browser' }), mode).toMatch(/browser speech .*dev server only/);
    }
    expect(voiceProviderProblem('serve', { VITE_VOICE_PROVIDER: 'browser' })).toBeNull();
    expect(voiceProviderProblem('build', { VITE_VOICE_PROVIDER: 'service' })).toBeNull();
    expect(voiceProviderProblem('build', {})).toBeNull();
    expect(voiceProviderProblem('build', { VITE_VOICE_PROVIDER: 'webspeech' })).toMatch(/must be "service" or "browser"/);
  });

  test('kqVoiceProvider: `vite build --mode staging` with VITE_VOICE_PROVIDER=browser fails (the real config)', async () => {
    vi.stubEnv('VITE_VOICE_PROVIDER', 'browser');
    vi.stubEnv('KQ_APP_ORIGIN', 'https://example.test');
    await expect(build({ root, mode: 'staging', logLevel: 'silent', configLoader: 'runner', build: { write: false } })).rejects.toThrow(/browser speech/);
    expect(kqVoiceProvider().name).toBe('kq-voice-provider');
  });

  test('the production bundle of the voice library holds no "webkitSpeechRecognition" or "SpeechRecognition"; a development build does (positive control)', async () => {
    const prod = await buildVoice('production');
    expect(prod).toMatch(/kq-capture/); // the library was built
    expect(prod).not.toMatch(SPEECH);
    expect(prod).not.toMatch(/blob:/); // the worklet is a bundled module file, never a blob: URL
    const dev = await buildVoice('development');
    expect(dev).toMatch(SPEECH);
  }, 60_000);
});
