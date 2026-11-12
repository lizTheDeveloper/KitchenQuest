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

describe('M6 Step 6 columns', () => {
  it('progress_events.sealed is in data-inventory §6', () => {
    const index = columnIndex(readFileSync(INVENTORY, 'utf8'));
    expect(index.get('progress_events')?.has('progress_events.sealed')).toBe(true);
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

// M6 Step 7 (Ruling 18): the progress snapshot table.
describe('M6 Step 7 columns', () => {
  it('progress_snapshots columns are in data-inventory §6 (U-6)', () => {
    const doc = readFileSync(INVENTORY, 'utf8');
    const index = columnIndex(doc);
    for (const c of ['user_id', 'upto_seq', 'catalogue_hash', 'sealed', 'created_at']) {
      expect(index.get('progress_snapshots')?.has(`progress_snapshots.${c}`), c).toBe(true);
    }
    expect(doc).toMatch(/^\| `progress_snapshots` \|.*\| U-6 \|$/m);
    // One U-6 row in the inventory: the snapshot.
    expect([...doc.matchAll(/^\| U-6 \|/gm)]).toHaveLength(1);
    expect(doc).toMatch(/^\| U-6 \| Progress snapshot/m);
  });
});

// M7 Step 4 (Ruling 6, C-19): the sealed accessibility need.
describe('M7 Step 4 columns', () => {
  it('voice_settings columns are in data-inventory §6 (P-5, built M7)', () => {
    const doc = readFileSync(INVENTORY, 'utf8');
    const index = columnIndex(doc);
    for (const c of ['user_id', 'sealed', 'updated_at']) {
      expect(index.get('voice_settings')?.has(`voice_settings.${c}`), c).toBe(true);
    }
    expect(doc).toMatch(/^\| `voice_settings` \|.*\| P-5 \|$/m);
    // P-5 is built now: no "not in the current schema", and no plain profiles column named for it.
    const p5 = doc.split('\n').find((l) => l.startsWith('| P-5 |'))!;
    expect(p5).toContain('`voice_settings`');
    expect(p5).not.toMatch(/not in the current schema|planned M2/);
    expect(doc).not.toMatch(/profiles\.accessibility_voice/);
  });
});

const ROADMAP = new URL('../../../docs/compliance/ROADMAP.md', import.meta.url);
const COMPLIANCE = new URL('../../../docs/compliance/2026-11-09-health-data-compliance.md', import.meta.url);

/** An id as the ROADMAP and the C-table write it: C-n or N-n, with an optional letter (C-10b). */
const ID = String.raw`[CN]-\d+[a-z]?`;

interface RoadmapItem {
  id: string;
  /** The "(x)" label of a split item ("M2 part", "partial"), or null for the whole item. */
  part: string | null;
  line: number;
}

/**
 * The checklist items of a ROADMAP that carry an id (M5 m13; M6 Ruling 20, N3): `- [ ]`, `- [x]` or `- [~]`, then the id
 * at the start of the line, bold (`**C-45**`) or not (`C-36`), with a letter suffix or not (`C-10b`). A split item
 * names its part right after the id, inside the bold when bold: `**N-1 (M2 part)**`, `**N-3 (partial)**`,
 * `C-36 (accounts part)`. A parenthesis after the bold (`**C-37** (CI part done…)`) is the whole item's text.
 * Any other id-line form (`**C-49:**`, `[X]`, an indent, `*` bullets, lower case) is a problem (`roadmapIdProblems`).
 */
function roadmapItems(doc: string): RoadmapItem[] {
  const re = new RegExp(String.raw`^- \[[ x~]\] (?:\*\*(${ID})(?: \(([^)]+)\))?\*\*|(${ID})(?: \(([^)]+)\))?(?![\w-]))`);
  const out: RoadmapItem[] = [];
  doc.split('\n').forEach((text, i) => {
    const m = re.exec(text);
    if (m) out.push({ id: m[1] ?? m[3], part: m[2] ?? m[4] ?? null, line: i + 1 });
  });
  return out;
}

/** The ids of the compliance doc's §6 C-table: the first cell of each row, bold or not. */
function cTable(doc: string): string[] {
  const start = doc.search(/^## 6\. Engineering requirements/m);
  if (start < 0) throw new Error('the compliance doc has no "## 6. Engineering requirements" section');
  const rest = doc.slice(start).split('\n').slice(1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end))
    .map((l) => new RegExp(String.raw`^\| (?:\*\*)?(C-\d+[a-z]?)(?:\*\*)? \|`).exec(l)?.[1])
    .filter((id): id is string => id !== undefined);
}

/** ROADMAP C-ids that need no row in the C-table, each with why. None today: C-46–C-48 got rows (M6 Step 7). */
const ALLOWED_ROADMAP_ONLY: ReadonlyMap<string, string> = new Map();

/** Every problem with the ids of `roadmap` against the C-table ids `table`; [] when they agree. */
function roadmapIdProblems(roadmap: string, table: readonly string[]): string[] {
  const items = roadmapItems(roadmap);
  const problems: string[] = [];
  // Review m5: any checklist-looking line that starts with an id (any bullet, box, indent, case or punctuation) must
  // parse as an item; one that doesn't would escape every check below, so it is reported, never skipped.
  const read = new Set(items.map((i) => i.line));
  roadmap.split('\n').forEach((text, i) => {
    if (/^\s*[-*+] \[.\] (?:\*\*)?[CN]-\d/i.test(text) && !read.has(i + 1)) problems.push(`line ${i + 1}: an id line the parser does not read: "${text}"`);
  });
  const whole = items.filter((i) => i.part === null).map((i) => i.id);
  for (const id of new Set(whole.filter((id, i) => whole.indexOf(id) !== i))) problems.push(`${id} is a whole item twice`);
  const labels = new Map<string, string[]>();
  for (const i of items.filter((x) => x.part !== null)) {
    if (!whole.includes(i.id)) problems.push(`${i.id} (${i.part}) names no whole ${i.id} item (line ${i.line})`);
    const seen = labels.get(i.id) ?? [];
    if (seen.includes(i.part!)) problems.push(`${i.id} has two "(${i.part})" parts`);
    labels.set(i.id, [...seen, i.part!]);
  }
  const roadmapC = new Set(items.map((i) => i.id).filter((id) => id.startsWith('C-')));
  const tableC = new Set(table);
  for (const id of roadmapC) if (!tableC.has(id) && !ALLOWED_ROADMAP_ONLY.has(id)) problems.push(`${id} is in the ROADMAP but not in the C-table`);
  for (const id of tableC) if (!roadmapC.has(id)) problems.push(`${id} is in the C-table but not in the ROADMAP`);
  for (const id of new Set(table.filter((id, i) => table.indexOf(id) !== i))) problems.push(`${id} is in the C-table twice`);
  return problems;
}

// M5 final review m13, widened in M6 Step 7 (Ruling 20, M5 re-review N3): each ROADMAP item id names one item.
describe('ROADMAP item ids', () => {
  it('ROADMAP ids: suffixed (C-10b) and non-bold (C-36) ids are seen; whole ids unique; parts name a base; C-table cross-check', () => {
    const roadmap = readFileSync(ROADMAP, 'utf8');
    const compliance = readFileSync(COMPLIANCE, 'utf8');
    const items = roadmapItems(roadmap);
    expect(items.length).toBeGreaterThan(50);
    expect(items).toContainEqual(expect.objectContaining({ id: 'C-10b', part: null }));
    expect(items).toContainEqual(expect.objectContaining({ id: 'C-36', part: 'accounts part' }));
    expect(items).toContainEqual(expect.objectContaining({ id: 'N-1', part: 'M2 part' }));
    expect(items).toContainEqual(expect.objectContaining({ id: 'C-37', part: null }));
    const table = cTable(compliance);
    expect(table).toEqual(expect.arrayContaining(['C-1', 'C-10b', 'C-45', 'C-46', 'C-47', 'C-48']));
    expect(roadmapIdProblems(roadmap, table)).toEqual([]);
    for (const [id, why] of ALLOWED_ROADMAP_ONLY) expect(why.length, id).toBeGreaterThan(10);
  });

  it('the parser and checks catch each kind of slip', () => {
    const doc = (...lines: string[]) => ['# R', '', ...lines, ''].join('\n');
    expect(roadmapItems(doc('- [x] **C-1** a', '- [ ] C-2 b', '- [~] **C-3b** c', '- [ ] **N-4 (M2 part)** d', '- [ ] C-5 (x part) e', '- [ ] **C-6** (CI part) f', '- [ ] C7 no', '- [ ] C-12xy no', 'C-8 not a checklist line', '- [ ] **[lawyer]** g'))).toEqual([
      { id: 'C-1', part: null, line: 3 },
      { id: 'C-2', part: null, line: 4 },
      { id: 'C-3b', part: null, line: 5 },
      { id: 'N-4', part: 'M2 part', line: 6 },
      { id: 'C-5', part: 'x part', line: 7 },
      { id: 'C-6', part: null, line: 8 },
    ]);
    // A non-bold duplicate (the slip the M5 test missed), a part with no whole item, two parts with one label.
    expect(roadmapIdProblems(doc('- [x] **C-1** a', '- [ ] C-1 b', '- [ ] **C-2 (a part)** c', '- [ ] **C-1 (a part)** d', '- [ ] **C-1 (a part)** e'), ['C-1', 'C-2'])).toEqual([
      'C-1 is a whole item twice',
      'C-2 (a part) names no whole C-2 item (line 5)',
      'C-1 has two "(a part)" parts',
    ]);
    // Review m5: an id line in a form the parser doesn't know is reported, never skipped.
    expect(roadmapIdProblems(doc('- [x] **C-1** a', '- [ ] **C-1:** colon', '- [X] **C-1** upper', '  - [ ] C-1 indented', '* [ ] C-1 star', '- [ ] **c-1** lower', '- [ ] see C-1 in the text'), ['C-1'])).toEqual([
      'line 4: an id line the parser does not read: "- [ ] **C-1:** colon"',
      'line 5: an id line the parser does not read: "- [X] **C-1** upper"',
      'line 6: an id line the parser does not read: "  - [ ] C-1 indented"',
      'line 7: an id line the parser does not read: "* [ ] C-1 star"',
      'line 8: an id line the parser does not read: "- [ ] **c-1** lower"',
    ]);
    // A suffixed duplicate, and the two-way C-table check.
    expect(roadmapIdProblems(doc('- [ ] **C-10b** a', '- [ ] C-10b b', '- [ ] **C-9** c'), ['C-10b', 'C-11', 'C-11'])).toEqual([
      'C-10b is a whole item twice',
      'C-9 is in the ROADMAP but not in the C-table',
      'C-11 is in the C-table but not in the ROADMAP',
      'C-11 is in the C-table twice',
    ]);
    const table = ['| Id | Requirement |', '|---|---|', '| **C-1** | a |', '| C-10b | b |'];
    expect(cTable(['## 5. x', '| C-99 | no |', '## 6. Engineering requirements', '', ...table, '### 6.1 sub', '| C-2 | sub-table row counts |', '## 7. y', '| C-98 | no |'].join('\n'))).toEqual(['C-1', 'C-10b', 'C-2']);
  });
});
