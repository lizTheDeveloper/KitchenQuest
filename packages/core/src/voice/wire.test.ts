// Fix round 1 (M3): the strict checks the voice parsers share.
import { describe, expect, test } from 'vitest';
import { codePoints, hasExactKeys, isDate, isIndex, isShortString, isU32, plainObject } from './wire';

describe('wire checks', () => {
  test('plainObject accepts only plain JSON objects', () => {
    expect(plainObject({})).toBe(true);
    expect(plainObject(Object.create(null))).toBe(true);
    for (const x of [null, [], 'x', 1, new Date(), Object.create({ a: 1 })]) expect(plainObject(x), String(x)).toBe(false);
  });

  test('hasExactKeys needs every key and no other', () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ['a', 'b'])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ['a', 'b'])).toBe(false);
    expect(hasExactKeys({ a: undefined, c: 1 }, ['a', 'b'])).toBe(false);
  });

  test('isU32, isIndex, isShortString, isDate and codePoints', () => {
    expect([0, 1, 0xffff_ffff].every(isU32)).toBe(true);
    expect([-1, 0.5, 2 ** 32, Number.NaN, '1'].some(isU32)).toBe(false);
    expect(isIndex(2 ** 40)).toBe(true);
    expect(isIndex(-1)).toBe(false);
    expect(isShortString('ab', 2)).toBe(true);
    expect(isShortString('abc', 2)).toBe(false);
    expect(isShortString('', 2)).toBe(false);
    expect(isDate('2026-02-28')).toBe(true);
    expect(isDate('2026-02-30')).toBe(false);
    expect(codePoints('é😀a', 10)).toBe(3);
    // stops counting past the limit (bounded work on hostile input)
    expect(codePoints('x'.repeat(1_000_000), 10)).toBe(11);
  });
});
