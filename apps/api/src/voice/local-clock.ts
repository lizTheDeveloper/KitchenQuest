import { isValidDate } from '@kitchenquest/core';
import { ApiError } from '../errors.js';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Real UTC offsets run from UTC−12 to UTC+14. */
export const MIN_OFFSET_MINUTES = -12 * 60;
export const MAX_OFFSET_MINUTES = 14 * 60;
/** Every real offset is a whole quarter hour (+5:45, +12:45); rounding to it absorbs a few minutes of clock drift. */
const QUARTER_HOUR = 15;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The player's UTC offset in minutes, from the game's `localDate` (YYYY-MM-DD) and `localTime` (HH:MM), checked exactly
 * as the mentor turn checks them (`mentor/routes.ts`: `localTime` must be HH:MM; `localDate` a valid date within a day
 * of the server's UTC date), then rounded to the quarter hour and bounded to UTC−12..UTC+14 (fix round 1, I1). Any
 * failure is 400 `bad_request`. A clock is not food (P-5); it is never stored or logged.
 */
export function localOffsetMinutes(localDate: unknown, localTime: unknown, now: Date): number {
  if (typeof localTime !== 'string' || !HHMM.test(localTime)) throw new ApiError(400, 'bad_request', 'localTime must be HH:MM');
  const utc = now.toISOString().slice(0, 10);
  const offDays =
    typeof localDate === 'string' && isValidDate(localDate)
      ? Math.abs(Date.parse(`${localDate}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`)) / DAY_MS
      : Infinity;
  if (offDays > 1) throw new ApiError(400, 'bad_request', 'localDate must be a valid YYYY-MM-DD within a day of today');
  const raw = (Date.parse(`${localDate as string}T${localTime}:00Z`) - now.getTime()) / MINUTE_MS;
  const offset = Math.round(raw / QUARTER_HOUR) * QUARTER_HOUR;
  if (offset < MIN_OFFSET_MINUTES || offset > MAX_OFFSET_MINUTES) {
    throw new ApiError(400, 'bad_request', 'localDate and localTime must be your clock now (UTC−12 to UTC+14)');
  }
  return offset;
}
