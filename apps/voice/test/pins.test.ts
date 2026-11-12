// M7 Step 3: sha256 pins for the model files (data/voice-models.json `files`). Production verifies every file of the
// configured STT and TTS models before a worker loads it. No weights in the repo or in CI: these tests hash small
// stand-in files in a temporary directory.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { loadManifest, type ModelEntry } from '../src/models';
import { verifyPins } from '../src/pins';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kq-voice-pins-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function entry(files: { path: string; sha256: string }[]): ModelEntry {
  return { id: 'm', kind: 'stt', engine: 'faster-whisper', source: 'x', licence: 'MIT', commercial: true, attribution: null, status: 'allowed', files };
}

test('verifyPins accepts matching sha256 and names the first mismatching or missing file', async () => {
  mkdirSync(join(dir, 'm'));
  writeFileSync(join(dir, 'm/a.bin'), 'alpha');
  writeFileSync(join(dir, 'm/b.bin'), 'beta');
  const a = { path: 'm/a.bin', sha256: sha('alpha') };
  const b = { path: 'm/b.bin', sha256: sha('beta') };
  await expect(verifyPins(entry([a, b]), dir)).resolves.toBeUndefined();

  // The first mismatch is named, and only it: a later bad file is not reached.
  const badB = { path: 'm/b.bin', sha256: sha('gamma') };
  const missing = { path: 'm/c.bin', sha256: sha('c') };
  await expect(verifyPins(entry([a, badB, missing]), dir)).rejects.toThrow(/^voice model m: m\/b\.bin does not match its sha256 pin/);
  await expect(verifyPins(entry([a, missing, badB]), dir)).rejects.toThrow(/^voice model m: m\/c\.bin is missing/);
  // A changed byte is a mismatch.
  writeFileSync(join(dir, 'm/a.bin'), 'alphA');
  await expect(verifyPins(entry([a, b]), dir)).rejects.toThrow(/m\/a\.bin does not match/);
  // Fix round 1 (M5): a file in the model's directory that is not pinned is refused too (an engine may read extras).
  writeFileSync(join(dir, 'm/a.bin'), 'alpha');
  writeFileSync(join(dir, 'm/preprocessor_config.json'), '{}');
  await expect(verifyPins(entry([a, b]), dir)).rejects.toThrow(/^voice model m: m\/preprocessor_config\.json is not pinned/);
  rmSync(join(dir, 'm/preprocessor_config.json'));
  await expect(verifyPins(entry([a, b]), dir)).resolves.toBeUndefined();
  // No pins at all, or a path that leaves the models directory, is refused before any read.
  await expect(verifyPins(entry([]), dir)).rejects.toThrow(/no files/);
  for (const path of ['../m/a.bin', '/etc/passwd', 'm/../../x', ''])
    await expect(verifyPins(entry([{ path, sha256: sha('x') }]), dir), path).rejects.toThrow(/outside the models directory/);
});

test('every allowed model in data/voice-models.json is pinned: files under <id>/, each with a sha256, and the Hugging Face revision they came from; excluded and unverified models have none', () => {
  const manifest = loadManifest();
  for (const m of manifest.models) {
    if (m.status !== 'allowed') {
      expect(m.files, m.id).toEqual([]);
      continue;
    }
    expect(m.files.length, m.id).toBeGreaterThan(0);
    for (const f of m.files) {
      expect(f.path.startsWith(`${m.id}/`), f.path).toBe(true);
      expect(f.sha256, f.path).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(m.fetch?.revision, m.id).toMatch(/^[0-9a-f]{40}$/);
  }
  // The weights the engines load are among the pins.
  const files = (id: string) => manifest.models.find((m) => m.id === id)!.files.map((f) => f.path);
  expect(files('faster-whisper-base.en')).toContain('faster-whisper-base.en/model.bin');
  expect(files('piper-en_GB-northern_english_male-medium')).toEqual([
    'piper-en_GB-northern_english_male-medium/en_GB-northern_english_male-medium.onnx',
    'piper-en_GB-northern_english_male-medium/en_GB-northern_english_male-medium.onnx.json',
  ]);
  expect(files('kokoro-82m-v1.0')).toEqual(['kokoro-82m-v1.0/kokoro-v1.0.onnx', 'kokoro-82m-v1.0/voices-v1.0.bin']);
});
