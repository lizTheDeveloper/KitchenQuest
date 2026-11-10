// P-11 / N-9: AI may be switched on in production only once the AI processors' DPAs are signed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { AI_PROCESSOR_IDS, processorsNotReady } from './processors.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function register(processors: { id: string; dpa_status: string }[]): URL {
  const dir = mkdtempSync(join(tmpdir(), 'kq-processors-'));
  dirs.push(dir);
  const file = join(dir, 'processors.json');
  writeFileSync(file, JSON.stringify({ version: 1, processors }));
  return pathToFileURL(file);
}

describe('processorsNotReady', () => {
  test('names the AI processors', () => {
    expect(AI_PROCESSOR_IDS).toEqual(['openrouter', 'openrouter-model-providers']);
  });

  test('processorsNotReady lists unsigned ids', () => {
    const file = register([
      { id: 'openrouter', dpa_status: 'signed' },
      { id: 'openrouter-model-providers', dpa_status: 'unknown' },
    ]);
    expect(processorsNotReady(AI_PROCESSOR_IDS, file)).toEqual(['openrouter-model-providers']);
  });

  test('all signed → empty', () => {
    const file = register([
      { id: 'openrouter', dpa_status: 'signed' },
      { id: 'openrouter-model-providers', dpa_status: 'signed' },
      { id: 'hetzner', dpa_status: 'needed' },
    ]);
    expect(processorsNotReady(AI_PROCESSOR_IDS, file)).toEqual([]);
  });

  test('an id missing from the register is not ready', () => {
    const file = register([{ id: 'openrouter', dpa_status: 'signed' }]);
    expect(processorsNotReady(AI_PROCESSOR_IDS, file)).toEqual(['openrouter-model-providers']);
  });

  test('an unreadable or malformed register fails closed: every id is not ready', () => {
    const missing = new URL('file:///nonexistent/kq/processors.json');
    expect(processorsNotReady(AI_PROCESSOR_IDS, missing)).toEqual([...AI_PROCESSOR_IDS]);
    const dir = mkdtempSync(join(tmpdir(), 'kq-processors-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'p.json'), '{ not json');
    expect(processorsNotReady(AI_PROCESSOR_IDS, pathToFileURL(join(dir, 'p.json')))).toEqual([...AI_PROCESSOR_IDS]);
  });

  test('a duplicated id fails closed: the register is treated as malformed', () => {
    const file = register([
      { id: 'openrouter', dpa_status: 'signed' },
      { id: 'openrouter', dpa_status: 'unknown' },
      { id: 'openrouter-model-providers', dpa_status: 'signed' },
    ]);
    expect(processorsNotReady(AI_PROCESSOR_IDS, file)).toEqual([...AI_PROCESSOR_IDS]);
  });

  test('the committed register: the AI DPAs are not signed yet', () => {
    expect(processorsNotReady(AI_PROCESSOR_IDS)).toEqual(['openrouter', 'openrouter-model-providers']);
  });
});
