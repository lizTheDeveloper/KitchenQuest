import { describe, expect, test } from 'vitest';
import { isoWeek, planWeekStart } from './week';

describe('week', () => {
  test('planWeekStart: market day Sat → the Saturday on or before; none → Monday; isoWeek across a year boundary', () => {
    expect(planWeekStart('2026-01-14', [6])).toBe('2026-01-10'); // Wednesday → the Saturday before
    expect(planWeekStart('2026-01-10', [6])).toBe('2026-01-10'); // a Saturday is its own week start
    expect(planWeekStart('2026-01-16', [6])).toBe('2026-01-10'); // Friday: still that week
    expect(planWeekStart('2026-01-14', [])).toBe('2026-01-12'); // no market day → Monday
    expect(planWeekStart('2026-01-12', [])).toBe('2026-01-12');
    expect(planWeekStart('2026-01-11', [])).toBe('2026-01-05'); // Sunday belongs to the Monday before
    expect(planWeekStart('2027-01-02', [5])).toBe('2027-01-01'); // across a year end
    expect(planWeekStart('2026-03-31', [2])).toBe('2026-03-31');

    expect(isoWeek('2026-01-01')).toBe('2026-W01'); // a Thursday
    expect(isoWeek('2027-01-01')).toBe('2026-W53'); // 2026 has 53 ISO weeks
    expect(isoWeek('2027-01-04')).toBe('2027-W01');
    expect(isoWeek('2024-12-30')).toBe('2025-W01'); // a Monday in December is in next year's week 1
    expect(isoWeek('2021-01-03')).toBe('2020-W53');
    expect(isoWeek('2026-01-05')).toBe('2026-W02');
    expect(isoWeek('2026-01-11')).toBe('2026-W02'); // Sunday closes the ISO week
    expect(isoWeek('2026-03-29')).toBe('2026-W13'); // DST change in Europe: whole days only
  });

  test('several market days: the first in a Monday-first week, whatever order they are given in', () => {
    expect(planWeekStart('2026-01-16', [5, 2])).toBe('2026-01-13'); // Tue and Fri → Tuesday
    expect(planWeekStart('2026-01-16', [2, 5])).toBe('2026-01-13');
    expect(planWeekStart('2026-01-14', [0, 6])).toBe('2026-01-10'); // Sat before Sun in a Monday-first week
    expect(planWeekStart('2026-01-14', [9, -1, 1.5])).toBe('2026-01-12'); // nothing usable → Monday
  });

  test('isoWeek agrees with a day-by-day count over several years', () => {
    // Walk from a known Monday (2019-12-30 is 2020-W01) and count weeks by hand.
    let year = 2020;
    let week = 1;
    let day = Date.UTC(2019, 11, 30);
    for (let i = 0; i < 7 * 400; i++, day += 86_400_000) {
      const date = new Date(day).toISOString().slice(0, 10);
      if (i > 0 && i % 7 === 0) {
        week += 1;
        const thursday = new Date(day + 3 * 86_400_000);
        if (thursday.getUTCFullYear() !== year) {
          year = thursday.getUTCFullYear();
          week = 1;
        }
      }
      expect(isoWeek(date)).toBe(`${year}-W${String(week).padStart(2, '0')}`);
    }
  });

  test('bad dates throw', () => {
    expect(() => isoWeek('2026-02-30')).toThrow();
    expect(() => planWeekStart('soon', [6])).toThrow();
  });
});
