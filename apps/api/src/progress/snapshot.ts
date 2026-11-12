import { createHash } from 'node:crypto';
import {
  compactHistory,
  SNAPSHOT_EVERY,
  type Catalogue,
  type FreshnessThresholds,
  type ProgressHistory,
  type ProgressSnapshot,
  type RewardsData,
} from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor, type SealContext } from '../crypto/userkeys.js';
import { progressSnapshots } from '../db/schema.js';
import type { Db } from '../types.js';
import { countEventsAfter, loadHistoryAfter, type Tx } from './store.js';

/**
 * M6 Step 7 (Ruling 18, M5 m12): the sealed progress snapshot, a cache of the C15 fold, never a record. It holds core's
 * `ProgressSnapshot` of the events up to `upto_seq` (and every grant made for them, or for an event erased before it
 * was written), so a read folds only the events after it. It can never lower anything (spec §6): it is
 * `compactHistory(history, 0, cat).base`, the very fold `deriveProgress` and `grantsFor` read, and any event delete
 * drops it (the `progress_events_drop_snapshot` trigger), so the ledgers it was folded from are still the ledgers.
 * A missing, stale (another catalogue hash) or unreadable snapshot means the full read, exactly M5's behaviour.
 */

/** Reads, and on a blob that won't open deletes in a savepoint, a player's snapshot. */
type Reader = Pick<Db, 'select'> & Partial<Pick<Db, 'transaction'>>;
/** Where a content-free warning goes (the request's logger); nothing when absent. */
export interface SnapshotLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** The seal context of a player's snapshot: one row per player, so the row id is the user id. */
const snapshotSealContext = (userId: string): SealContext => ({ table: 'progress_snapshots', userId, rowId: userId });

/** JSON with keys sorted, Maps as sorted entries and Sets as sorted arrays: one text per value, whatever its order. */
function canonical(v: unknown): unknown {
  if (v instanceof Map) return [...v].map(([k, x]) => [canonical(k), canonical(x)]).sort((a, b) => cmp(JSON.stringify(a[0]), JSON.stringify(b[0])));
  if (v instanceof Set) return [...v].map(canonical).sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null)
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  return v;
}
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const hashes = new WeakMap<Catalogue, { rewards: RewardsData; thresholds: FreshnessThresholds; hash: string }>();

/**
 * What a snapshot was folded under: sha256 over the canonical JSON of the catalogue (every recipe, quest, technique and
 * frame id with the fields the fold reads, and each stall's questions with their bank and answer, since a pick is
 * scored from the file), `data/rewards.yaml` and the freshness thresholds. Any change gives another hash, so a snapshot
 * folded under the old content is ignored and rebuilt: a retune is never "baked in" by a stale fold, and since grants
 * are fixed when made, a rebuild lowers nothing (§6). Memoized per catalogue object (built once per recipe index).
 */
export function catalogueHash(cat: Catalogue, rewards: RewardsData, thresholds: FreshnessThresholds): string {
  const memo = hashes.get(cat);
  if (memo && memo.rewards === rewards && memo.thresholds === thresholds) return memo.hash;
  const market = cat.market === undefined ? null : new Map([...cat.market].map(([stall, s]) => [stall, s.questions]));
  const text = JSON.stringify(
    canonical({ v: 1, recipes: cat.recipes, quests: cat.quests, techniques: cat.techniques, frames: cat.frames, market, rewards, thresholds }),
  );
  const hash = createHash('sha256').update(text).digest('hex');
  hashes.set(cat, { rewards, thresholds, hash });
  return hash;
}

/** The snapshot row's plain columns (no unseal). */
async function snapshotRow(db: Pick<Db, 'select'>, userId: string) {
  const rows = await db
    .select({ uptoSeq: progressSnapshots.uptoSeq, catalogueHash: progressSnapshots.catalogueHash, sealed: progressSnapshots.sealed, createdAt: progressSnapshots.createdAt })
    .from(progressSnapshots)
    .where(eq(progressSnapshots.userId, userId));
  return rows.length === 0 ? undefined : rows[0];
}

const isSnapshot = (v: unknown): v is ProgressSnapshot => typeof v === 'object' && v !== null && 'view' in v && 'facts' in v;

/**
 * The history `grantsFor` and `deriveProgress` need, from the snapshot when it is usable: `base` = the snapshot (events
 * with seq ≤ upto_seq, and every grant whose event row is among them or no longer exists at snapshot time), `events` =
 * seq > upto_seq in order, `grants` = those for the tail's events. No usable snapshot (none, hash differs, unseal
 * fails) → the full read (`base: null`), exactly M5's behaviour. A snapshot that fails to unseal is deleted (in a
 * savepoint, when `db` can open one; a failed delete is left for the next write) and logged as a content-free warning.
 */
export async function loadHistoryWithSnapshot(
  db: Reader,
  keyring: Keyring,
  userId: string,
  cat: Catalogue,
  hash: string,
  log?: SnapshotLog,
): Promise<ProgressHistory> {
  void cat; // part of the contract: the hash is of this catalogue
  return (await historyAndSeq(db, keyring, userId, hash, log)).history;
}

async function historyAndSeq(db: Reader, keyring: Keyring, userId: string, hash: string, log?: SnapshotLog) {
  const row = await snapshotRow(db, userId);
  let base: ProgressSnapshot | null = null;
  let after: number | null = null;
  if (row !== undefined && row.catalogueHash === hash) {
    try {
      const opened = await openFor<unknown>(db, keyring, snapshotSealContext(userId), row.sealed);
      if (!isSnapshot(opened)) throw new Error('not a snapshot');
      base = opened;
      after = row.uptoSeq;
    } catch {
      log?.warn({ progress: 'snapshot', failure: 'unseal' }, 'progress snapshot unreadable; rebuilding from the ledgers');
      await dropUnreadable(db, userId, row.uptoSeq);
    }
  }
  const { events, grants, lastSeq } = await loadHistoryAfter(db, keyring, userId, after);
  return { history: { events, grants, base } satisfies ProgressHistory, lastSeq };
}

async function dropUnreadable(db: Reader, userId: string, uptoSeq: number): Promise<void> {
  if (db.transaction === undefined) return;
  try {
    // A savepoint, so a concurrent rewrite (a serialization failure under repeatable read) can't fail the read.
    await db.transaction((sp) =>
      sp.delete(progressSnapshots).where(and(eq(progressSnapshots.userId, userId), eq(progressSnapshots.uptoSeq, uptoSeq))),
    );
  } catch {
    // Left for the next write, which replaces it; the read already ignores it.
  }
}

/**
 * Under `progress:` (the caller holds it, after its events and grants are written: `progress_snapshots` is last in the
 * table order). When more than SNAPSHOT_EVERY events were recorded since the usable snapshot (or since the start, when
 * there is none or its hash differs), fold the history and upsert the sealed snapshot. Otherwise nothing: one count.
 */
export async function maybeWriteSnapshot(tx: Tx, keyring: Keyring, userId: string, cat: Catalogue, hash: string, now: Date, log?: SnapshotLog): Promise<void> {
  const row = await snapshotRow(tx, userId);
  const since = row !== undefined && row.catalogueHash === hash ? row.uptoSeq : null;
  if ((await countEventsAfter(tx, userId, since)) <= SNAPSHOT_EVERY) return;
  const { history, lastSeq } = await historyAndSeq(tx, keyring, userId, hash, log);
  if (history.events.length === 0) return;
  const base = compactHistory(history, 0, cat).base;
  if (base === null) return;
  const sealed = await sealFor(tx, keyring, snapshotSealContext(userId), base, now);
  await tx
    .insert(progressSnapshots)
    .values({ userId, uptoSeq: lastSeq, catalogueHash: hash, sealed, createdAt: now })
    .onConflictDoUpdate({ target: progressSnapshots.userId, set: { uptoSeq: lastSeq, catalogueHash: hash, sealed, createdAt: now } });
}

/**
 * The export's `progress.snapshot` (C-7): the cache decrypted, with when and up to which event it was folded, or null
 * when there is none. One that won't open is shown as unreadable (it is ignored and rebuilt), never as a guess.
 */
export async function loadSnapshotForExport(db: Pick<Db, 'select'>, keyring: Keyring, userId: string) {
  const row = await snapshotRow(db, userId);
  if (row === undefined) return null;
  const meta = { uptoSeq: row.uptoSeq, catalogueHash: row.catalogueHash, createdAt: row.createdAt.toISOString() };
  try {
    const opened = await openFor<ProgressSnapshot>(db, keyring, snapshotSealContext(userId), row.sealed);
    return { ...meta, view: opened.view, facts: opened.facts };
  } catch {
    return { ...meta, unreadable: true as const };
  }
}
