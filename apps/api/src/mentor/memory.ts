import type { ReplyPart } from '@kitchenquest/core';

/** One transcript message (C-12): what `messages.sealed` holds and what memory keeps. Re-exported by `conversations.ts`. */
export type StoredMessage = { role: 'player'; text: string } | { role: 'pan'; parts: ReplyPart[]; proposalIds: string[] };

/**
 * A conversation's recent messages held in API process memory only: the
 * history of a player without `health_data` consent (C-12: no transcript is
 * stored without it). Never written to disk, the database or a log; a restart
 * clears it (like the rate-limit state, N-2). Keys are `${userId}:${conversationId}`.
 * An entry holds at most `max` messages and expires `ttlMs` after its last push;
 * `sweep` (run from `sweepPeriodically`) drops expired entries.
 */
export class MemoryHistory {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly entries = new Map<string, { msgs: StoredMessage[]; at: number }>();

  constructor(opts: { ttlMs: number; max: number }) {
    this.ttlMs = opts.ttlMs;
    this.max = opts.max;
  }

  /** The held messages, oldest first (a copy), or none once expired. */
  get(key: string, nowMs: number): StoredMessage[] {
    const e = this.entries.get(key);
    if (!e) return [];
    if (nowMs - e.at >= this.ttlMs) {
      this.entries.delete(key);
      return [];
    }
    return [...e.msgs];
  }

  push(key: string, msgs: StoredMessage[], nowMs: number): void {
    const kept = [...this.get(key, nowMs), ...msgs].slice(-this.max);
    this.entries.set(key, { msgs: kept, at: nowMs });
  }

  /** Forgets every key starting with `keyPrefix`: `${userId}:` for all of a user's, `${userId}:${id}` for one. */
  delete(keyPrefix: string): void {
    for (const key of [...this.entries.keys()]) if (key.startsWith(keyPrefix)) this.entries.delete(key);
  }

  sweep(nowMs: number): void {
    for (const [key, e] of [...this.entries]) if (nowMs - e.at >= this.ttlMs) this.entries.delete(key);
  }

  /** Entries held, expired ones not yet swept included. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * Keys flagged for a while, in memory only and never stored (§19): e.g. the
 * conversations where a child spoke (Step 7). A flag expires `ttlMs` after it was added.
 */
export class MemoryFlags {
  private readonly ttlMs: number;
  private readonly flags = new Map<string, number>();

  constructor(opts: { ttlMs: number }) {
    this.ttlMs = opts.ttlMs;
  }

  has(key: string, nowMs: number): boolean {
    const at = this.flags.get(key);
    if (at === undefined) return false;
    if (nowMs - at >= this.ttlMs) {
      this.flags.delete(key);
      return false;
    }
    return true;
  }

  add(key: string, nowMs: number): void {
    this.flags.set(key, nowMs);
  }

  sweep(nowMs: number): void {
    for (const [key, at] of [...this.flags]) if (nowMs - at >= this.ttlMs) this.flags.delete(key);
  }

  get size(): number {
    return this.flags.size;
  }
}
