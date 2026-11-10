import { eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { mealLogs, rules } from '../db/schema.js';
import type { Tx } from './ledger.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * `pantry_items` is not one (H-11: contract basis, [lawyer]), so it stays.
 * Each later milestone that adds one (journeys, symptoms, meal logs,
 * transcripts) must add it here; the C-10 architecture test lists them too.
 */
const HEALTH_TABLES = [rules, mealLogs] as const;

/**
 * Deletes all of the user's health data inside the caller's transaction
 * (which has taken `lockLiveUser` first) and returns how many rows went.
 * Writes a `health_data.delete` audit event when `withdrew` or any row was
 * deleted; a request that changed nothing leaves no event.
 */
export async function deleteHealthDataIn(tx: Tx, userId: string, now: Date, withdrew: boolean, requestId?: string): Promise<number> {
  let deleted = 0;
  for (const t of HEALTH_TABLES) deleted += (await tx.delete(t).where(eq(t.userId, userId)).returning({ id: t.id })).length;
  if (withdrew || deleted > 0) {
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'health_data.delete', requestId }, now);
  }
  return deleted;
}
