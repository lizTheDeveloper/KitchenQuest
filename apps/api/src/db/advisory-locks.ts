import { sql } from 'drizzle-orm';
import type { Db } from '../types.js';

/**
 * Namespaces (the first int4 key of `pg_advisory_xact_lock(classId, key)`)
 * for the API's transaction-scoped advisory locks. The second key is
 * `hashtext(...)` of the locked name, so two namespaces never share a lock,
 * whatever their names hash to. A hash collision inside one namespace only
 * serializes two unrelated writers; it never lets two writers of the same
 * name run together. Add a namespace here, never reuse a number.
 */
export const ADVISORY_LOCK = {
  /** `lockSignInEmail`: a sign-in email, lowercased. */
  signInEmail: 1,
  /** `lockUserRules`: one user's rule writes. */
  rules: 2,
  /** `lockUserPantry`: one user's pantry writes (taken after `rules`, before the consent row). */
  pantry: 3,
  /** `lockUserPlan`: one user's plan and market-run writes (taken after `rules` and `pantry`, before `progress`). */
  plan: 4,
  /** `lockUserProgress`: one user's progress ledger (taken after `rules`, `pantry` and `plan`, before the consent row). */
  progress: 5,
  /** `lockUserNotes`: one user's margin-note writes (taken after `progress`, before the consent row; M5 Step 7). */
  notes: 6,
} as const;

/**
 * Serializes the player's progress writes and erasures: pg_advisory_xact_lock(ADVISORY_LOCK.progress, hashtext(userId)),
 * held until commit, so a batch's duplicate check and daily cap see every committed event of the same player. In the
 * global lock order it is the last advisory lock (`rules:`, `pantry:`, `plan:`, `progress:`), after `lockLiveUser` and
 * before the consent row. Re-entrant within one transaction.
 */
export async function lockUserProgress(tx: Pick<Db, 'execute'>, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK.progress}, hashtext(${userId}))`);
}

/**
 * Serializes the player's plan and market-run writes: pg_advisory_xact_lock(ADVISORY_LOCK.plan, hashtext(userId)), held
 * until commit, so a plan save, a run's recompute and its ticks see each other in turn. In the global lock order it
 * comes after `rules:` and `pantry:` (a tick writes the pantry, so it takes `pantry:` first) and before `progress:`
 * and the consent row. Re-entrant within one transaction.
 */
export async function lockUserPlan(tx: Pick<Db, 'execute'>, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK.plan}, hashtext(${userId}))`);
}

/**
 * Serializes the player's margin-note writes: pg_advisory_xact_lock(ADVISORY_LOCK.notes, hashtext(userId)), held until
 * commit, so two notes racing on one recipe both see each other in the MAX_NOTES_PER_RECIPE count. In the global lock
 * order it is the last advisory lock (`rules:`, `pantry:`, `plan:`, `progress:`, `notes:`), after `lockLiveUser` and
 * before the consent row. Re-entrant within one transaction.
 */
export async function lockUserNotes(tx: Pick<Db, 'execute'>, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK.notes}, hashtext(${userId}))`);
}
