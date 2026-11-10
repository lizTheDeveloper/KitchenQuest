import type { MealEntry, MealItem, MealSlot } from '@kitchenquest/core';
import { and, asc, eq, gte, lte } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { openFor } from '../crypto/userkeys.js';
import { mealLogs } from '../db/schema.js';
import type { Db } from '../types.js';

/** The seal context of a meal-log row (C-3): bound to the table, owner and row. */
export const mealSealContext = (userId: string, rowId: string) => ({ table: 'meal_logs', userId, rowId });

/**
 * The slots the player has logged a meal in on `date`, in the order they
 * were logged, each once. What Step 7's prompt context reads, and nothing
 * else: plain columns only, nothing is opened (the key ring is not used).
 */
export async function mealSlotsOn(db: Pick<Db, 'select'>, _keyring: Keyring, userId: string, date: string): Promise<MealSlot[]> {
  const rows = await db
    .select({ slot: mealLogs.slot })
    .from(mealLogs)
    .where(and(eq(mealLogs.userId, userId), eq(mealLogs.eatenOn, date)))
    .orderBy(asc(mealLogs.createdAt), asc(mealLogs.id));
  return [...new Set(rows.map((r) => r.slot as MealSlot))];
}

/** A meal log, decrypted, with its row id and creation time. */
export type StoredMeal = MealEntry & { id: string; createdAt: Date };

/**
 * The player's meal logs eaten from `from` to `to` (inclusive, YYYY-MM-DD),
 * or all of them when no range is given (export), decrypted, by date then
 * time logged. Throws if any cannot be opened.
 */
export async function loadMeals(
  db: Pick<Db, 'select'>,
  keyring: Keyring,
  userId: string,
  range?: { from: string; to: string },
): Promise<StoredMeal[]> {
  const rows = await db
    .select({ id: mealLogs.id, eatenOn: mealLogs.eatenOn, slot: mealLogs.slot, sealed: mealLogs.sealed, createdAt: mealLogs.createdAt })
    .from(mealLogs)
    .where(
      and(eq(mealLogs.userId, userId), ...(range ? [gte(mealLogs.eatenOn, range.from), lte(mealLogs.eatenOn, range.to)] : [])),
    )
    .orderBy(asc(mealLogs.eatenOn), asc(mealLogs.createdAt), asc(mealLogs.id));
  const out: StoredMeal[] = [];
  for (const row of rows) {
    const item = await openFor<MealItem>(db, keyring, mealSealContext(userId, row.id), row.sealed);
    out.push({ eatenOn: row.eatenOn, slot: row.slot as MealSlot, item, id: row.id, createdAt: row.createdAt });
  }
  return out;
}
