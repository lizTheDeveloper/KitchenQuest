import { and, eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { mealLogs, mentorProposals, messages, progressEvents, rules } from '../db/schema.js';
import type { Tx } from './ledger.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * `pantry_items` is not one (H-11: contract basis, [lawyer]), so it stays,
 * nor are the content-free `conversations` (P-14). Each later milestone that
 * adds one (journeys, symptoms) must add it here; the C-10 architecture test
 * lists them too. Deleted in this order (README lock order):
 * `forgetConversations` deletes messages before mentor_proposals too.
 */
const HEALTH_TABLES = [rules, mealLogs, messages, mentorProposals] as const;

/**
 * Deletes all of the user's health data inside the caller's transaction
 * (which has taken `lockLiveUser`, then `lockUserProgress`, first) and returns how many rows went.
 * After `HEALTH_TABLES` it erases the player's `meal_logged` progress events (when they ate, M5): only that kind,
 * never another, and never a reward grant, so XP, level and stamps stay (spec §6, I2 ruling; [lawyer] grants keep
 * kind, amount and day). `progress_events` comes after the health tables in the README's table order.
 * Writes a `health_data.delete` audit event when `withdrew` or any row was
 * deleted; a request that changed nothing leaves no event.
 */
export async function deleteHealthDataIn(tx: Tx, userId: string, now: Date, withdrew: boolean, requestId?: string): Promise<number> {
  let deleted = 0;
  for (const t of HEALTH_TABLES) deleted += (await tx.delete(t).where(eq(t.userId, userId)).returning({ id: t.id })).length;
  deleted += (
    await tx
      .delete(progressEvents)
      .where(and(eq(progressEvents.userId, userId), eq(progressEvents.kind, 'meal_logged')))
      .returning({ id: progressEvents.id })
  ).length;
  if (withdrew || deleted > 0) {
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'health_data.delete', requestId }, now);
  }
  return deleted;
}
