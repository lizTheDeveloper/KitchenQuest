import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as engine from '../src/engine';
import * as index from '../src/index';

const ENTRY = fileURLToPath(new URL('../src/engine.ts', import.meta.url));

function resolveImport(from: string, spec: string): string {
  const base = resolve(dirname(from), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try the next */
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

describe('engine entry', () => {
  test('leaves parseRecipe out and keeps the rest', () => {
    expect('parseRecipe' in engine).toBe(false);
    for (const name of ['check', 'nutritionPerServing', 'IngredientGraph', 'DISCLAIMER', 'validateRules', 'timerSeconds', 'stepPlainText'])
      expect(name in engine, name).toBe(true);
  });

  test('exports the whole market module (M6): the device and the server decide the same way', async () => {
    const market = await import('../src/market/index');
    for (const name of Object.keys(market)) expect(name in engine, name).toBe(true);
    for (const name of ['stallBank', 'stallVariant', 'questionStatus', 'tipFor', 'faqFor', 'nextRound', 'optionOrder', 'scoreAnswer', 'validateStallFile', 'normalizeCountry', 'ROUND_SIZE', 'MAX_ROUND_ANSWERS', 'textMentions'])
      expect(name in engine, name).toBe(true);
  });

  test('exports equal index.ts exports minus parseRecipe', () => {
    const expected = Object.keys(index).filter((k) => k !== 'parseRecipe').sort();
    expect(Object.keys(engine).sort()).toEqual(expected);
  });

  test('engine.ts and everything it imports never mention the Cooklang package', () => {
    const seen = new Set<string>();
    const queue = [ENTRY];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toContain('@cooklang/cooklang');
      for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) queue.push(resolveImport(file, m[1]));
    }
    expect(seen.size).toBeGreaterThan(5);
  });
});
