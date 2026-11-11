import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../consent/ledger.js';
import { auditEvents } from '../db/schema.js';
import { ApiError } from '../errors.js';

/**
 * Per player, per rolling day (Step 5 review carry): a generous cap on meal logs and on
 * rule edits that loosen a rule, so a script can't fill the sealed tables. A real player
 * never meets it. It never blocks a rule from being added, removed or made stricter
 * (never rule 1: safety is never limited), and it counts the content-free audit trail,
 * which a delete doesn't shrink.
 */
export const WRITES_PER_DAY = 200;
const DAY_MS = 24 * 3_600_000;

/**
 * Throws 429 `rate_limited` (with `details.retryAfterSeconds` and, M5 final m2, `details.scope: 'day'`, the one
 * marker clients key "paused until tomorrow" on; the per-minute limiters never set it) once the player has made
 * WRITES_PER_DAY writes of `actions` in the last day. Call it inside the write's
 * transaction after `lockLiveUser`, so two racing writes are counted one after the other.
 */
export async function assertUnderWriteCap(tx: Tx, userId: string, actions: readonly string[], at: Date): Promise<void> {
  const since = new Date(at.getTime() - DAY_MS);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${auditEvents.at})` })
    .from(auditEvents)
    .where(and(eq(auditEvents.subjectUserId, userId), inArray(auditEvents.action, [...actions]), gt(auditEvents.at, since)));
  if (row.n < WRITES_PER_DAY) return;
  const oldest = row.oldest === null ? at.getTime() : new Date(row.oldest).getTime();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + DAY_MS - at.getTime()) / 1000));
  throw new ApiError(429, 'rate_limited', `That's ${WRITES_PER_DAY} changes today; try again tomorrow`, { retryAfterSeconds, scope: 'day' });
}
