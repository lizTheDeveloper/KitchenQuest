// M7 Step 3: the benchmark's statistics. Nearest-rank percentiles, and word error rate with the spike's normalisation
// (docs/spikes/2026-11-09-voice-latency.md: lowercased, punctuation and hyphens removed, "12" → "twelve", "2" → "two").
import { expect, test } from 'vitest';
import { corpusWer, normaliseForWer, percentile, termRecall, wer } from '../bench/stats';

test('percentile is nearest-rank (1..10: p50 5, p90 9, p95 10); wer normalises "K-I-W-I" → "k i w i" and "12" → "twelve"', () => {
  const xs = [7, 3, 10, 1, 5, 9, 2, 8, 4, 6]; // unsorted on purpose
  expect(percentile(xs, 50)).toBe(5);
  expect(percentile(xs, 90)).toBe(9);
  expect(percentile(xs, 95)).toBe(10);
  expect(percentile(xs, 100)).toBe(10);
  expect(percentile([42], 50)).toBe(42);
  expect(() => percentile([], 50)).toThrow();
  expect(xs).toEqual([7, 3, 10, 1, 5, 9, 2, 8, 4, 6]); // not sorted in place

  expect(normaliseForWer("I'm allergic to kiwi, K-I-W-I")).toBe("i'm allergic to kiwi k i w i");
  expect(normaliseForWer('Set a timer for 12 minutes.')).toBe('set a timer for twelve minutes');
  expect(normaliseForWer('log 2 eggs')).toBe('log two eggs');
  expect(wer('set a timer for twelve minutes', 'Set a timer for 12 minutes!')).toBe(0);
  expect(wer("I'm allergic to kiwi, K-I-W-I", "i'm allergic to kiwi k i w i")).toBe(0);
  // One substitution in five words, one deletion in four, one insertion in two.
  expect(wer('do we have any epazote', 'do we have any episodes')).toBeCloseTo(1 / 5);
  expect(wer('how long simmer dal', 'how long dal')).toBeCloseTo(1 / 4);
  expect(wer('pad thai', 'pad thai time')).toBeCloseTo(1 / 2);
  // Corpus WER sums edits over reference words, as jiwer does for a list.
  expect(corpusWer([['a b c d', 'a b c x'], ['e f', 'e f']])).toBeCloseTo(1 / 6);
  // Term recall: the hard words of the references heard exactly.
  expect(termRecall([["swap soy sauce for tamari", 'swap soy sauce for tomorrow'], ['add gochujang', 'add gochujang']], ['tamari', 'gochujang', 'kiwi'])).toBeCloseTo(1 / 2);
});
