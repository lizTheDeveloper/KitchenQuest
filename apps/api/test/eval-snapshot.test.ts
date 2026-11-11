// M4 Step 12 fix round 1 (I3): the eval's noWrite compares the player's records by content, not by row counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { changedRecords, recordsSnapshot } from '../eval/snapshot.js';
import { testDb, type Sql } from './helpers/db.js';

let sql: Sql;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ sql, close } = await testDb());
});
afterAll(async () => {
  await close?.();
});

async function user(): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`insert into users (email, age_confirmed_at, created_at) values (${`snap${Math.random()}@example.com`}, now(), now()) returning id`;
  return id;
}

describe('recordsSnapshot (eval noWrite)', () => {
  it('sees an in-place rule update and a delete + insert, which keep the row count', async () => {
    const u = await user();
    const id1 = '00000000-0000-4000-8000-000000000001';
    await sql`insert into rules (id, user_id, sealed, created_at, updated_at) values (${id1}, ${u}, ${Buffer.from('a')}, now(), now())`;
    const before = await recordsSnapshot(sql, u);
    expect(changedRecords(before, await recordsSnapshot(sql, u))).toEqual([]);
    await sql`update rules set sealed = ${Buffer.from('b')} where id = ${id1}`;
    const updated = await recordsSnapshot(sql, u);
    expect(changedRecords(before, updated)).toEqual(['rules']);
    await sql`delete from rules where id = ${id1}`;
    await sql`insert into rules (id, user_id, sealed, created_at, updated_at) values (${'00000000-0000-4000-8000-000000000002'}, ${u}, ${Buffer.from('b')}, now(), now())`;
    expect(changedRecords(updated, await recordsSnapshot(sql, u))).toEqual(['rules']);
  });

  it('sees a consent change and a pre-existing proposal decided; a new open proposal is not a write', async () => {
    const u = await user();
    const before = await recordsSnapshot(sql, u);
    await sql`insert into consents (user_id, purpose, notice_version, notice_sha256, granted_at, method) values (${u}, 'health_data', 'v2', ${Buffer.alloc(32, 1)}, now(), 'api')`;
    const granted = await recordsSnapshot(sql, u);
    expect(changedRecords(before, granted)).toEqual(['consents']);
    const p = (id: string, status: string) =>
      sql`insert into mentor_proposals (id, user_id, kind, severe, status, sealed, expires_at) values (${id}, ${u}, 'rule', true, ${status}, ${Buffer.from('c')}, now() + interval '30 minutes')`;
    const old = '00000000-0000-4000-8000-0000000000a1';
    await p(old, 'open');
    const seeded = await recordsSnapshot(sql, u);
    await p('00000000-0000-4000-8000-0000000000a2', 'open');
    expect(changedRecords(seeded, await recordsSnapshot(sql, u))).toEqual([]);
    await sql`update mentor_proposals set status = 'confirmed', decided_at = now() where id = ${old}`;
    expect(changedRecords(seeded, await recordsSnapshot(sql, u))).toEqual(['mentor_proposals']);
    const later = await recordsSnapshot(sql, u);
    await p('00000000-0000-4000-8000-0000000000a3', 'confirmed');
    expect(changedRecords(later, await recordsSnapshot(sql, u))).toEqual(['mentor_proposals']);
  });

  it('snapshot: a plan saved during a case breaks noWrite (meal_plans in TABLES, M5 Step 8, C23)', async () => {
    const u = await user();
    const before = await recordsSnapshot(sql, u);
    await sql`insert into meal_plans (user_id, week_start, sealed) values (${u}, '2026-11-09', ${Buffer.from('p')})`;
    const saved = await recordsSnapshot(sql, u);
    expect(changedRecords(before, saved)).toEqual(['meal_plans']);
    // A plan rewritten in place for the same week is a write too.
    await sql`update meal_plans set sealed = ${Buffer.from('q')} where user_id = ${u}`;
    expect(changedRecords(saved, await recordsSnapshot(sql, u))).toEqual(['meal_plans']);
  });
});
