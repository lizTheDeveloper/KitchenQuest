// M7 Step 2: the voice service's configuration (spec §9, §7.7). Production refuses anything a dev box gets away with.
import { describe, expect, test } from 'vitest';
import { loadVoiceConfig } from '../src/config';
import { loadManifest, type VoiceManifest } from '../src/models';

const manifest = loadManifest();
const LONG_TOKEN = 'p'.repeat(32);

/** The manifest with every allowed model's files filled, as an operator leaves it after Step 3's download. */
function filled(m: VoiceManifest): VoiceManifest {
  return { ...m, models: m.models.map((x) => (x.status === 'allowed' ? { ...x, files: [{ path: `${x.id}/model.bin`, sha256: 'a'.repeat(64) }] } : x)) };
}

const prod = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ NODE_ENV: 'production', VOICE_SERVICE_TOKEN: LONG_TOKEN, VOICE_ENGINE: 'worker', ...extra });

describe('loadVoiceConfig', () => {
  test('production refuses engine=fake, a token < 32 bytes, and an allowed cast model with empty files', () => {
    // Positive control: the same production env loads once files are filled, the engine is real and the token long.
    const ok = loadVoiceConfig(prod(), filled(manifest));
    expect(ok.production).toBe(true);
    expect(ok.engine).toBe('worker');
    expect(ok.token.length).toBe(32);

    expect(() => loadVoiceConfig(prod({ VOICE_ENGINE: 'fake' }), filled(manifest))).toThrow(/VOICE_ENGINE=fake/);
    expect(() => loadVoiceConfig(prod({ VOICE_SERVICE_TOKEN: 'p'.repeat(31) }), filled(manifest))).toThrow(/32 bytes/);
    // Bytes, not characters: 16 two-byte characters are 32 bytes.
    expect(loadVoiceConfig(prod({ VOICE_SERVICE_TOKEN: 'é'.repeat(16) }), filled(manifest)).token.length).toBe(32);
    expect(() => loadVoiceConfig(prod(), manifest)).toThrow(/piper-en_GB-northern_english_male-medium.*files/);
    // Only the STT model's files empty: refused, naming it.
    const sttEmpty = { ...filled(manifest), models: filled(manifest).models.map((x) => (x.id === 'faster-whisper-base.en' ? { ...x, files: [] } : x)) };
    expect(() => loadVoiceConfig(prod(), sttEmpty)).toThrow(/faster-whisper-base\.en.*files/);
  });

  test('defaults: the manifest cast, base.en, the fake engine, 50 connections; a blank or missing token is refused everywhere', () => {
    const c = loadVoiceConfig({ VOICE_SERVICE_TOKEN: 'dev' }, manifest);
    expect(c).toMatchObject({ production: false, engine: 'fake', sttModel: 'faster-whisper-base.en', cast: manifest.cast.pan, maxConnections: 50 });
    expect(Number.isInteger(c.port)).toBe(true);
    expect(() => loadVoiceConfig({}, manifest)).toThrow(/VOICE_SERVICE_TOKEN/);
    expect(() => loadVoiceConfig({ VOICE_SERVICE_TOKEN: '' }, manifest)).toThrow(/VOICE_SERVICE_TOKEN/);
  });

  test('bad values are refused by name: engine, port, connections, a TTS model as STT, an STT model as the cast', () => {
    const env = (x: NodeJS.ProcessEnv) => ({ VOICE_SERVICE_TOKEN: 'dev', ...x });
    expect(() => loadVoiceConfig(env({ VOICE_ENGINE: 'cloud' }), manifest)).toThrow(/VOICE_ENGINE/);
    expect(() => loadVoiceConfig(env({ VOICE_PORT: '70000' }), manifest)).toThrow(/VOICE_PORT/);
    expect(() => loadVoiceConfig(env({ VOICE_PORT: 'abc' }), manifest)).toThrow(/VOICE_PORT/);
    expect(() => loadVoiceConfig(env({ VOICE_MAX_CONNECTIONS: '0' }), manifest)).toThrow(/VOICE_MAX_CONNECTIONS/);
    expect(() => loadVoiceConfig(env({ VOICE_STT_MODEL: 'kokoro-82m-v1.0' }), manifest)).toThrow(/kokoro-82m-v1\.0/);
    expect(() => loadVoiceConfig(env({ VOICE_TTS_MODEL: 'faster-whisper-base.en', VOICE_PAN_VOICE: 'x' }), manifest)).toThrow(/faster-whisper-base\.en/);
    expect(() => loadVoiceConfig(env({ VOICE_TTS_MODEL: 'kokoro-82m-v1.0', VOICE_PAN_VOICE: 'northern_english_male' }), manifest)).toThrow(/northern_english_male/);
    expect(loadVoiceConfig(env({ VOICE_TTS_MODEL: 'kokoro-82m-v1.0', VOICE_PAN_VOICE: 'bm_fable' }), manifest).cast).toEqual(manifest.gpuCast.pan);
  });
});
