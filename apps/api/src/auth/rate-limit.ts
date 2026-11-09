/**
 * In-memory sliding-window limiter driven by the caller's clock, so tests can
 * advance time. State is per process: with several API instances each one
 * enforces the limit separately.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

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
    if (this.hits.size > 10_000) this.sweep(now);
    this.hits.set(key, [...this.recent(key, now), now]);
  }

  private recent(key: string, now: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (kept.length === 0) this.hits.delete(key);
    else this.hits.set(key, kept);
    return kept;
  }

  private sweep(now: number): void {
    for (const key of [...this.hits.keys()]) this.recent(key, now);
  }
}
