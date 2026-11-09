import { describe, it, expect } from 'vitest';
import { parseRecipe, RecipeError } from './parse';

const FULL = `---
title: Parippu
country: Sri Lanka
region: Southern Province
credit: Amma
cook: Nimali
difficulty: 2
skills:
  - simmering
  - tempering
servings: 4
license: CC-BY-SA-4.0
status: draft
---

Rinse @moong dal{100%g}. Add @water{500%ml} and @salt{}. Simmer ~{20%minutes}.
`;

function problemsOf(src: string): string[] {
  try {
    parseRecipe(src);
  } catch (e) {
    expect(e).toBeInstanceOf(RecipeError);
    return (e as RecipeError).problems;
  }
  throw new Error('expected parseRecipe to throw');
}

const withFront = (lines: string) => `---\n${lines}\n---\n\nStir @salt{}.\n`;
const VALID_LINES = `title: T
country: C
region: R
credit: X
cook: Y
difficulty: 3
skills: [a]
servings: 2
license: CC-BY-SA-4.0
status: draft`;
const swap = (key: string, line: string) =>
  VALID_LINES.split('\n').map((l) => (l.startsWith(key + ':') ? line : l)).join('\n');

describe('parseRecipe', () => {
  it('parses front matter and ingredients', () => {
    const r = parseRecipe(FULL);
    expect(r.meta.title).toBe('Parippu');
    expect(r.meta.skills).toEqual(['simmering', 'tempering']);
    expect(r.meta.sacred).toBe(false);
    expect(r.ingredients).toEqual([
      { name: 'moong dal', quantity: 100, unit: 'g', note: null },
      { name: 'water', quantity: 500, unit: 'ml', note: null },
      { name: 'salt', quantity: null, unit: null, note: null },
    ]);
    expect(r.timers[0]).toEqual({ name: null, quantity: 20, unit: 'minutes' });
  });

  it('reports every missing key at once', () => {
    const problems = problemsOf(withFront('title: Only'));
    for (const k of ['country', 'region', 'credit', 'cook', 'difficulty', 'skills', 'servings', 'license', 'status']) {
      expect(problems.filter((p) => p.includes(k))).toHaveLength(1);
    }
    expect(problems.some((p) => p.includes('title'))).toBe(false);
  });

  it('rejects bad values', () => {
    expect(problemsOf(withFront(swap('difficulty', 'difficulty: 7'))).some((p) => p.includes('difficulty'))).toBe(true);
    expect(problemsOf(withFront(swap('status', 'status: final'))).some((p) => p.includes('status'))).toBe(true);
    expect(problemsOf(withFront(swap('servings', 'servings: 0'))).some((p) => p.includes('servings'))).toBe(true);
    expect(problemsOf(withFront(swap('skills', 'skills: knife'))).some((p) => p.includes('skills'))).toBe(true);
  });

  it('keeps the source', () => {
    expect(parseRecipe(FULL).source).toBe(FULL);
  });

  it('reads sacred when present', () => {
    expect(parseRecipe(withFront(VALID_LINES + '\nsacred: true')).meta.sacred).toBe(true);
  });

  it('rejects malformed Cooklang', () => {
    const problems = problemsOf(withFront(VALID_LINES).replace('Stir @salt{}.', 'Simmer ~{abc%min}.'));
    expect(problems[0]).toMatch(/Timer value is text/);
  });

  it('rejects malformed front matter YAML', () => {
    const problems = problemsOf(withFront('title: [unclosed'));
    expect(problems[0]).toMatch(/YAML/);
  });

  it('turns a parser crash into a RecipeError', () => {
    const problems = problemsOf(withFront(VALID_LINES).replace('Stir @salt{}.', 'Add @water{1/0%ml}.'));
    expect(problems[0]).toMatch(/parser failed/);
  });
});
