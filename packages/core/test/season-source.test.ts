// Regional honesty, pinned by reading the source (M6 Step 2, Ruling 9): no exported function of market/season.ts
// takes a default parameter, so no caller can get a region, a month or a hemisphere it did not pass. It lives in
// test/ because it reads the file with node:fs, and core's src/ is type-checked without Node's types.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const FILE = fileURLToPath(new URL('../src/market/season.ts', import.meta.url));

/** The source with comments and string/template literals blanked, so a doc comment can explain the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

/** The text between the parenthesis at `open` and its match. */
function paramsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error('unbalanced parentheses');
}

test('no exported function in season.ts declares a default parameter (source scan of the module)', () => {
  const src = code(readFileSync(FILE, 'utf8'));
  const exported = [...src.matchAll(/export\s+function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)];
  const names = exported.map((m) => m[1]);
  // The scan must see the module's whole surface, or it would pass on nothing.
  expect(names).toEqual(expect.arrayContaining(['seasonRegionFor', 'monthOf', 'seasonOf', 'seasonalQuestions', 'dishSeason', 'validateSeasonTable', 'seasonalAgrees', 'seasonNote', 'dishSeasonNote']));
  for (const m of exported) {
    const params = paramsAt(src, m.index + m[0].length - 1).replace(/=>/g, ' ');
    expect(params, `${m[1]}(${params})`).not.toMatch(/=/);
    expect(params, `${m[1]}(${params})`).not.toMatch(/\?\s*:/);
  }
  // No exported arrow function or const that could carry a default instead.
  expect(src).not.toMatch(/export\s+(const|let|var)\s+\w+\s*=\s*(async\s*)?\(/);
  // And nothing names a default region, month or hemisphere.
  expect(src).not.toMatch(/hemisphere|default(Region|Month|Season)|DEFAULT_/i);
});
