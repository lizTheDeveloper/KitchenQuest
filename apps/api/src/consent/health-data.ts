import { eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { rules } from '../db/schema.js';
import type { Db } from '../types.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * Each later milestone that adds one (journeys, symptoms, meal logs,
 * transcripts) must add it here; the C-10 architecture test lists them too.
 */
const HEALTH_TABLES = [rules] as const;

/** Deletes all of the user's health data and writes a `health_data.delete` audit event, in one transaction. */
export async function deleteHealthData(db: Db, userId: string, now: Date, requestId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    for (const t of HEALTH_TABLES) await tx.delete(t).where(eq(t.userId, userId));
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'health_data.delete', requestId }, now);
  });
}
