import { gte, sql } from 'drizzle-orm';
import { usageEvents } from '../db/schema.js';
import { activeEntitlements, type EntitlementKind } from '../entitlements/entitlements.js';
import type { Db } from '../types.js';
import { usageSince } from '../usage/usage.js';
import { FREE_AI_TURNS_PER_DAY, GUILD_AI_TURNS_PER_DAY } from './constants.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Entitlements that carry the Guild's larger chat allowance. `accessibility_voice` does not. */
export const GUILD_KINDS: readonly EntitlementKind[] = ['guild', 'household_member', 'bursary', 'founding', 'seat_licence'];

/**
 * The player's AI turns over the last 24 hours (`mentor_text` usage units,
 * rolling). Rule help is never held back by this (pre-flight C6): the turn
 * skips the check for it, though its usage still counts here.
 */
export async function aiTurnsLeft(db: Db, userId: string, now: Date): Promise<{ limit: number; used: number; left: number }> {
  const kinds = await activeEntitlements(db, userId, now);
  const limit = kinds.some((k) => GUILD_KINDS.includes(k)) ? GUILD_AI_TURNS_PER_DAY : FREE_AI_TURNS_PER_DAY;
  const used = await usageSince(db, userId, 'mentor_text', new Date(now.getTime() - DAY_MS));
  return { limit, used, left: Math.max(0, limit - used) };
}

/**
 * The global daily AI budget (`config.ai.dailyBudgetMicroUsd`): every user's
 * recorded cost over the last 24 hours must stay below it. The sum is cached
 * for `cacheMs` (60 s) so a busy minute costs one query.
 */
export class BudgetGuard {
  private cached: { at: number; spent: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly budgetMicroUsd: number,
    private readonly cacheMs = 60_000,
  ) {}

  async ok(now: Date): Promise<boolean> {
    const t = now.getTime();
    if (this.cached === null || t - this.cached.at >= this.cacheMs || t < this.cached.at) {
      const rows = await this.db
        .select({ spent: sql<number>`coalesce(sum(${usageEvents.costMicroUsd}), 0)::bigint` })
        .from(usageEvents)
        .where(gte(usageEvents.createdAt, new Date(t - DAY_MS)));
      this.cached = { at: t, spent: Number(rows.at(0)?.spent ?? 0) };
    }
    return this.cached.spent < this.budgetMicroUsd;
  }
}
