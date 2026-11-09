import { sql } from 'drizzle-orm';
import { users } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';

/**
 * Call FIRST in every user-scoped write transaction: holds the user row with
 * a KEY SHARE lock until commit, or throws 401 `unauthorized` if the account
 * is gone. Account delete takes the user row before anything it cascades to
 * (consents, rules, ...), so taking it first here keeps one lock order: a
 * concurrent delete waits for this transaction, and one that committed first
 * leaves no row, so nothing is written (no audit row under the raw id after
 * pseudonymization, no foreign-key 500).
 */
export async function lockLiveUser(tx: Pick<Db, 'execute'>, userId: string): Promise<void> {
  const held = await tx.execute(sql`select 1 from ${users} where ${users.id} = ${userId} for key share`);
  if (held.length === 0) throw new ApiError(401, 'unauthorized', 'Sign in required');
}
