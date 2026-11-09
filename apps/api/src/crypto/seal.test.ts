import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contextBytes, open, seal, sealedKeyId } from './seal.js';

const key = randomBytes(32);
const keys = { k1: key };

describe('seal/open', () => {
  it('round-trips an object', () => {
    const v = { kind: 'allergy', ids: ['a', 'b'], n: 3, nested: { x: null } };
    expect(open<typeof v>(seal(v, key, 'k1'), keys)).toEqual(v);
  });

  it('does not contain the plaintext', () => {
    const sealed = seal({ ingredient: 'peanut-butter-unique' }, key, 'k1');
    expect(sealed.includes(Buffer.from('peanut-butter-unique'))).toBe(false);
  });

  it('fails when any byte is tampered with', () => {
    const sealed = seal({ a: 1 }, key, 'k1');
    for (let i = 0; i < sealed.length; i++) {
      const bad = Buffer.from(sealed);
      bad[i] ^= 0x01;
      expect(() => open(bad, keys), `byte ${i}`).toThrow();
    }
  });

  it('fails on truncation', () => {
    const sealed = seal({ a: 1 }, key, 'k1');
    expect(() => open(sealed.subarray(0, sealed.length - 1), keys)).toThrow();
    expect(() => open(Buffer.alloc(0), keys)).toThrow();
  });

  it('names an unknown key id', () => {
    const sealed = seal({ a: 1 }, key, 'old-key');
    expect(() => open(sealed, keys)).toThrow(/old-key/);
  });

  it('fails with the wrong key under the same id', () => {
    const sealed = seal({ a: 1 }, key, 'k1');
    expect(() => open(sealed, { k1: randomBytes(32) })).toThrow();
  });

  it('produces different output for the same input (random IV)', () => {
    const a = seal({ a: 1 }, key, 'k1');
    const b = seal({ a: 1 }, key, 'k1');
    expect(a.equals(b)).toBe(false);
  });

  it('opens after key rotation using the stored key id', () => {
    const k2 = randomBytes(32);
    const sealed = seal({ a: 1 }, key, 'k1');
    expect(open(sealed, { k1: key, k2 })).toEqual({ a: 1 });
  });

  it('rejects values JSON cannot encode', () => {
    expect(() => seal(undefined, key, 'k1')).toThrow(/JSON/);
    expect(() => seal(() => 1, key, 'k1')).toThrow(/JSON/);
  });

  it('rejects a key of the wrong length', () => {
    expect(() => seal({ a: 1 }, randomBytes(16), 'k1')).toThrow(/32/);
  });
});

describe('seal/open with context', () => {
  const ctx = contextBytes('rules', 'user-a', 'row-1');

  it('round-trips with the same context', () => {
    expect(open(seal({ a: 1 }, key, 'k1', ctx), keys, ctx)).toEqual({ a: 1 });
  });

  it('fails with a different context, or none', () => {
    const sealed = seal({ a: 1 }, key, 'k1', ctx);
    expect(() => open(sealed, keys, contextBytes('rules', 'user-b', 'row-1'))).toThrow();
    expect(() => open(sealed, keys, contextBytes('journeys', 'user-a', 'row-1'))).toThrow();
    expect(() => open(sealed, keys, contextBytes('rules', 'user-a', 'row-2'))).toThrow();
    expect(() => open(sealed, keys)).toThrow();
  });

  it('encodes parts unambiguously', () => {
    expect(contextBytes('ab', 'c').equals(contextBytes('a', 'bc'))).toBe(false);
  });

  it('reads the key id from the header', () => {
    expect(sealedKeyId(seal({ a: 1 }, key, 'k7'))).toBe('k7');
  });
});
