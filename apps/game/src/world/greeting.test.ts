import { describe, expect, test } from 'vitest';
import { greetingTrigger } from './greeting';

/** A local-time Date: these tests run in whatever zone the machine is in. */
const at = (h: number, m: number, day = 15) => new Date(2026, 2, day, h, m);
const iso = (d: Date) => d.toISOString();

describe('greetingTrigger', () => {
  const first = iso(new Date(2025, 0, 1));
  const cases: [number, number, string][] = [
    [4, 59, 'greet.late_night'], [5, 0, 'greet.morning'], [10, 59, 'greet.morning'],
    [11, 0, 'greet.afternoon'], [16, 59, 'greet.afternoon'], [17, 0, 'greet.evening'],
    [21, 59, 'greet.evening'], [22, 0, 'greet.late_night'],
  ];
  for (const [h, m, want] of cases) {
    test(`${h}:${String(m).padStart(2, '0')} → ${want}`, () => {
      const now = at(h, m);
      expect(greetingTrigger(now, first, iso(new Date(now.getTime() - 60_000)))).toBe(want);
    });
  }

  test('a gap of 2 days 23 hours is still a time-of-day greeting', () => {
    const now = at(12, 0);
    const last = new Date(now.getTime() - (2 * 24 + 23) * 3_600_000);
    expect(greetingTrigger(now, first, iso(last))).toBe('greet.afternoon');
  });

  test('exactly 3 days away → return_after_gap', () => {
    const now = at(12, 0);
    expect(greetingTrigger(now, first, iso(new Date(now.getTime() - 3 * 86_400_000)))).toBe('greet.return_after_gap');
  });

  test('firstOpenedAt null → first_ever, even with a gap', () => {
    const now = at(12, 0);
    expect(greetingTrigger(now, null, null)).toBe('greet.first_ever');
    expect(greetingTrigger(now, null, iso(new Date(now.getTime() - 30 * 86_400_000)))).toBe('greet.first_ever');
  });

  test('an unreadable lastOpenedAt falls back to the time of day', () => {
    expect(greetingTrigger(at(18, 0), first, 'not a date')).toBe('greet.evening');
  });
});
