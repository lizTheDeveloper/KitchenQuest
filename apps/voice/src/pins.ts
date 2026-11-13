// M7 Step 3: a model's files must match their sha256 pins in data/voice-models.json before a worker loads them, so a
// swapped, truncated or tampered file (or another voice under the same name) never runs. Reads only.
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import type { ModelEntry } from './models.js';

function sha256(file: string): Promise<string | null> {
  return new Promise((done) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => done(null));
    stream.once('end', () => done(hash.digest('hex')));
  });
}

/** Throws naming the first file that is missing or does not match its pin, in manifest order. */
export async function verifyPins(entry: ModelEntry, modelsDir: string): Promise<void> {
  if (entry.files.length === 0) throw new Error(`voice model ${entry.id}: no files recorded in data/voice-models.json`);
  const root = resolve(modelsDir);
  for (const f of entry.files) {
    const p = normalize(f.path);
    const full = resolve(root, p);
    if (f.path === '' || isAbsolute(f.path) || p.startsWith('..') || !full.startsWith(root + sep)) throw new Error(`voice model ${entry.id}: ${f.path} is outside the models directory`);
  }
  for (const f of entry.files) {
    const got = await sha256(resolve(root, f.path));
    if (got === null) throw new Error(`voice model ${entry.id}: ${f.path} is missing from VOICE_MODELS_DIR (${root})`);
    if (got !== f.sha256) throw new Error(`voice model ${entry.id}: ${f.path} does not match its sha256 pin in data/voice-models.json`);
  }
  // Fix round 1 (M5): nothing else in the model's directories. An engine may read files it finds there (faster-whisper
  // reads preprocessor_config.json if present), so an unpinned file is refused like a changed one.
  const pinned = new Set(entry.files.map((f) => resolve(root, f.path)));
  for (const dir of new Set([...pinned].map((f) => dirname(f)))) {
    for (const name of readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()) {
      const full = join(dir, name);
      const isPinnedOrItsFolder = pinned.has(full) || [...pinned].some((p) => p.startsWith(full + sep));
      if (!isPinnedOrItsFolder)
        throw new Error(`voice model ${entry.id}: ${relative(root, full)} is not pinned in data/voice-models.json; remove it from VOICE_MODELS_DIR`);
    }
  }
}
