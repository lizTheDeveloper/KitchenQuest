import { and, eq, gte, sql } from 'drizzle-orm';
import { usageEvents } from '../db/schema.js';
import type { Db } from '../types.js';

export const USAGE_FEATURES = ['mentor_text', 'voice_stt', 'voice_tts', 'photo_reaction', 'ingest'] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

/** Records counts and cost only. Never pass prompt, transcript or response content. */
export async function recordUsage(
  db: Db,
  userId: string,
  feature: UsageFeature,
  units: number,
  costMicroUsd: number,
): Promise<void> {
  if (!USAGE_FEATURES.includes(feature)) throw new Error(`unknown usage feature: ${feature}`);
  if (!Number.isInteger(units) || units < 0) throw new Error('units must be a non-negative integer');
  if (!Number.isInteger(costMicroUsd) || costMicroUsd < 0) {
    throw new Error('costMicroUsd must be a non-negative integer');
  }
  await db.insert(usageEvents).values({ userId, feature, units, costMicroUsd });
}

/** Sum of units for the feature from `since` (inclusive) to now. */
export async function usageSince(db: Db, userId: string, feature: UsageFeature, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.units}), 0)::int` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.feature, feature), gte(usageEvents.createdAt, since)));
  return row?.total ?? 0;
}
