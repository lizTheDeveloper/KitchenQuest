// M7 Step 2: the checked licence manifest (spec §7.7, Rulings 2 and 14). Every model and engine the voice service may
// load is in data/voice-models.json, and these tests hold it to the licensing rules.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { loadVoiceConfig } from '../src/config';
import { ALLOWED_LICENCES, castable, loadManifest, parseManifest, type VoiceManifest } from '../src/models';

const manifest = loadManifest();
const NC_OR_ND = /(^|-)(NC|ND)(-|$)/;
const TOKEN = 'a-dev-token-for-tests-only-0123456789';

function devEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { VOICE_SERVICE_TOKEN: TOKEN, ...extra };
}

describe('the voice licence manifest', () => {
  test('every allowed model: licence ∈ ALLOWED_LICENCES, commercial true, attribution non-empty when CC-BY*', () => {
    const allowed = manifest.models.filter((m) => m.status === 'allowed');
    expect(allowed.length).toBeGreaterThanOrEqual(5);
    for (const m of allowed) {
      expect(ALLOWED_LICENCES.has(m.licence), `${m.id} licence ${m.licence}`).toBe(true);
      expect(m.commercial, m.id).toBe(true);
      if (m.licence.startsWith('CC-BY')) expect(m.attribution?.trim(), `${m.id} attribution`).toBeTruthy();
    }
    expect([...ALLOWED_LICENCES].sort()).toEqual(['Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT']);
  });

  test('no allowed model or engine is NC or ND; ryan-high is present with status excluded', () => {
    for (const m of manifest.models.filter((x) => x.status === 'allowed')) expect(m.licence, m.id).not.toMatch(NC_OR_ND);
    for (const e of manifest.engines) expect(e.licence, e.id).not.toMatch(NC_OR_ND);
    const ryan = manifest.models.find((m) => m.id === 'piper-en_US-ryan-high');
    expect(ryan).toBeDefined();
    expect(ryan!.status).toBe('excluded');
    expect(ryan!.commercial).toBe(false);
    expect(ryan!.reason).toBe('non-commercial');
    // Every model that is NC or ND is excluded, never allowed or merely unverified.
    for (const m of manifest.models.filter((x) => NC_OR_ND.test(x.licence))) expect(m.status, m.id).toBe('excluded');
  });

  test('cast and gpuCast name allowed models and listed voices', () => {
    expect(manifest.cast.pan).toEqual({ model: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male' });
    expect(manifest.gpuCast.pan).toEqual({ model: 'kokoro-82m-v1.0', voice: 'bm_fable' });
    for (const c of [manifest.cast.pan, manifest.gpuCast.pan]) {
      const m = castable(manifest, c.model, c.voice);
      expect(m.status).toBe('allowed');
      expect(m.kind).toBe('tts');
      expect(m.voices).toContain(c.voice);
    }
    expect(() => castable(manifest, 'kokoro-82m-v1.0', 'northern_english_male')).toThrow(/northern_english_male/);
    expect(() => castable(manifest, 'faster-whisper-base.en', 'bm_fable')).toThrow(/faster-whisper-base\.en/);
    expect(() => castable(manifest, 'no-such-model', 'x')).toThrow(/no-such-model/);
  });

  test('every GPL engine is in-worker-process or separate-process; no in-process engine is GPL', () => {
    const gpl = manifest.engines.filter((e) => /GPL/.test(e.licence));
    expect(gpl.map((e) => e.id).sort()).toEqual(['espeak-ng', 'piper-tts']);
    for (const e of gpl) expect(['in-worker-process', 'separate-process'], e.id).toContain(e.boundary);
    for (const e of manifest.engines.filter((x) => x.boundary === 'in-process')) expect(e.licence, e.id).not.toMatch(/GPL/);
    expect(manifest.engines.find((e) => e.id === 'piper-tts')!.boundary).toBe('separate-process');
    // Every model names an engine the manifest records.
    for (const m of manifest.models) expect(manifest.engines.map((e) => e.id), m.id).toContain(m.engine);
  });

  test('loadVoiceConfig refuses ryan-high and every unverified model, naming the model', () => {
    const refused = manifest.models.filter((m) => m.status !== 'allowed');
    expect(refused.map((m) => m.id).sort()).toEqual(['piper-en_GB-alan-medium', 'piper-en_US-amy-medium', 'piper-en_US-lessac-medium', 'piper-en_US-ryan-high']);
    for (const m of refused) {
      const voice = m.voices![0]!;
      const run = () => loadVoiceConfig(devEnv({ VOICE_TTS_MODEL: m.id, VOICE_PAN_VOICE: voice }), manifest);
      expect(run, m.id).toThrow(m.id);
      expect(run, m.id).toThrow(m.status);
    }
    // The same refusal when a refused model is named as the STT model.
    expect(() => loadVoiceConfig(devEnv({ VOICE_STT_MODEL: 'piper-en_US-ryan-high' }), manifest)).toThrow('piper-en_US-ryan-high');
  });

  test('every VOICE_*_MODEL value in .env.example loads through loadVoiceConfig (D4: no grep)', () => {
    const text = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8');
    const env: NodeJS.ProcessEnv = {};
    for (const line of text.split('\n')) {
      const m = /^(VOICE_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) env[m[1]!] = m[2]!;
    }
    const modelKeys = Object.keys(env).filter((k) => k.endsWith('_MODEL'));
    expect(modelKeys.sort()).toEqual(['VOICE_STT_MODEL', 'VOICE_TTS_MODEL']);
    // The example leaves the token blank on purpose (a secret); everything else loads as written.
    expect(env.VOICE_SERVICE_TOKEN).toBe('');
    const config = loadVoiceConfig({ ...env, VOICE_SERVICE_TOKEN: TOKEN }, manifest);
    expect(config.sttModel).toBe(env.VOICE_STT_MODEL);
    expect(config.cast).toEqual({ model: env.VOICE_TTS_MODEL, voice: env.VOICE_PAN_VOICE });
    expect(config.engine).toBe(env.VOICE_ENGINE);
    expect(config.maxConnections).toBe(Number(env.VOICE_MAX_CONNECTIONS));
    expect(config.port).toBe(Number(env.VOICE_PORT));
  });

  const workerDir = fileURLToPath(new URL('../worker/', import.meta.url));
  const workerPresent = existsSync(workerDir);
  test.skipIf(!workerPresent)(
    'apps/voice/worker/ is checked when present: its SPDX header is GPL-3.0-or-later (skipped with a message until Step 3 creates it, then required; B2)',
    () => {
      const files = walk(workerDir).filter((f) => f.endsWith('.py'));
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) expect(readFileSync(f, 'utf8').split('\n').slice(0, 3).join('\n'), f).toMatch(/SPDX-License-Identifier: GPL-3\.0-or-later/);
    },
  );
  if (!workerPresent) {
    test('apps/voice/worker/ does not exist yet: the SPDX check above is skipped until M7 Step 3 creates the worker', () => {
      expect(existsSync(workerDir)).toBe(false);
    });
  }
});

describe('parseManifest', () => {
  test('a manifest with an unknown status, a missing licence or an engine with no boundary is refused', () => {
    const good = JSON.parse(readFileSync(fileURLToPath(new URL('../../../data/voice-models.json', import.meta.url)), 'utf8')) as VoiceManifest;
    const bad: unknown[] = [
      { ...good, models: [{ ...good.models[0], status: 'maybe' }] },
      { ...good, models: [{ ...good.models[0], licence: undefined }] },
      { ...good, engines: [{ id: 'x', licence: 'MIT' }] },
      { ...good, cast: undefined },
    ];
    for (const b of bad) expect(() => parseManifest(b)).toThrow(/voice-models/);
    expect(parseManifest(good)).toEqual(manifest);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
