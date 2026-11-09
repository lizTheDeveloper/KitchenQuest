import { sql } from 'drizzle-orm';
import type { Db } from '../types.js';

/**
 * Takes a transaction-scoped advisory lock on a sign-in email (case-insensitive,
 * like the citext column). `/auth/request` holds it while inserting a sign-in
 * link and account delete holds it while removing them, so a link requested
 * during a delete lands either before (and is deleted) or after (a new sign-up).
 */
export async function lockSignInEmail(tx: Pick<Db, 'execute'>, email: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(lower(${email})))`);
}
