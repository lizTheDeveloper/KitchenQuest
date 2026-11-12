// M7 Ruling 15: the Pan's recent replies, so a `reply` speak item (a replyId and a part index, never text) is spoken
// with the server's own variables. Memory only, never stored or logged; at most RECENT_REPLIES per user, each for
// RECENT_REPLY_TTL_MS. Only the written-line parts are kept: model text is never spoken (Ruling 16), so it is not held.
// Imports core types only (P3). Step 6's mentor turn puts every reply here.
import { RECENT_REPLIES, RECENT_REPLY_TTL_MS, type LineRef, type ReplyPart } from '@kitchenquest/core';

interface Kept {
  replyId: string;
  at: number;
  /** One per part: its written line, or null for a part that is not one (model text, a card choice, a heard card). */
  lines: (LineRef | null)[];
}

const copyRef = (ref: LineRef): LineRef => ({ trigger: ref.trigger, vars: { ...ref.vars } });

function lineOf(part: ReplyPart): LineRef | null {
  if (part.kind === 'line') return copyRef(part.line);
  if (part.kind === 'go') return copyRef(part.line);
  return null;
}

class RecentReplies {
  private readonly byUser = new Map<string, Kept[]>();
  /**
   * Step 6 fix round 1 (M2): a clear wins. Each user's generation (and when it last moved) is bumped by `clear`; a turn
   * reads it when it starts and its `put` carries it, so a reply from a turn that was in flight across a forget, a
   * health_data withdrawal or an account delete is dropped. A generation is swept once RECENT_REPLY_TTL_MS has passed
   * since its clear: any put still carrying an older one is from a turn that started before the clear, so its reply
   * (kept at the turn's start time) has expired by then anyway.
   */
  private readonly gens = new Map<string, { gen: number; at: number }>();
  private seq = 0;

  /** The user's current generation: read at a turn's start and passed to `put`. */
  generation(userId: string): number {
    return this.gens.get(userId)?.gen ?? 0;
  }

  /**
   * Keeps the reply's written lines (copies); the oldest of the user's replies past RECENT_REPLIES is dropped. A put
   * whose `gen` is not the user's current generation (a clear came since the turn began) keeps nothing.
   */
  put(userId: string, replyId: string, parts: readonly ReplyPart[], nowMs: number = Date.now(), gen: number = this.generation(userId)): void {
    if (gen !== this.generation(userId)) return;
    const list = (this.byUser.get(userId) ?? []).filter((k) => k.replyId !== replyId && nowMs - k.at < RECENT_REPLY_TTL_MS);
    list.push({ replyId, at: nowMs, lines: parts.map(lineOf) });
    while (list.length > RECENT_REPLIES) list.shift();
    this.byUser.set(userId, list);
  }

  /** The written line of part `part` of the user's reply `replyId`, while it is kept; null otherwise (another user's too). */
  line(userId: string, replyId: string, part: number, nowMs: number = Date.now()): LineRef | null {
    const kept = this.byUser.get(userId)?.find((k) => k.replyId === replyId);
    if (kept === undefined || nowMs - kept.at >= RECENT_REPLY_TTL_MS) return null;
    const ref = Number.isInteger(part) && part >= 0 ? kept.lines[part] : undefined;
    return ref === undefined || ref === null ? null : copyRef(ref);
  }

  /** Forgets the user's replies (account delete, forget, health_data withdrawal: Step 6) and moves their generation. */
  clear(userId: string, nowMs: number = Date.now()): void {
    this.byUser.delete(userId);
    this.gens.set(userId, { gen: ++this.seq, at: nowMs });
  }

  /** Drops expired replies (app.ts sweeps every minute). */
  sweep(nowMs: number): void {
    for (const [userId, g] of [...this.gens]) if (nowMs - g.at >= RECENT_REPLY_TTL_MS) this.gens.delete(userId);
    for (const [userId, list] of [...this.byUser]) {
      const live = list.filter((k) => nowMs - k.at < RECENT_REPLY_TTL_MS);
      if (live.length === 0) this.byUser.delete(userId);
      else this.byUser.set(userId, live);
    }
  }
}

/** The process's recent replies (Ruling 15). */
export const recentReplies = new RecentReplies();
