import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDb } from './helpers/db.js';

/**
 * N-8: every column the migrations create is named, as `table.column`, in its
 * table's row of the personal data inventory's §6 column index, so no column reaches the database without a row
 * saying what it holds, why, and how long it is kept.
 */
const INVENTORY = new URL('../../../docs/compliance/data-inventory.md', import.meta.url);

/**
 * §6 of the inventory as table → the `table.column` refs in that table's row.
 * Only rows of the §6 table count, and only in the row whose first cell names
 * the table, so a row pasted into another section (or under another table) is not found.
 */
function columnIndex(doc: string): Map<string, Set<string>> {
  const start = doc.search(/^## 6\. Column index/m);
  if (start < 0) throw new Error('data-inventory.md has no "## 6. Column index" section');
  const rest = doc.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^## /.test(l));
  const out = new Map<string, Set<string>>();
  for (const line of end < 0 ? rest : rest.slice(0, end)) {
    const m = /^\| `([a-z_]+)` \|(.*)\|\s*$/.exec(line);
    if (!m) continue;
    const table = m[1];
    const refs = out.get(table) ?? new Set<string>();
    for (const r of m[2].matchAll(new RegExp(`\`(${table}\\.[a-z_0-9]+)\``, 'g'))) refs.add(r[1]);
    out.set(table, refs);
  }
  return out;
}

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
    const index = columnIndex(doc);
    const cols = await t.sql<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name
      where c.table_schema = 'public' and tb.table_type = 'BASE TABLE'
      order by c.table_name, c.ordinal_position`;
    expect(cols.length).toBeGreaterThan(0);
    const missing = cols
      .filter((c) => !index.get(c.table_name)?.has(`${c.table_name}.${c.column_name}`))
      .map((c) => `${c.table_name}.${c.column_name}`);
    expect(missing, 'add these to the row for their table in docs/compliance/data-inventory.md §6').toEqual([]);
  });
});

describe('column index parser (N-8)', () => {
  /** A doc with `before` in §3.12, `index` as the §6 table body, and a later section after it. */
  const doc = (before: string, index: string) =>
    [
      '# X',
      '### 3.12 Other',
      '| ID | Element | Where | Rows |',
      '|---|---|---|---|',
      before,
      '## 6. Column index (N-8)',
      '| Table | Columns | Rows |',
      '|---|---|---|',
      index,
      '## 7. After',
      '| `x` | `x.late` | A |',
    ].join('\n');

  it('reads refs only from the row for their table in §6', () => {
    const idx = columnIndex(doc('', '| `a` | `a.id`, `a.name` | A-1 |\n| `b` | `b.id` | B-1 |'));
    expect([...idx.get('a')!]).toEqual(['a.id', 'a.name']);
    expect([...idx.get('b')!]).toEqual(['b.id']);
    expect(idx.has('x')).toBe(false);
  });

  it('ignores rows pasted outside §6 and refs under another table (the Step 5 slip)', () => {
    const slip = '| W-3 | meta | `a` | `a.id`, `a.name` | H-7 |\n| `b` | `b.id` | H-11 |';
    const idx = columnIndex(doc(slip, '| `c` | `c.x`, `a.name` | C |'));
    expect(idx.has('a')).toBe(false);
    expect(idx.has('b')).toBe(false);
    expect([...idx.get('c')!]).toEqual(['c.x']);
  });
});
