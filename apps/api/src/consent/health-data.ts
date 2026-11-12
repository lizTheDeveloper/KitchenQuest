import { and, eq, isNotNull, or } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { marginNotes, mealLogs, mealPlans, mentorProposals, messages, progressEvents, rules } from '../db/schema.js';
import type { Tx } from './ledger.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * `pantry_items` is not one (H-11: contract basis, [lawyer]), so it stays,
 * nor are the content-free `conversations` (P-14). `meal_plans` is one (M5 Step 6 ruling, conservative: the dishes
 * planned, and the swaps on a market list, can reveal a diet, a religion or a rule, GDPR Art. 9, WA MHMDA; [lawyer]);
 * deleting a plan cascades to its `market_runs` row. `margin_notes` is one (M5 Step 7, Ruling 9: a note can show what
 * the player can't or won't eat); `shared_table` is not (Ruling 10: contract, fixed values, no health facts), so it
 * stays. Each later milestone that
 * adds one (journeys, symptoms) must add it here; the C-10 architecture test
 * lists them too. Deleted in this order (README lock order):
 * `forgetConversations` deletes messages before mentor_proposals too.
 */
const HEALTH_TABLES = [rules, mealLogs, marginNotes, messages, mentorProposals, mealPlans] as const;

/**
 * Deletes all of the user's health data inside the caller's transaction
 * (which has taken `lockLiveUser`, then `lockUserPlan` and `lockUserProgress`, first) and returns how many rows went.
 * Deleting `meal_logs` cascades to their `meal_logged` progress events (I1 ruling); after `HEALTH_TABLES` any left
 * (none should be) are erased too, and so is every `stall_round` event and any sealed event body (M6 Step 6, Task 3
 * ruling I2: every round is sealed and health-adjacent, so all go, not only the Protein Counter's). Only those kinds
 * (when they ate, M5; what they answered at a stall, M6), never another, and never a reward grant, so XP, level and
 * stamps stay (spec §6, I2 ruling; [lawyer] grants keep
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
      .where(
        and(
          eq(progressEvents.userId, userId),
          or(eq(progressEvents.kind, 'meal_logged'), eq(progressEvents.kind, 'stall_round'), isNotNull(progressEvents.sealed)),
        ),
      )
      .returning({ id: progressEvents.id })
  ).length;
  if (withdrew || deleted > 0) {
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'health_data.delete', requestId }, now);
  }
  return deleted;
}
