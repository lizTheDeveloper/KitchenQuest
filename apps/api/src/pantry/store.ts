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
    const { name, ingredientId } = await openFor<PantryItem>(db, keyring, pantrySealContext(userId, row.id), row.sealed);
    out.push({ name, ingredientId, id: row.id, createdAt: row.createdAt });
  }
  return out;
}

/** The player's pantry items, decrypted, oldest first, with `id` = row id. Throws if any cannot be opened. */
export async function loadPantry(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<(PantryItem & { id: string })[]> {
  return (await loadRows(db, keyring, userId)).map(({ name, ingredientId, id }) => ({ name, ingredientId, id }));
}

/** As `loadPantry`, with each row's creation time (for the export). */
export const loadPantryForExport = loadRows;
