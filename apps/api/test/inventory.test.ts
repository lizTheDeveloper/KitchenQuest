import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './helpers/db.js';

/**
 * N-8: every column the migrations create is named, as `table.column`, in the
 * personal data inventory, so no column reaches the database without a row
 * saying what it holds, why, and how long it is kept.
 */
const INVENTORY = new URL('../../../docs/compliance/data-inventory.md', import.meta.url);

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t?.close();
});

describe('data inventory (N-8)', () => {
  it('names every table.column in the migrated schema', async () => {
    const doc = readFileSync(INVENTORY, 'utf8');
    const cols = await t.sql<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
      where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`;
    expect(cols.length).toBeGreaterThan(0);
    const named = (ref: string) => new RegExp(`(^|[^A-Za-z0-9_.])${ref.replace('.', '\\.')}(?![A-Za-z0-9_])`).test(doc);
    const missing = cols.map((c) => `${c.table_name}.${c.column_name}`).filter((ref) => !named(ref));
    expect(missing, 'add these to docs/compliance/data-inventory.md').toEqual([]);
  });
});
