// No streaks, by vocabulary (M5 Step 12, spec §2.3, never rule 8, C28). A fast-check property in
// src/progress/never-rules.test.ts pins the behaviour (no reward depends on consecutive days); this pins the words: no function or identifier in the
// non-test source of core progress/, quests/, toolkit/, week/ or market/ (M6) names a streak, a run of days or a combo.
//
// Only `*.ts` files that are not `*.test.ts` are read. Comments, string literals, template text and regular
// expression literals are stripped first and identifiers alone are matched, so a test title ("no streak term"), a
// doc comment that explains the rule, and this file itself are never scanned. It lives in test/, beside
// progress-architecture.test.ts, because core's src/ is type-checked without Node's types.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly, sourceFiles } from './code-only';

const BANNED = /streak|consecutive|inARow|daysInARow|combo/i;
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const DIRS = ['progress', 'quests', 'toolkit', 'week', 'market', 'voice'];

/** The identifiers in a file's code that use a banned word. */
function streakIdentifiers(src: string): string[] {
  return (codeOnly(src).match(/[A-Za-z_$][\w$]*/g) ?? []).filter((id) => BANNED.test(id));
}

describe('no streak vocabulary in core progress/, quests/, toolkit/, week/ and market/ (C28, M6)', () => {
  it('the scan bites: a planted streak function, identifier or combo is caught; words in comments, strings and regexes are not', () => {
    const planted = [
      'export function longestStreak(days: string[]): number { return days.length; }',
      'const consecutiveDays = 3;',
      'const bonus = { inARow: true };',
      'function daysInARow() {}',
      'let comboMultiplier = 2;',
      'const t = `${streakCount} days`;',
      'type MealStreak = number;',
    ];
    for (const p of planted) expect(streakIdentifiers(p), p).not.toEqual([]);
    const clean = [
      '// no streak term here: a run of consecutive days earns nothing',
      '/* combo, inARow, daysInARow */ const ok = 1;',
      "test('no streak term', () => {});",
      'const s = "streak";',
      'const t = `no streak ${ok} in a row`;',
      'const re = /streak|consecutive/i;',
      'const x = a / b; const y = c / d;',
    ];
    for (const c of clean) expect(streakIdentifiers(c), c).toEqual([]);
  });

  it('every non-test source file is free of it', () => {
    const files = DIRS.flatMap((d) => sourceFiles(join(SRC, d)));
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    const bad = files.flatMap((f) => streakIdentifiers(readFileSync(f, 'utf8')).map((id) => `${f.slice(SRC.length)}: ${id}`));
    expect(bad).toEqual([]);
    expect(files.some((f) => f.endsWith(join('market', 'round.ts')))).toBe(true);
  });

  it('stripping keeps the code: identifiers of a real file survive', () => {
    const src = readFileSync(join(SRC, 'progress', 'rewards.ts'), 'utf8');
    const ids = new Set(codeOnly(src).match(/[A-Za-z_$][\w$]*/g));
    expect(ids.has('grantsFor')).toBe(true);
    expect(ids.has('grantsForBatch')).toBe(true);
  });
});
