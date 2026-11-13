import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { kqVoiceProvider, voiceProviderProblem } from './voice-provider';

const root = fileURLToPath(new URL('..', import.meta.url));
const SPEECH = /webkitSpeechRecognition|SpeechRecognition/;

afterEach(() => { vi.unstubAllEnvs(); });

/** The voice library alone, built as `npm run build` builds the app (NODE_ENV production): its code, and its files. */
async function buildVoice(nodeEnv: 'production' | 'development'): Promise<{ code: string; files: string[] }> {
  vi.stubEnv('NODE_ENV', nodeEnv);
  const out = await build({
    configFile: false, root, logLevel: 'silent', mode: nodeEnv,
    build: { write: false, minify: false, rollupOptions: { input: 'src/voice/index.ts', external: [/^virtual:/], preserveEntrySignatures: 'strict' } },
  });
  const all = ((Array.isArray(out) ? out : [out]) as Rollup.RollupOutput[]).flatMap((o) => o.output);
  return {
    code: all.map((c) => (c.type === 'chunk' ? c.code : typeof c.source === 'string' ? c.source : '')).join('\n'),
    files: all.map((c) => c.fileName),
  };
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
    expect(prod.code).toMatch(/kq-capture/); // the library was built
    expect(prod.code).not.toMatch(SPEECH);
    // The worklet is a bundled module file of its own, never a blob: or data: URL.
    const worklet = prod.files.find((f) => /^assets\/capture-worklet-[\w-]+\.js$/.test(f));
    expect(worklet).toBeDefined();
    expect(prod.code).toContain(`"/${worklet!}"`);
    expect(prod.code).not.toMatch(/blob:|data:text\/javascript/);
    const dev = await buildVoice('development');
    expect(dev.code).toMatch(SPEECH);
  }, 60_000);
});
