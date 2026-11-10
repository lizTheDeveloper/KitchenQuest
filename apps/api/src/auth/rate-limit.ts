import { isIPv6 } from 'node:net';

const SWEEP_EVERY_MS = 60_000;

/**
 * The key an address is limited under: an IPv4 address as is (IPv4-mapped
 * IPv6 included), an IPv6 address by its /64, since one host usually holds a
 * whole /64.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const addr = ip.split('%')[0]; // drop a zone id
  const [head = '', tail = ''] = addr.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = addr.includes('::')
    ? [...headGroups, ...new Array<string>(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
    : headGroups;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * In-memory sliding-window limiter driven by the caller's clock, so tests can
 * advance time. State is per process: with several API instances each one
 * enforces the limit separately.
 *
 * N-2: the state is a map from key (an IP or /64, a lowercased email, or a
 * user id) to hit times. It is never written to disk, the database or a log,
 * and is lost on restart. A key is dropped once its last hit leaves the window,
 * at the next sweep: on any hit at most once a minute, and from
 * `sweepPeriodically` every minute without traffic. So with a one-hour window
 * no key is held more than an hour and a minute after its last hit.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = -Infinity;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Milliseconds until `key` may be hit again at `now`; 0 when it may be hit now. */
  waitMs(key: string, now: number): number {
    const recent = this.recent(key, now);
    return recent.length < this.limit ? 0 : recent[0] + this.windowMs - now;
  }

  /** How many keys are held (for tests and metrics; never the keys themselves). */
  get size(): number {
    return this.hits.size;
  }

  hit(key: string, now: number): void {
    if (now - this.lastSweep >= SWEEP_EVERY_MS) this.sweep(now);
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  /** Drops keys whose hits have all left the window. */
  sweep(now: number): void {
    this.lastSweep = now;
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}

/**
 * Sweeps `limiters` every `everyMs` (a minute by default) on an unref'd timer,
 * so stale keys go even when no further request comes. Returns a stop function.
 * Takes any in-memory store with a `sweep` (the mentor's `MemoryHistory` and `MemoryFlags` too).
 */
export function sweepPeriodically(
  limiters: readonly { sweep(now: number): void }[],
  now: () => number,
  everyMs = SWEEP_EVERY_MS,
): () => void {
  const timer = setInterval(() => {
    const t = now();
    for (const l of limiters) l.sweep(t);
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
