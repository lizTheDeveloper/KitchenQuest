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
  return (await loadRulesWithVersions(db, keyring, userId)).rules;
}

/**
 * The user's rules (as `loadRules`) and each rule's write version
 * (`rules.version`, M4 final N4) by row id, read in ONE statement (m-1), so a
 * rule's content and its version always come from the same row state: a write
 * landing mid-read can never pair old content with a new version.
 */
export async function loadRulesWithVersions(
  db: Pick<Db, 'select'>,
  keyring: Keyring,
  userId: string,
): Promise<{ rules: Rule[]; versions: Record<string, number> }> {
  const rows = await db
    .select({ id: rules.id, sealed: rules.sealed, version: rules.version })
    .from(rules)
    .where(eq(rules.userId, userId))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  const out: Rule[] = [];
  const versions: Record<string, number> = {};
  for (const row of rows) {
    const value = await openFor<StoredRule>(db, keyring, ruleSealContext(userId, row.id), row.sealed);
    out.push({ ...value, id: row.id });
    versions[row.id] = row.version;
  }
  return { rules: out, versions };
}
