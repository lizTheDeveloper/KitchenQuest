// Architecture pins for progress/, quests/, the toolkit and the week and book modules (spec §2.3, §16 never rules 3, 5
// and 8): grants and the loop's decisions can't see money or a run of days, and never read the clock or chance.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !/(^|\.)fixtures?\.ts$|\.fixture\.ts$/.test(f))
    .map((f) => join(dir, f));
const SOURCES = [...files('progress'), ...files('quests'), 'toolkit/toolkit.ts', 'toolkit/types.ts', 'toolkit/techniques.ts', 'toolkit/one-more.ts', ...files('week'), ...files('book')];

test('progress/, quests/, the toolkit, week/ and book/ never mention entitlements, money, a run of days, the clock or chance', () => {
  expect(SOURCES.length).toBeGreaterThanOrEqual(22);
  for (const file of SOURCES) {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src, file).not.toMatch(/entitle|guild|subscription|purchase|price|payment/i);
    expect(src, file).not.toMatch(/streak|consecutive|daysInARow/i);
    expect(src, file).not.toMatch(/Date\.now|new Date\(\)|Math\.random/);
    // No module here reaches for the entitlement code or anything outside core.
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) expect(m[1], file).toMatch(/^\.\.?\//);
  }
});

test('progress/, quests/, week/ and book/ never import the recipe parser (browser-safe through engine.ts)', () => {
  for (const file of [...files('progress'), ...files('quests'), 'toolkit/one-more.ts', ...files('week'), ...files('book')]) expect(readFileSync(join(SRC, file), 'utf8'), file).not.toMatch(/recipe\/parse|@cooklang/);
});
