import { isValidDate } from '../rules/active';

// Two week notions, on purpose:
// - `isoWeek` is the trust week (Ruling 2) and the "once a week" key of every grant (C16). It never depends on
//   the player's profile, so moving a market day can't shift trust or re-open a weekly grant.
// - `planWeekStart` is the plan week (Ruling 11): One More Technique, the rescue nudge cap and the hard week.

const DAY_MS = 86_400_000;

function utcDay(date: string): Date {
  if (!isValidDate(date)) throw new Error(`not a valid YYYY-MM-DD date: ${String(date)}`);
  return new Date(`${date}T00:00:00Z`);
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** The ISO 8601 week of a local date, as 'YYYY-Www' (weeks start Monday; week 1 holds the year's first Thursday). */
export function isoWeek(date: string): string {
  const d = utcDay(date);
  const weekday = (d.getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
  const thursday = new Date(d.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * The first day of the plan week holding `date` (Ruling 11): the latest day on or before `date` that falls on the
 * player's first market day. Weekdays are numbered as in the profile (0 Sunday … 6 Saturday). "First" is in a
 * Monday-first week, so the answer never depends on the order the days were given in. No usable market day → Monday.
 */
export function planWeekStart(date: string, marketDays: readonly number[]): string {
  const d = utcDay(date);
  const mondayFirst = (day: number) => (day + 6) % 7;
  const valid = marketDays.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const start = valid.length === 0 ? 1 : valid.reduce((a, b) => (mondayFirst(b) < mondayFirst(a) ? b : a));
  const back = (d.getUTCDay() - start + 7) % 7;
  return iso(new Date(d.getTime() - back * DAY_MS));
}
