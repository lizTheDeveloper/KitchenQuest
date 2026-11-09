import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { open, seal } from './seal.js';

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
