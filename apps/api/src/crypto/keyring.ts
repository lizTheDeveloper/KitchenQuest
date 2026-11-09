import { inspect } from 'node:util';

const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const SHAPE = 'must be id:base64 pairs or a JSON object of id to base64 key';

/**
 * Parses `DATA_KEYS`: `id:base64,id:base64` or a JSON object `{"id":"base64"}`.
 * Every key must be 32 bytes. Errors name an entry by position only, never
 * its id or value: a malformed entry (a bare key, a swapped JSON pair) would
 * otherwise print key material into the boot log.
 */
export function parseDataKeys(raw: string): Map<string, Buffer> {
  const s = raw.trim();
  let pairs: [unknown, unknown][];
  if (s.startsWith('{')) {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new Error(SHAPE);
    }
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new Error(SHAPE);
    pairs = Object.entries(obj);
  } else {
    pairs = s
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e !== '')
      .map((e): [unknown, unknown] => {
        const i = e.indexOf(':');
        return i < 0 ? [undefined, undefined] : [e.slice(0, i).trim(), e.slice(i + 1).trim()];
      });
  }
  if (pairs.length === 0) throw new Error('must contain at least one key');
  const keys = new Map<string, Buffer>();
  const seen = new Map<string, number>();
  pairs.forEach(([id, value], i) => {
    const n = i + 1;
    if (id === undefined) throw new Error(`entry ${n} is not id:base64 (a bare key? prefix it with an id, e.g. k1:)`);
    if (typeof id !== 'string' || !KEY_ID.test(id)) throw new Error(`entry ${n} has an invalid id (1-64 of A-Z a-z 0-9 _ -)`);
    if (seen.has(id)) throw new Error(`entry ${n} repeats the id of entry ${seen.get(id)}`);
    seen.set(id, n);
    if (typeof value !== 'string' || !BASE64.test(value) || Buffer.from(value, 'base64').length !== 32) {
      throw new Error(`entry ${n} is not a 32-byte base64 key (openssl rand -base64 32)`);
    }
    keys.set(id, Buffer.from(value, 'base64'));
  });
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
    for (const k of keys.values()) if (k.length !== 32) throw new Error('every ring key must be 32 bytes');
    if (!keys.has(activeId)) throw new Error('the active key id is not in the key ring');
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

  toJSON(): { activeId: string; ids: string[] } {
    return { activeId: this.activeId, ids: this.ids };
  }

  [inspect.custom](): string {
    return `Keyring(${JSON.stringify(this.toJSON())})`;
  }
}

/** A single secret key that never serializes or prints its bytes (e.g. PSEUDONYM_KEY). */
export class SecretKey {
  readonly #bytes: Buffer;

  constructor(bytes: Buffer) {
    if (bytes.length !== 32) throw new Error('key must be 32 bytes');
    this.#bytes = Buffer.from(bytes);
  }

  get bytes(): Buffer {
    return this.#bytes;
  }

  toJSON(): string {
    return '[secret]';
  }

  [inspect.custom](): string {
    return 'SecretKey([secret])';
  }
}

/** Parses one 32-byte base64 key; the error never contains the value. */
export function parseKey(raw: string): SecretKey {
  const v = raw.trim();
  if (!BASE64.test(v) || Buffer.from(v, 'base64').length !== 32) {
    throw new Error('must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  }
  return new SecretKey(Buffer.from(v, 'base64'));
}
