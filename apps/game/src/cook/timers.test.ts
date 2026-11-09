import { describe, expect, test } from 'vitest';
import { formatClock, formatDuration, remainingMs, startTimer, tick } from './timers';

const mk = (id: string, seconds: number, step = 1, now = 0) => startTimer({ id, label: id, step, seconds }, now);

describe('formatClock', () => {
  test('formats and rounds up to whole seconds', () => {
    expect(formatClock(30_000)).toBe('0:30');
    expect(formatClock(1_200_000)).toBe('20:00');
    expect(formatClock(3_900_000)).toBe('1:05:00');
    expect(formatClock(999)).toBe('0:01');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  test('words', () => {
    expect(formatDuration(30)).toBe('30 seconds');
    expect(formatDuration(1)).toBe('1 second');
    expect(formatDuration(60)).toBe('1 minute');
    expect(formatDuration(90)).toBe('1 minute 30 seconds');
    expect(formatDuration(1200)).toBe('20 minutes');
    expect(formatDuration(3900)).toBe('1 hour 5 minutes');
    expect(formatDuration(7200)).toBe('2 hours');
  });
});

describe('timers', () => {
  test('finishes exactly once', () => {
    const t = startTimer({ id: 'a', label: 'x', step: 2, seconds: 60 }, 0);
    const a = tick([t], 60_000);
    expect(a.finished).toHaveLength(1);
    expect(tick(a.timers, 61_000).finished).toHaveLength(0);
  });
  test('not finished early', () => {
    expect(tick([mk('a', 60)], 59_999).finished).toHaveLength(0);
  });
  test('a 2-hour jump finishes every due timer once', () => {
    const a = tick([mk('a', 60), mk('b', 600, 3), mk('c', 3 * 3600, 4)], 2 * 3600 * 1000);
    expect(a.finished.map((t) => t.id)).toEqual(['a', 'b']);
    expect(a.timers.find((t) => t.id === 'c')!.done).toBe(false);
    expect(tick(a.timers, 2 * 3600 * 1000 + 5).finished).toHaveLength(0);
  });
  test('remainingMs never negative', () => {
    const t = mk('a', 10);
    expect(remainingMs(t, 4_000)).toBe(6_000);
    expect(remainingMs(t, 99_000)).toBe(0);
  });
  test('absolute end time', () => {
    const t = mk('a', 10, 1, 5_000);
    expect(t.endsAt).toBe(15_000);
    expect(t.durationMs).toBe(10_000);
  });
});
