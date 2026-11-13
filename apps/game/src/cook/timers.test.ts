import { describe, expect, test, vi } from 'vitest';
import { ALARM_MAX_MS, createAlarm, formatClock, formatDuration, remainingMs, startTimer, tick } from './timers';

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

describe('M7 Step 10 (B9, carry 1): the alarm hook', () => {
  test('onAlarm(true) comes before the sound starts and onAlarm(false) when it ends; overlapping alarms mark it once', () => {
    const log: string[] = [];
    const ends: (() => void)[] = [];
    const alarm = createAlarm((ended) => { log.push('play'); ends.push(ended); return true; }, (on) => { log.push(`alarm:${on}`); });
    alarm.sound();
    expect(log).toEqual(['alarm:true', 'play']);
    expect(alarm.sounding).toBe(true);
    alarm.sound(); // a second timer finished in the same tick
    expect(log).toEqual(['alarm:true', 'play', 'play']);
    ends[0]();
    expect(alarm.sounding).toBe(true);
    ends[1]();
    ends[1](); // an onended twice changes nothing
    expect(log).toEqual(['alarm:true', 'play', 'play', 'alarm:false']);
    expect(alarm.sounding).toBe(false);
  });

  test('a sound that cannot play (no AudioContext, or it throws) is marked off at once; one whose end never comes is marked off after ALARM_MAX_MS', () => {
    const log: boolean[] = [];
    createAlarm(() => false, (on) => log.push(on)).sound();
    expect(log).toEqual([true, false]);
    const thrown: boolean[] = [];
    createAlarm(() => { throw new Error('no audio'); }, (on) => thrown.push(on)).sound();
    expect(thrown).toEqual([true, false]);
    vi.useFakeTimers();
    try {
      const hung: boolean[] = [];
      const a = createAlarm(() => true, (on) => hung.push(on));
      a.sound();
      vi.advanceTimersByTime(ALARM_MAX_MS - 1);
      expect(hung).toEqual([true]);
      vi.advanceTimersByTime(1);
      expect(hung).toEqual([true, false]);
      expect(a.sounding).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  test('the hook can be set later (hands-free starts after cook mode): only the current hook hears it', () => {
    const a = createAlarm(() => true, null);
    a.sound(); // no hook: nothing to tell
    const seen: boolean[] = [];
    a.setHook((on) => seen.push(on));
    expect(a.sounding).toBe(true);
    expect(seen).toEqual([]);
    a.setHook(null);
  });
});
