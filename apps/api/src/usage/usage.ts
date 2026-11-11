import { and, eq, gte, sql } from 'drizzle-orm';
import { usageEvents } from '../db/schema.js';
import type { Db } from '../types.js';

const USAGE_FEATURES = ['mentor_text', 'voice_stt', 'voice_tts', 'photo_reaction', 'ingest'] as const;
export type UsageFeature = (typeof USAGE_FEATURES)[number];

/** Records counts and cost only. Never pass prompt, transcript or response content. */
export async function recordUsage(
  /** The database or the caller's transaction. */
  db: Pick<Db, 'insert'>,
  userId: string,
  feature: UsageFeature,
  units: number,
  costMicroUsd: number,
  /** When it happened (`created_at`); the database's clock when omitted. */
  now?: Date,
): Promise<void> {
  if (!USAGE_FEATURES.includes(feature)) throw new Error(`unknown usage feature: ${feature}`);
  if (!Number.isInteger(units) || units < 0) throw new Error('units must be a non-negative integer');
  if (!Number.isInteger(costMicroUsd) || costMicroUsd < 0) {
    throw new Error('costMicroUsd must be a non-negative integer');
  }
  await db.insert(usageEvents).values({ userId, feature, units, costMicroUsd, ...(now ? { createdAt: now } : {}) });
}

/** Sum of units for the feature from `since` (inclusive) to now. */
export async function usageSince(db: Db, userId: string, feature: UsageFeature, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${usageEvents.units}), 0)::int` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.feature, feature), gte(usageEvents.createdAt, since)));
  return row?.total ?? 0;
}

/**
 * M4 Step 12 fix round 2 (N3): a zero-unit, zero-cost row written BEFORE a model call is sent, so the
 * export can say the player's text reached the AI processors even when the call then fails (GDPR Art.
 * 15(1)(c)). Zero units never count against an allowance. Returns the row id for `completeUsage`.
 */
export async function recordSent(db: Pick<Db, 'insert'>, userId: string, feature: UsageFeature, now: Date): Promise<number> {
  if (!USAGE_FEATURES.includes(feature)) throw new Error(`unknown usage feature: ${feature}`);
  const [row] = await db.insert(usageEvents).values({ userId, feature, units: 0, costMicroUsd: 0, createdAt: now }).returning({ id: usageEvents.id });
  return row.id;
}

/** Completes a `recordSent` row once the call succeeded: its units and cost. Counts and cost only. */
export async function completeUsage(db: Pick<Db, 'update'>, id: number, units: number, costMicroUsd: number): Promise<void> {
  if (!Number.isInteger(units) || units < 0) throw new Error('units must be a non-negative integer');
  if (!Number.isInteger(costMicroUsd) || costMicroUsd < 0) throw new Error('costMicroUsd must be a non-negative integer');
  await db.update(usageEvents).set({ units, costMicroUsd }).where(eq(usageEvents.id, id));
}
