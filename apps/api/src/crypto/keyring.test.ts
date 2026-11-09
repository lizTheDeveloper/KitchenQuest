import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Keyring, parseDataKeys } from './keyring.js';

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

  it('rejects a key that is not 32 bytes, naming its id but never its value', () => {
    const short = b64(randomBytes(16));
    expect(() => parseDataKeys(`k1:${b64(k1)},bad:${short}`)).toThrow(/"bad".*32 bytes/);
    try {
      parseDataKeys(`bad:${short}`);
    } catch (e) {
      expect((e as Error).message).not.toContain(short);
    }
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
    expect(() => new Keyring(new Map([['k1', k1]]), 'k9')).toThrow(/k9/);
  });

  it('derives a stable purpose key that differs per purpose and is not the key itself', () => {
    const ring = new Keyring(new Map([['k1', k1]]), 'k1');
    const a = ring.derive('audit-pseudonym');
    expect(a.length).toBe(32);
    expect(a.equals(ring.derive('audit-pseudonym'))).toBe(true);
    expect(a.equals(ring.derive('other'))).toBe(false);
    expect(a.equals(k1)).toBe(false);
  });
});
