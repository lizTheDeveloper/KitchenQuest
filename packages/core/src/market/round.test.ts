import { describe, expect, test } from 'vitest';
import { BRAM, question, SPICE, WEN } from './fixtures';
import { MAX_ROUND_ANSWERS, nextRound, optionOrder, ROUND_SIZE, scoreAnswer } from './round';
import type { AnsweredMap, StallQuestion } from './types';

const bank = (n: number): StallQuestion[] => Array.from({ length: n }, (_, i) => question(`q${i}`));
const idsOf = (qs: StallQuestion[]) => qs.map((q) => q.id);

describe('round (Ruling 7: deterministic, nothing random)', () => {
  test('the constants are the plan values', () => {
    expect(ROUND_SIZE).toBe(5);
    expect(MAX_ROUND_ANSWERS).toBe(10);
  });

  test('nextRound: never-correct first, then least recently answered, then file order; same input → same output', () => {
    const b = bank(8);
    expect(idsOf(nextRound(b, new Map()))).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    const answered: AnsweredMap = new Map([
      ['q0', { correct: true, lastAt: '2026-11-01' }],
      ['q1', { correct: false, lastAt: '2026-11-10' }],
      ['q2', { correct: false, lastAt: '2026-11-03' }],
      ['q3', { correct: true, lastAt: '2026-10-01' }],
      ['q5', { correct: false, lastAt: '2026-11-03' }],
    ]);
    // Never correct: q4, q6, q7 (never answered, so least recent), then q2 and q5 (same day: file order), then q1.
    // Then the correct ones, least recent first: q3, q0.
    expect(idsOf(nextRound(b, answered, 8))).toEqual(['q4', 'q6', 'q7', 'q2', 'q5', 'q1', 'q3', 'q0']);
    expect(idsOf(nextRound(b, answered))).toEqual(['q4', 'q6', 'q7', 'q2', 'q5']);
    expect(idsOf(nextRound(b, answered))).toEqual(idsOf(nextRound(b, answered)));
    expect(nextRound(b, answered, 0)).toEqual([]);
    expect(nextRound(b, answered, -3)).toEqual([]);
    expect(nextRound(b, answered, Number.NaN)).toEqual([]);
    expect(nextRound(b, answered, 2.7)).toHaveLength(2);
    expect(nextRound([], answered)).toEqual([]);
    // The bank is not changed.
    expect(idsOf(b)).toEqual(['q0', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']);
    // An answer for a question no longer in the bank changes nothing.
    expect(idsOf(nextRound(bank(2), new Map([['gone', { correct: false, lastAt: '2026-01-01' }]])))).toEqual(['q0', 'q1']);
  });

  test('optionOrder is a permutation, stable across calls, and differs between ids', () => {
    const allIds = [...BRAM.questions, ...BRAM.variants!.protein_counter!.questions, ...SPICE.questions, ...WEN.questions].map((q) => q.id);
    const seen = new Set<string>();
    for (const id of allIds) {
      for (const n of [1, 2, 3, 4]) {
        const o = optionOrder(id, n);
        expect([...o].sort()).toEqual(Array.from({ length: n }, (_, i) => i));
        expect(optionOrder(id, n)).toEqual(o);
      }
      seen.add(optionOrder(id, 4).join(''));
    }
    expect(seen.size).toBeGreaterThan(4);
    expect(optionOrder('anything', 0)).toEqual([]);
    expect(optionOrder('anything', -1)).toEqual([]);
    expect(optionOrder('anything', 1)).toEqual([0]);
    // Pinned values: the same order on every device, so a change to the hash is a visible test change.
    expect([optionOrder('bram-braise-cut', 4), optionOrder('wen-avocado-ripe', 3)]).toMatchInlineSnapshot(`
      [
        [
          0,
          1,
          3,
          2,
        ],
        [
          1,
          0,
          2,
        ],
      ]
    `);
  });

  test('the correct option, written first, is spread over display positions (the real banks are pinned in test/market-positions.test.ts)', () => {
    const qs = [...BRAM.questions, ...BRAM.variants!.protein_counter!.questions, ...SPICE.questions, ...WEN.questions];
    const at = [0, 0, 0];
    for (const q of qs) at[optionOrder(q.id, q.options.length).indexOf(0)]++;
    expect(at.filter((x) => x > 0).length).toBeGreaterThan(1);
  });

  test('scoreAnswer: file-index pick; out of range → valid false, correct false; a wrong answer returns its reaction and the explain', () => {
    const q = question('t', { options: [{ text: 'A', correct: false, reaction: 'Not A.' }, { text: 'B', correct: true, reaction: 'Yes, B.' }, { text: 'C', correct: false, reaction: 'Not C.' }], explain: 'B, because.' });
    expect(scoreAnswer(q, 1)).toEqual({ valid: true, correct: true, reaction: 'Yes, B.', explain: 'B, because.' });
    expect(scoreAnswer(q, 0)).toEqual({ valid: true, correct: false, reaction: 'Not A.', explain: 'B, because.' });
    expect(scoreAnswer(q, 2)).toEqual({ valid: true, correct: false, reaction: 'Not C.', explain: 'B, because.' });
    for (const pick of [-1, 3, 99, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = scoreAnswer(q, pick);
      expect(r.valid, String(pick)).toBe(false);
      expect(r.correct, String(pick)).toBe(false);
    }
    // The display position is never the pick: the file index is.
    const order = optionOrder(q.id, 3);
    expect(scoreAnswer(q, order.indexOf(1)).correct).toBe(order.indexOf(1) === 1);
  });
});
