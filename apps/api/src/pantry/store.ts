import type { PantryItem } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { openFor } from '../crypto/userkeys.js';
import { pantryItems } from '../db/schema.js';
import type { Db } from '../types.js';

/** The seal context of a pantry row (C-3): bound to the table, owner and row. */
export const pantrySealContext = (userId: string, rowId: string) => ({ table: 'pantry_items', userId, rowId });

/** The player's pantry, decrypted, oldest first, each with its row id (and creation time, for the export). */
async function loadRows(db: Pick<Db, 'select'>, keyring: Keyring, userId: string) {
  const rows = await db
    .select({ id: pantryItems.id, sealed: pantryItems.sealed, createdAt: pantryItems.createdAt })
    .from(pantryItems)
    .where(eq(pantryItems.userId, userId))
    .orderBy(asc(pantryItems.createdAt), asc(pantryItems.id));
  const out: (PantryItem & { id: string; createdAt: Date })[] = [];
  for (const row of rows) {
    const item = await openFor<PantryItem>(db, keyring, pantrySealContext(userId, row.id), row.sealed);
    out.push({ ...pantryFields(item), id: row.id, createdAt: row.createdAt });
  }
  return out;
}

/**
 * Exactly core's `PantryItem` fields of a stored item: `addedOn` and `source` only when the row has them (M5 Ruling 12;
 * an M4 row, or food told to the Pan, has neither, and still loads).
 */
export function pantryFields(item: PantryItem): PantryItem {
  return {
    name: item.name,
    ingredientId: item.ingredientId,
    ...(item.addedOn === undefined ? {} : { addedOn: item.addedOn }),
    ...(item.source === undefined ? {} : { source: item.source }),
  };
}

/**
 * The player's pantry items, decrypted, oldest first, with `id` = row id and each item's `addedOn` and `source` when
 * it has them (so Use-It-Up and the frames see purchase dates; Step 5 review M4). Throws if any cannot be opened.
 */
export async function loadPantry(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<(PantryItem & { id: string })[]> {
  return (await loadRows(db, keyring, userId)).map(({ createdAt: _createdAt, ...item }) => item);
}

/** As `loadPantry`, with each row's creation time (for the export). */
export const loadPantryForExport = loadRows;
