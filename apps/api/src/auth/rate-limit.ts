import { isIPv6 } from 'node:net';

const SWEEP_EVERY_MS = 60_000;

/**
 * The key an address is limited under: an IPv4 address as is (IPv4-mapped
 * IPv6 included), an IPv6 address by its /64, since one host usually holds a
 * whole /64.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const addr = ip.split('%')[0]!; // drop a zone id
  const [head = '', tail = ''] = addr.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = addr.includes('::') ? (tail ? tail.split(':') : []) : [];
  const groups = addr.includes('::')
    ? [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups]
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
    return recent.length < this.limit ? 0 : recent[0]! + this.windowMs - now;
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

  /** Drops keys whose hits have all left the window; runs at most once a minute. */
  private sweep(now: number): void {
    this.lastSweep = now;
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}
