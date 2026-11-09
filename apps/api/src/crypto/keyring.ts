import { hkdfSync } from 'node:crypto';
import { inspect } from 'node:util';

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Parses `DATA_KEYS`: `id:base64,id:base64` or a JSON object `{"id":"base64"}`.
 * Every key must be 32 bytes. Errors name the key id, never the key.
 */
export function parseDataKeys(raw: string): Map<string, Buffer> {
  const s = raw.trim();
  let pairs: [string, unknown][];
  if (s.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new Error('must be id:base64 pairs or a JSON object of id to base64 key');
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      throw new Error('must be id:base64 pairs or a JSON object of id to base64 key');
    }
    pairs = Object.entries(obj);
  } else {
    pairs = s
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '')
      .map((e) => {
        const i = e.indexOf(':');
        return i < 0 ? [e, undefined] : [e.slice(0, i).trim(), e.slice(i + 1).trim()];
      });
  }
  if (pairs.length === 0) throw new Error('must contain at least one key');
  const keys = new Map<string, Buffer>();
  for (const [id, value] of pairs) {
    if (!KEY_ID.test(id)) throw new Error(`key id ${JSON.stringify(id.slice(0, 64))} must be 1-64 of A-Z a-z 0-9 _ -`);
    if (keys.has(id)) throw new Error(`key id "${id}" appears twice`);
    if (typeof value !== 'string' || !BASE64.test(value) || Buffer.from(value, 'base64').length !== 32) {
      throw new Error(`key "${id}" must be 32 bytes, base64 encoded (openssl rand -base64 32)`);
    }
    keys.set(id, Buffer.from(value, 'base64'));
  }
  return keys;
}

/**
 * The application key ring (C-2). New data keys are wrapped with the active
 * key; `all` (every key) is what `open()` gets, so rotating the active key
 * never makes older data unreadable. Never serializes or prints key bytes.
 */
export class Keyring {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly activeId: string;

  constructor(keys: ReadonlyMap<string, Buffer>, activeId: string) {
    for (const [id, k] of keys) if (k.length !== 32) throw new Error(`key "${id}" must be 32 bytes`);
    if (!keys.has(activeId)) throw new Error(`active key id "${activeId}" is not in the key ring`);
    this.#keys = new Map(keys);
    this.activeId = activeId;
  }

  get active(): Buffer {
    return this.#keys.get(this.activeId)!;
  }

  /** Every key by id, for `open()`. */
  get all(): Readonly<Record<string, Buffer>> {
    return Object.fromEntries(this.#keys);
  }

  get ids(): string[] {
    return [...this.#keys.keys()];
  }

  /**
   * A 32-byte key for one purpose (HKDF-SHA256 of the active key), so the ring
   * key itself is only ever used for wrapping data keys.
   */
  derive(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.active, Buffer.alloc(0), `kitchenquest/${purpose}`, 32));
  }

  toJSON(): { activeId: string; ids: string[] } {
    return { activeId: this.activeId, ids: this.ids };
  }

  [inspect.custom](): string {
    return `Keyring(${JSON.stringify(this.toJSON())})`;
  }
}
