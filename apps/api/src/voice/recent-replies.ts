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

  /** Keeps the reply's written lines (copies); the oldest of the user's replies past RECENT_REPLIES is dropped. */
  put(userId: string, replyId: string, parts: readonly ReplyPart[], nowMs: number = Date.now()): void {
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

  /** Forgets the user's replies (account delete, forget: Step 6). */
  clear(userId: string): void {
    this.byUser.delete(userId);
  }

  /** Drops expired replies (app.ts sweeps every minute). */
  sweep(nowMs: number): void {
    for (const [userId, list] of [...this.byUser]) {
      const live = list.filter((k) => nowMs - k.at < RECENT_REPLY_TTL_MS);
      if (live.length === 0) this.byUser.delete(userId);
      else this.byUser.set(userId, live);
    }
  }
}

/** The process's recent replies (Ruling 15). */
export const recentReplies = new RecentReplies();
