import type { Sql } from '../test/helpers/db.js';

/**
 * The player's records whose content a turn must never change (fix round 1, I3: content, not row counts). M5 Step 8
 * (C23): the weekly loop's tables too, so a plan saved (or a run, a progress event, a grant, a margin note or a
 * shared-table row written) during a case breaks noWrite. M6 Step 8: and the progress snapshot.
 */
const TABLES = [
  'rules',
  'meal_logs',
  'pantry_items',
  'profiles',
  'consents',
  'meal_plans',
  'market_runs',
  'progress_events',
  'reward_grants',
  'margin_notes',
  'shared_table',
  // M6 Step 7/8: the sealed progress snapshot, so a snapshot written during a case breaks noWrite too.
  'progress_snapshots',
] as const;

export interface RecordsSnapshot {
  /** Per table: a hash of every row of the player's, whole, in a fixed order. */
  tables: Record<(typeof TABLES)[number], string>;
  /** Per proposal id: its decision state (status, decided time, write ref, channel, undo payload). */
  proposals: Map<string, string>;
}

/** Every record of the player's that a write could touch, by content. */
export async function recordsSnapshot(sql: Sql, userId: string): Promise<RecordsSnapshot> {
  const tables = {} as RecordsSnapshot['tables'];
  for (const t of TABLES) {
    const [row] = await sql<{ h: string | null }[]>`
      select md5(string_agg(r::text, '|' order by r::text)) as h from ${sql(t)} r where r.user_id = ${userId}`;
    tables[t] = row.h ?? '';
  }
  const rows = await sql<{ id: string; state: string }[]>`
    select id::text, concat_ws('|', status, decided_at::text, write_ref::text, channel, md5(undo_sealed)) as state
    from mentor_proposals where user_id = ${userId}`;
  return { tables, proposals: new Map(rows.map((r) => [r.id, r.state])) };
}

/**
 * What changed between two snapshots: each table whose content differs, and `mentor_proposals` when a card
 * that existed before was decided, changed or removed, or a new card arrived already decided. A turn's new
 * open card is not a write.
 */
export function changedRecords(before: RecordsSnapshot, after: RecordsSnapshot): string[] {
  const out: string[] = TABLES.filter((t) => before.tables[t] !== after.tables[t]);
  const touched =
    [...before.proposals].some(([id, state]) => after.proposals.get(id) !== state) ||
    [...after.proposals].some(([id, state]) => !before.proposals.has(id) && state.split('|')[0] !== 'open');
  if (touched) out.push('mentor_proposals');
  return out;
}
