import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * AES-256-GCM. Layout: [keyIdLen u8][keyId utf8][12B iv][16B tag][ciphertext].
 * The key id (as header bytes) is bound in as additional authenticated data.
 */
export function seal(plain: unknown, key: Buffer, keyId: string): Buffer {
  if (key.length !== 32) throw new Error('seal: key must be 32 bytes');
  const id = Buffer.from(keyId, 'utf8');
  if (id.length === 0 || id.length > 255) throw new Error('seal: key id must be 1-255 bytes');
  const header = Buffer.concat([Buffer.from([id.length]), id]);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

/** Throws on a malformed or tampered blob, or when its key id is not in `keys`. */
export function open<T>(sealed: Buffer, keys: Record<string, Buffer>): T {
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
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(sealed.subarray(0, headerEnd));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}
