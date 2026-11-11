import { sql } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';

/**
 * Call FIRST in every user-scoped write transaction: holds the user row with
 * a KEY SHARE lock until commit, or throws 401 `unauthorized` if the account
 * is gone. Account delete takes its sign-in-email lock (`lockSignInEmail`),
 * then the user row, before anything it cascades to (consents, rules, ...),
 * so taking the user row first here keeps one lock order: a
 * concurrent delete waits for this transaction, and one that committed first
 * leaves no row, so nothing is written (no audit row under the raw id after
 * pseudonymization, no foreign-key 500).
 *
 * One global lock order (pre-flight C13, extended in M5), for every transaction:
 * user row (`lockLiveUser`) → per-user advisory locks (`rules:<id>`, `pantry:<id>`, `plan:<id>`, `progress:<id>`,
 * `book:<id>`, in that order; namespaces in `db/advisory-locks.ts`) → consent row (`lockConsentIn`, `consentHeldIn`) →
 * conversation row (`bumpTurn`, `appendMessages`, `forgetConversations`) → proposal row (`lockProposal`) → data rows
 * in table order: `rules` → `meal_logs` → `margin_notes` → `messages` → `mentor_proposals` (the `HEALTH_TABLES`
 * order), then `meal_plans` → `market_runs` → `shared_table` → `progress_events` → `reward_grants`.
 * Account delete takes its sign-in-email lock, then the user row, before anything else, so it still serializes
 * ahead. Consent withdraw-with-delete takes the user row, then `progress:` (its `meal_logs` delete cascades to
 * `meal_logged` progress events), then the consent row, then deletes rules, meals (and their progress events),
 * messages and proposals, which fits the order. A meal-log delete (`DELETE /meals/:id`, and the mentor's meal-card
 * confirm and undo in `mentor/writes.ts`) takes the user row, then `progress:`, then (a confirm only) the consent row,
 * then the meal log (a delete cascading to its progress event), then the proposal row. A progress post takes the user row, then `progress:`, then (for a
 * meal-log event) the `health_data` grant, then reads `meal_logs` and writes `progress_events` → `reward_grants`.
 * A margin-note write (M5 Step 7) takes the user row, then `book:`, then the `health_data` grant, then counts and
 * writes `margin_notes`; a Shared Table write takes the user row, then `book:` (the shared daily write cap), then writes `shared_table`. A note or Shared
 * Table delete takes the user row, then deletes its own row.
 * Each service accepts locks its caller already holds (advisory and row locks are re-entrant within one transaction).
 *
 * Outside the order on purpose: the global hourly AI cost row (`ai_cost_hours`,
 * `recordAiCost`) is updated in its own one-statement transaction right after a
 * model call, never inside a transaction that holds or waits for any lock
 * above, so one turn waiting on consent or its conversation never stalls
 * another player's turn on that shared row (M4 Step 7 fix round 2, N6).
 */
export async function lockLiveUser(tx: Pick<Db, 'execute'>, userId: string): Promise<void> {
  const held = await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for key share`);
  if (held.length === 0) throw new ApiError(401, 'unauthorized', 'Sign in required');
}
