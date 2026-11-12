import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, or } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { marginNotes, mealLogs, mealPlans, mentorProposals, messages, progressEvents, rules, users, voiceSettings } from '../db/schema.js';
import type { Tx } from './ledger.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * `pantry_items` is not one (H-11: contract basis, [lawyer]), so it stays,
 * nor are the content-free `conversations` (P-14). `meal_plans` is one (M5 Step 6 ruling, conservative: the dishes
 * planned, and the swaps on a market list, can reveal a diet, a religion or a rule, GDPR Art. 9, WA MHMDA; [lawyer]);
 * deleting a plan cascades to its `market_runs` row. `margin_notes` is one (M5 Step 7, Ruling 9: a note can show what
 * the player can't or won't eat); `shared_table` is not (Ruling 10: contract, fixed values, no health facts), so it
 * stays. `voice_settings` is one too (M7 Step 4, Ruling 6, C-19: the self-declared accessibility need implies a
 * disability); keyed by `user_id` alone, it is deleted right after these (README table order: after `shared_table`,
 * before `progress_events`). Each later milestone that
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
 * deleted, and then gives the account a new `users.health_erasure` id (M7 Step 7, N1); a request that changed nothing
 * leaves no event and no new id.
 */
export async function deleteHealthDataIn(tx: Tx, userId: string, now: Date, withdrew: boolean, requestId?: string): Promise<number> {
  let deleted = 0;
  for (const t of HEALTH_TABLES) deleted += (await tx.delete(t).where(eq(t.userId, userId)).returning({ id: t.id })).length;
  // The accessibility need (C-19): one row per player, by user id. Once gone, voice is the free allowance again.
  deleted += (await tx.delete(voiceSettings).where(eq(voiceSettings.userId, userId)).returning({ userId: voiceSettings.userId })).length;
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
    // M7 Step 7 (M6 fix review N1): a new erasure id, so each of the account's signed-in devices drops its own copy of
    // the erased stall rounds and meal-log events when it next syncs (`healthErasureOf`, GET /progress).
    await tx.update(users).set({ healthErasure: randomUUID() }).where(eq(users.id, userId));
  }
  return deleted;
}

/** The account's current erasure id (null before its first `health_data` delete): content-free, no time and no count. */
export async function healthErasureOf(tx: Pick<Tx, 'select'>, userId: string): Promise<string | null> {
  const [row] = await tx.select({ id: users.healthErasure }).from(users).where(eq(users.id, userId));
  return row?.id ?? null;
}
