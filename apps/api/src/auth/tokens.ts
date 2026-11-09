import { createHash, randomBytes } from 'node:crypto';

export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 32 random bytes as base64url, without padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A new secret for a login link or session cookie, and the only form of it the database may hold. */
export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

/**
 * SHA-256 of the token string exactly as issued. Hashing the string, not its
 * decoded bytes, means a variant spelling that decodes to the same bytes
 * (a changed padding bit in the last character) does not match.
 */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** Whether `value` has the shape of an issued token; anything else cannot match a stored hash. */
export function isTokenShaped(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_SHAPE.test(value);
}
