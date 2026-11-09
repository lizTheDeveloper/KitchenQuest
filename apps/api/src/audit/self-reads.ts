import { sql } from 'drizzle-orm';
import { selfReadCounts, type SELF_READ_RESOURCES } from '../db/schema.js';
import type { Db } from '../types.js';

export type SelfReadResource = (typeof SELF_READ_RESOURCES)[number];

/**
 * Counts one read by the player of their own `resource` on `now`'s UTC day
 * (C-5: routine self-reads are counted, not logged per read). One row per
 * user, resource and day; no time of day and no content.
 */
export async function countSelfRead(db: Pick<Db, 'insert'>, userId: string, resource: SelfReadResource, now: Date): Promise<void> {
  await db
    .insert(selfReadCounts)
    .values({ userId, resource, day: now.toISOString().slice(0, 10), count: 1 })
    .onConflictDoUpdate({
      target: [selfReadCounts.userId, selfReadCounts.resource, selfReadCounts.day],
      set: { count: sql`${selfReadCounts.count} + 1` },
    });
}
