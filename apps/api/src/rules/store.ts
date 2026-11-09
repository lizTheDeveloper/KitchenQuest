import type { Rule } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { openFor } from '../crypto/userkeys.js';
import { rules } from '../db/schema.js';
import type { Db } from '../types.js';

/** A rule as stored (sealed): the core Rule minus its id, which is the row id. */
export type StoredRule = Omit<Rule, 'id'>;

/** The seal context of a rule row (C-3): bound to the table, owner and row. */
export const ruleSealContext = (userId: string, rowId: string) => ({ table: 'rules', userId, rowId });

/** All of the user's rules, decrypted, oldest first, with `id` = row id. Throws if any cannot be opened. */
export async function loadRules(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<Rule[]> {
  const rows = await db
    .select({ id: rules.id, sealed: rules.sealed })
    .from(rules)
    .where(eq(rules.userId, userId))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  const out: Rule[] = [];
  for (const row of rows) {
    const value = await openFor<StoredRule>(db, keyring, ruleSealContext(userId, row.id), row.sealed);
    out.push({ ...value, id: row.id });
  }
  return out;
}
