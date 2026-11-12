// A stall round (Ruling 7): which questions come next, the order their options are shown in, and whether a pick is
// right. Nothing here is random and nothing reads the clock: the same inputs give the same round on every device.
// Correctness is decided here from the stall file, never by a client's or the model's claim (§2.1, Ruling 2).
import type { AnsweredMap, StallQuestion } from './types';

/** Questions offered in one round, at most. */
export const ROUND_SIZE = 5;
/** Answers one `stall_round` event may carry, at most (Step 3 checks it). */
export const MAX_ROUND_ANSWERS = 10;

/**
 * Ruling 7: never answered correctly first, then least recently answered (never answered counts as least recent),
 * then file order; at most `size`. The bank is the player's already-filtered `stallBank` questions.
 */
export function nextRound(bank: readonly StallQuestion[], answered: AnsweredMap, size: number = ROUND_SIZE): StallQuestion[] {
  const n = Number.isFinite(size) ? Math.max(0, Math.floor(size)) : 0;
  return bank
    .map((q, index) => {
      const a = answered.get(q.id);
      return { q, index, solved: a?.correct === true ? 1 : 0, lastAt: a?.lastAt ?? '' };
    })
    .sort((x, y) => x.solved - y.solved || (x.lastAt < y.lastAt ? -1 : x.lastAt > y.lastAt ? 1 : 0) || x.index - y.index)
    .slice(0, n)
    .map((e) => e.q);
}

/** 32-bit FNV-1a over the string's UTF-16 code units: the same number for the same id everywhere. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A fixed sequence of 32-bit numbers from a seed (xorshift32); the seed is never 0. */
function sequence(seed: number): () => number {
  let s = seed === 0 ? 0x9e3779b9 : seed;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/**
 * Ruling 7: a fixed permutation of 0..n-1 from a stable hash (FNV-1a) of the question id. Same on every device.
 * `order[k]` is the file index of the option shown at position k. The correct option is written first in most
 * questions, so file order would give the answer away; this spreads it.
 */
export function optionOrder(questionId: string, n: number): number[] {
  const len = Number.isInteger(n) && n > 0 ? n : 0;
  const order = Array.from({ length: len }, (_, i) => i);
  const next = sequence(fnv1a(questionId));
  for (let i = len - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * `pick` is the FILE index. Never throws: an out-of-range pick is { correct: false, valid: false }, with no reaction.
 * A wrong answer returns its own funny, true reaction and the explanation, and costs nothing.
 */
export function scoreAnswer(q: StallQuestion, pick: number): { valid: boolean; correct: boolean; reaction: string; explain: string } {
  const option = Number.isInteger(pick) && pick >= 0 && pick < q.options.length ? q.options[pick] : undefined;
  if (option === undefined) return { valid: false, correct: false, reaction: '', explain: q.explain };
  return { valid: true, correct: option.correct === true, reaction: option.reaction, explain: q.explain };
}
