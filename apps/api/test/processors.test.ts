// C-7: Step 7's export lists processors from docs/compliance/processors.json.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const file = new URL('../../../docs/compliance/processors.json', import.meta.url);

describe('processors.json', () => {
  it('gives every processor the fields the export needs (name, purpose, country, contact)', () => {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { version: number; processors: Record<string, unknown>[] };
    expect(doc.version).toEqual(expect.any(Number));
    expect(doc.processors.length).toBeGreaterThan(0);
    for (const p of doc.processors) {
      for (const f of ['id', 'name', 'purpose', 'country', 'contact']) {
        expect(typeof p[f] === 'string' && (p[f]).length > 0, `${String(p.id)}.${f}`).toBe(true);
      }
    }
  });
});
