import { isValidDate } from '@kitchenquest/core';
import { ApiError } from '../errors.js';

const DAY_MS = 86_400_000;
const utcDate = (at: Date, days = 0): string => new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);

/**
 * The player's local date (fix round 1, I2; Rulings 11 and 12): the client sends it as `today` (YYYY-MM-DD). It must be
 * a real date within [UTC today − 1, UTC today + 1] (UTC−12 to UTC+14), else 400 `bad_request`. Absent, the UTC date
 * of `at` is used (the M4 meals fallback; the game always sends it). A date is not food (P-5).
 */
export function localToday(raw: unknown, at: Date): string {
  if (raw === undefined) return utcDate(at);
  if (typeof raw !== 'string' || !isValidDate(raw) || raw < utcDate(at, -1) || raw > utcDate(at, 1)) {
    throw new ApiError(400, 'bad_request', 'today must be your local date, YYYY-MM-DD, within a day of ours');
  }
  return raw;
}
