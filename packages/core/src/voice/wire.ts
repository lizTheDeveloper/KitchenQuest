// Shared checks for the strict, closed voice-protocol parsers (protocol.ts, upstream.ts). Not exported from core.
import { isValidDate } from '../rules/active';

/** A plain JSON object (no array, no prototype other than Object's or null). */
export function plainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Exactly these own keys, no more and no fewer. */
export function hasExactKeys(x: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(x);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(x, k));
}

/** A message id: an integer that fits a frame's u32. */
export const isU32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
/** An index (part, step, variant): a non-negative integer. */
export const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** A non-empty string of at most `max` characters. */
export const isShortString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isDate = (v: unknown): v is string => isValidDate(v);

/** Code points in `text`, counting no further than `limit + 1`: bounded work however long the text is. */
export function codePoints(text: string, limit: number): number {
  let n = 0;
  for (const _ of text) if (++n > limit) break;
  return n;
}

/** A string of at most `max` code points (MAX_TEXT counts code points, as `capText` does). Never truncated. */
export const isBoundedText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max * 2 && codePoints(v, max) <= max;
