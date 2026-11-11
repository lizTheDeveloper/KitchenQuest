// Architecture pins for progress/ (spec §2.3, §16 never rules 3 and 8): grants can't see money or a run of days.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const files = (dir: string) =>
  readdirSync(join(SRC, dir))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fixtures.ts')
    .map((f) => join(dir, f));
const SOURCES = [...files('progress'), 'toolkit/toolkit.ts', 'toolkit/types.ts', 'toolkit/techniques.ts'];

test('progress/ and the toolkit never mention entitlements, money, a run of days, the clock or chance', () => {
  expect(SOURCES.length).toBeGreaterThanOrEqual(9);
  for (const file of SOURCES) {
    const src = readFileSync(join(SRC, file), 'utf8');
    expect(src, file).not.toMatch(/entitle|guild|subscription|purchase|price|payment/i);
    expect(src, file).not.toMatch(/streak|consecutive|daysInARow/i);
    expect(src, file).not.toMatch(/Date\.now|new Date\(\)|Math\.random/);
    // No module here reaches for the entitlement code or anything outside core.
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) expect(m[1], file).toMatch(/^\.\.?\//);
  }
});

test('progress/ never imports the recipe parser (browser-safe through engine.ts)', () => {
  for (const file of files('progress')) expect(readFileSync(join(SRC, file), 'utf8'), file).not.toMatch(/recipe\/parse|@cooklang/);
});
