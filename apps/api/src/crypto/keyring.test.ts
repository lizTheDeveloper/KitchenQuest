import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring, parseDataKeys, parseKey } from './keyring.js';

const b64 = (b: Buffer) => b.toString('base64');
const k1 = randomBytes(32);
const k2 = randomBytes(32);

describe('parseDataKeys', () => {
  it('parses id:base64 pairs', () => {
    const keys = parseDataKeys(`k1:${b64(k1)}, k2:${b64(k2)}`);
    expect([...keys.keys()]).toEqual(['k1', 'k2']);
    expect(keys.get('k2')!.equals(k2)).toBe(true);
  });

  it('parses a JSON object', () => {
    const keys = parseDataKeys(JSON.stringify({ k1: b64(k1) }));
    expect(keys.get('k1')!.equals(k1)).toBe(true);
  });

  it('rejects a key that is not 32 bytes, naming its position', () => {
    expect(() => parseDataKeys(`k1:${b64(k1)},bad:${b64(randomBytes(16))}`)).toThrow(/entry 2 .*32-byte/);
  });

  /** Every way an entry can go wrong, with the raw key bytes in it; none may echo them. */
  it('never puts an id or key from a failing entry in the error', () => {
    const key = b64(k1);
    const unpadded = k1.toString('base64url'); // passes the id pattern
    const cases = [
      key, // the old single DATA_KEY format: no id, no colon
      `k2:${b64(k2)},${key}`,
      JSON.stringify({ [key]: 'k1' }), // swapped JSON pair
      JSON.stringify({ [unpadded]: 'k1' }),
      `${unpadded}:short`,
      `k1:${key.slice(0, 20)}`,
      `k1:${key},k1:${key}`,
    ];
    for (const raw of cases) {
      let message = '';
      try {
        parseDataKeys(raw);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, raw).not.toBe('');
      for (const secret of [key, unpadded, key.slice(0, 20), b64(k2)]) expect(message, raw).not.toContain(secret);
    }
  });

  it('names the position of a bare key', () => {
    expect(() => parseDataKeys(b64(k1))).toThrow(/entry 1 is not id:base64/);
  });

  it('rejects malformed entries, bad base64, bad ids and duplicates', () => {
    for (const bad of ['', 'k1', `:${b64(k1)}`, 'k1:not base64!!', `k 1:${b64(k1)}`, `k1:${b64(k1)},k1:${b64(k2)}`, '{"k1":1}', '[1]']) {
      expect(() => parseDataKeys(bad), bad).toThrow();
    }
  });
});

describe('Keyring', () => {
  it('exposes the active key and every key for opening', () => {
    const ring = new Keyring(new Map([['k1', k1], ['k2', k2]]), 'k2');
    expect(ring.activeId).toBe('k2');
    expect(ring.active.equals(k2)).toBe(true);
    expect(Object.keys(ring.all)).toEqual(['k1', 'k2']);
  });

  it('refuses an active id that is not in the ring', () => {
    expect(() => new Keyring(new Map([['k1', k1]]), 'k9')).toThrow(/active key id/);
  });

  it('does not serialize key bytes', () => {
    const ring = new Keyring(new Map([['k1', k1]]), 'k1');
    expect(JSON.stringify(ring)).toBe('{"activeId":"k1","ids":["k1"]}');
  });
});

describe('parseKey', () => {
  it('parses a 32-byte key that never serializes', () => {
    const k = parseKey(b64(k1));
    expect(k.bytes.equals(k1)).toBe(true);
    expect(JSON.stringify({ k })).toBe('{"k":"[secret]"}');
  });

  it('rejects other lengths without echoing the value', () => {
    const short = b64(randomBytes(16));
    expect(() => parseKey(short)).toThrow(expect.objectContaining({ message: expect.not.stringContaining(short) }));
    expect(() => parseKey('nope!')).toThrow(/32 bytes/);
  });
});
