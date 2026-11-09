import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;
const EMPTY = Buffer.alloc(0);

/**
 * Unambiguous AAD for a list of strings: each part as a u16 length and its
 * UTF-8 bytes, so ("ab","c") and ("a","bc") never encode the same.
 */
export function contextBytes(...parts: string[]): Buffer {
  return Buffer.concat(
    parts.map((p) => {
      const b = Buffer.from(p, 'utf8');
      if (b.length > 0xffff) throw new Error('seal: context part too long');
      const len = Buffer.alloc(2);
      len.writeUInt16BE(b.length);
      return Buffer.concat([len, b]);
    }),
  );
}

/** The key id a sealed blob names in its header (unauthenticated until opened). */
export function sealedKeyId(sealed: Buffer): string {
  const idLen = sealed[0] ?? 0;
  if (idLen === 0 || sealed.length < 1 + idLen) throw new Error('open: sealed value is malformed');
  return sealed.subarray(1, 1 + idLen).toString('utf8');
}

/**
 * AES-256-GCM. Layout: [keyIdLen u8][keyId utf8][12B iv][16B tag][ciphertext].
 * Additional authenticated data is the header bytes followed by `context`
 * (not stored): a blob sealed with one context opens only with the same one.
 */
export function seal(plain: unknown, key: Buffer, keyId: string, context: Buffer = EMPTY): Buffer {
  if (key.length !== 32) throw new Error('seal: key must be 32 bytes');
  const id = Buffer.from(keyId, 'utf8');
  if (id.length === 0 || id.length > 255) throw new Error('seal: key id must be 1-255 bytes');
  const json = JSON.stringify(plain);
  if (json === undefined) throw new Error('seal: value is not JSON-encodable');
  const header = Buffer.concat([Buffer.from([id.length]), id]);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.concat([header, context]));
  const ct = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

/**
 * Throws on a malformed or tampered blob, or when its key id is not in `keys`.
 * The result is trusted (it was authenticated, so only a holder of the key wrote it);
 * callers that need a shape guarantee should still validate it.
 */
export function open<T>(sealed: Buffer, keys: Readonly<Record<string, Buffer>>, context: Buffer = EMPTY): T {
  if (sealed.length < 1) throw new Error('open: sealed value is empty');
  const idLen = sealed[0]!;
  const headerEnd = 1 + idLen;
  if (idLen === 0 || sealed.length < headerEnd + IV_LEN + TAG_LEN) {
    throw new Error('open: sealed value is malformed');
  }
  const keyId = sealed.subarray(1, headerEnd).toString('utf8');
  const key = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (!key) throw new Error(`open: unknown key id "${keyId}"`);
  const iv = sealed.subarray(headerEnd, headerEnd + IV_LEN);
  const tag = sealed.subarray(headerEnd + IV_LEN, headerEnd + IV_LEN + TAG_LEN);
  const ct = sealed.subarray(headerEnd + IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.concat([sealed.subarray(0, headerEnd), context]));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
