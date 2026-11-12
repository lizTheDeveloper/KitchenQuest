// M7 Step 2: the voice service's configuration (spec §9, §7.7). Production refuses anything a dev box gets away with.
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadVoiceConfig } from '../src/config';
import { loadManifest, type VoiceManifest } from '../src/models';

const manifest = loadManifest();
const LONG_TOKEN = 'p'.repeat(32);

/** The manifest with no files recorded, as it was before Step 3 pinned them. */
function emptied(m: VoiceManifest): VoiceManifest {
  return { ...m, models: m.models.map((x) => ({ ...x, files: [] })) };
}

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
    expect(() => loadVoiceConfig(prod(), emptied(manifest))).toThrow(/piper-en_GB-northern_english_male-medium.*files/);
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
    // Fix round 1 (M8): port 0 is a random port the API could never find.
    expect(() => loadVoiceConfig(env({ VOICE_PORT: '0' }), manifest)).toThrow(/VOICE_PORT/);
    expect(() => loadVoiceConfig(env({ VOICE_MAX_CONNECTIONS: '0' }), manifest)).toThrow(/VOICE_MAX_CONNECTIONS/);
    expect(() => loadVoiceConfig(env({ VOICE_STT_MODEL: 'kokoro-82m-v1.0' }), manifest)).toThrow(/kokoro-82m-v1\.0/);
    expect(() => loadVoiceConfig(env({ VOICE_TTS_MODEL: 'faster-whisper-base.en', VOICE_PAN_VOICE: 'x' }), manifest)).toThrow(/faster-whisper-base\.en/);
    expect(() => loadVoiceConfig(env({ VOICE_TTS_MODEL: 'kokoro-82m-v1.0', VOICE_PAN_VOICE: 'northern_english_male' }), manifest)).toThrow(/northern_english_male/);
    expect(loadVoiceConfig(env({ VOICE_TTS_MODEL: 'kokoro-82m-v1.0', VOICE_PAN_VOICE: 'bm_fable' }), manifest).cast).toEqual(manifest.gpuCast.pan);
  });
});

describe('Step 3: the worker variables (P11) and the private bind address', () => {
  const env = (x: NodeJS.ProcessEnv = {}) => ({ VOICE_SERVICE_TOKEN: 'dev', ...x });
  const repo = fileURLToPath(new URL('../../../', import.meta.url));

  test('defaults: workerEngine real, modelsDir <repo>/apps/voice/models, python3, one worker per CPU, no accepted miss, host 127.0.0.1', () => {
    const c = loadVoiceConfig(env(), manifest);
    expect(c).toMatchObject({ workerEngine: 'real', modelsDir: join(repo, 'apps/voice/models'), python: 'python3', workers: availableParallelism(), host: '127.0.0.1' });
    expect(c.acceptLatencyMiss).toBeUndefined();
    // Blank is the default too (.env.example leaves VOICE_WORKERS blank).
    expect(loadVoiceConfig(env({ VOICE_WORKERS: '' }), manifest).workers).toBe(availableParallelism());
  });

  test('values: echo, a relative models dir is under the repo root, an absolute one is kept, workers 1..64, a YYYY-MM-DD accepted miss', () => {
    const c = loadVoiceConfig(env({ VOICE_WORKER_ENGINE: 'echo', VOICE_MODELS_DIR: 'x/models', VOICE_PYTHON: '/opt/venv/bin/python', VOICE_WORKERS: '3', VOICE_ACCEPT_LATENCY_MISS: '2026-12-01' }), manifest);
    expect(c).toMatchObject({ workerEngine: 'echo', modelsDir: join(repo, 'x/models'), python: '/opt/venv/bin/python', workers: 3, acceptLatencyMiss: '2026-12-01' });
    expect(loadVoiceConfig(env({ VOICE_MODELS_DIR: '/srv/models' }), manifest).modelsDir).toBe('/srv/models');
    expect(() => loadVoiceConfig(env({ VOICE_WORKER_ENGINE: 'gpu' }), manifest)).toThrow(/VOICE_WORKER_ENGINE/);
    expect(() => loadVoiceConfig(env({ VOICE_WORKERS: '0' }), manifest)).toThrow(/VOICE_WORKERS/);
    expect(() => loadVoiceConfig(env({ VOICE_WORKERS: '65' }), manifest)).toThrow(/VOICE_WORKERS/);
    expect(() => loadVoiceConfig(env({ VOICE_ACCEPT_LATENCY_MISS: 'yes' }), manifest)).toThrow(/VOICE_ACCEPT_LATENCY_MISS/);
  });

  test('production refuses the echo worker engine', () => {
    expect(() => loadVoiceConfig(prod({ VOICE_WORKER_ENGINE: 'echo' }), manifest)).toThrow(/VOICE_WORKER_ENGINE=echo/);
    expect(loadVoiceConfig(prod(), manifest).workerEngine).toBe('real');
  });

  test('C-38: VOICE_HOST must be a loopback or private address literal; the wildcard, a public address and a hostname are refused', () => {
    for (const ok of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.254', '192.168.1.20', '100.64.0.7', '::1', 'fd12:3456::1'])
      expect(loadVoiceConfig(env({ VOICE_HOST: ok }), manifest).host, ok).toBe(ok);
    for (const bad of ['0.0.0.0', '::', '8.8.8.8', '172.32.0.1', '192.169.0.1', '100.128.0.1', 'voice.internal', '2001:db8::1', '10.0.0.256'])
      expect(() => loadVoiceConfig(env({ VOICE_HOST: bad }), manifest), bad).toThrow(/VOICE_HOST/);
  });
});
