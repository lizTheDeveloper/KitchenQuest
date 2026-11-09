import { eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { rules } from '../db/schema.js';
import type { Db } from '../types.js';
import type { Tx } from './ledger.js';

/**
 * Every table holding a user's health data (C-1 "delete health data now").
 * Each later milestone that adds one (journeys, symptoms, meal logs,
 * transcripts) must add it here; the C-10 architecture test lists them too.
 */
const HEALTH_TABLES = [rules] as const;

/** Deletes all of the user's health data and writes a `health_data.delete` audit event, inside the caller's transaction. */
export async function deleteHealthDataIn(tx: Tx, userId: string, now: Date, requestId?: string): Promise<void> {
  for (const t of HEALTH_TABLES) await tx.delete(t).where(eq(t.userId, userId));
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'health_data.delete', requestId }, now);
}

/** `deleteHealthDataIn` in its own transaction. Kept as the standalone erasure entry point for callers outside a transaction. @public */
export async function deleteHealthData(db: Db, userId: string, now: Date, requestId?: string): Promise<void> {
  await db.transaction((tx) => deleteHealthDataIn(tx, userId, now, requestId));
}
