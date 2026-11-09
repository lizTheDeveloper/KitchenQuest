import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlidingWindowLimiter, sweepPeriodically } from '../src/auth/rate-limit.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/**
 * N-2: rate-limit state is in memory only and holds an IP (or email, or user
 * id) no longer than the window plus one sweep interval.
 */
describe('SlidingWindowLimiter retention (N-2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('forgets a key once its last hit leaves the window', () => {
    const l = new SlidingWindowLimiter(5, HOUR);
    l.hit('10.0.0.1', 0);
    l.hit('10.0.0.2', 30 * MIN);
    expect(l.size).toBe(2);
    l.sweep(HOUR);
    expect(l.size).toBe(1); // 10.0.0.1's only hit is exactly one window old
    l.sweep(HOUR + 30 * MIN);
    expect(l.size).toBe(0);
  });

  it('a hit on another key sweeps stale keys, at most once a minute', () => {
    const l = new SlidingWindowLimiter(5, HOUR);
    l.hit('a', 0);
    l.hit('b', HOUR + 1);
    expect(l.size).toBe(1);
  });

  it('sweepPeriodically drops stale keys with no further traffic, every minute by default', () => {
    vi.useFakeTimers({ now: 0 });
    const a = new SlidingWindowLimiter(5, HOUR);
    const b = new SlidingWindowLimiter(5, HOUR);
    a.hit('10.0.0.1', 0);
    b.hit('cook@example.com', 0);
    const stop = sweepPeriodically([a, b], () => Date.now());
    vi.advanceTimersByTime(HOUR - MIN);
    expect([a.size, b.size]).toEqual([1, 1]);
    vi.advanceTimersByTime(MIN);
    expect([a.size, b.size]).toEqual([0, 0]);

    // Stopped: no timer is left behind.
    a.hit('10.0.0.3', Date.now());
    stop();
    vi.advanceTimersByTime(2 * HOUR);
    expect(a.size).toBe(1);
  });
});
