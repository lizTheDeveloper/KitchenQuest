// No pressure mechanics in the market, by vocabulary (M6 Step 11; the milestone's no-pressure rule, spec §16 never
// rules 4, 5 and 8, the Octalysis audit). The behaviour is pinned elsewhere (round.test.ts: a round can be left at
// any question, the order is deterministic, a wrong answer costs nothing); this pins the words: no function or
// identifier in the non-test source of core market/ names a streak, a run, a combo, a multiplier, a countdown, a time
// left, lives or a deadline.
//
// As M5 C28 (no-streak.test.ts): only `*.ts` files that are not `*.test.ts` are read, and comments, string literals,
// template text and regular expression literals are stripped first, so only identifiers are matched. It lives in
// test/ because core's src/ is type-checked without Node's types (C6).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { codeOnly, sourceFiles } from './code-only';

/** step-11.md, verbatim. */
const PRESSURE = /streak|consecutive|inARow|combo|multiplier|countdown|timeLeft|lives|deadline/i;
const MARKET = fileURLToPath(new URL('../src/market/', import.meta.url));

const pressureIdentifiers = (src: string): string[] => (codeOnly(src).match(/[A-Za-z_$][\w$]*/g) ?? []).filter((id) => PRESSURE.test(id));

describe('no pressure vocabulary in core market/ (M6 Step 11)', () => {
  it('the scan bites: each planted pressure identifier is caught; the same words in comments, strings and regexes are not', () => {
    const planted = [
      'let answerStreak = 0;',
      'const consecutiveRight = 2;',
      'const bonus = { inARow: 3 };',
      'function comboFor(n: number) { return n; }',
      'const xpMultiplier = 2;',
      'export function startCountdown() {}',
      'const timeLeft = 30;',
      'let livesRemaining = 3;',
      'type RoundDeadline = number;',
      'const t = `${timeLeft}s`;',
    ];
    for (const p of planted) expect(pressureIdentifiers(p), p).not.toEqual([]);
    const clean = [
      '// no countdown, no lives, no deadline: leaving costs nothing',
      '/* combo, multiplier, timeLeft */ const ok = 1;',
      "const line = 'three in a row is not a thing here';",
      'const t = `no streak ${ok} and no countdown`;',
      'const re = /countdown|deadline/i;',
      'const roundSize = 5; const half = roundSize / 2;',
    ];
    for (const c of clean) expect(pressureIdentifiers(c), c).toEqual([]);
  });

  it('every non-test source file in core market/ is free of it', () => {
    const files = sourceFiles(MARKET);
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    for (const name of ['bank.ts', 'round.ts', 'season.ts', 'validate.ts', 'index.ts']) {
      expect(files.some((f) => f.endsWith(join('market', name))), name).toBe(true);
    }
    const bad = files.flatMap((f) => pressureIdentifiers(readFileSync(f, 'utf8')).map((id) => `${f.slice(MARKET.length)}: ${id}`));
    expect(bad).toEqual([]);
  });

  it('stripping keeps the code: the round module\'s own identifiers survive', () => {
    const ids = new Set(codeOnly(readFileSync(join(MARKET, 'round.ts'), 'utf8')).match(/[A-Za-z_$][\w$]*/g));
    expect(ids.has('scoreAnswer')).toBe(true);
    expect(ids.has('nextRound')).toBe(true);
  });
});
