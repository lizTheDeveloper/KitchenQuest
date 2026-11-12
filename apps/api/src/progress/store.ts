import { randomUUID } from 'node:crypto';
import type { ProgressEvent, ProgressEventKind, ProgressHistory, RewardGrant } from '@kitchenquest/core';
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { progressEvents, rewardGrants, type GRANT_KINDS, type PROGRESS_KINDS } from '../db/schema.js';
import type { Db } from '../types.js';
import { eventBodyOpener, eventBodySealer } from './seal.js';

// The stored kinds are exactly core's: each list holds every kind and nothing else (a compile error otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: Same<(typeof PROGRESS_KINDS)[number], ProgressEventKind> = true;
const grantKindsAgree: Same<(typeof GRANT_KINDS)[number], RewardGrant['kind']> = true;
void kindsAgree;
void grantKindsAgree;

/**
 * The kinds whose body is sealed at rest (M6 Step 6): every `stall_round`, by kind (Task 3 privacy ruling: answered
 * question ids can imply a rule over time), not only the Protein Counter rounds core's `isHealthRevealing` names (that
 * decides only their `health_data` consent). Its plain `body` is `{}`; `sealed` holds the whole body. The schema's
 * `progress_events_sealed_check` holds the database to the same rule.
 */
const SEALED_KINDS: ReadonlySet<ProgressEventKind> = new Set(['stall_round']);

type Reader = Pick<Db, 'select'>;
/** A transaction (the same type as `consent/ledger.ts`'s, declared here: progress/ imports nothing from consent/). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

interface EventRow {
  id: string;
  clientId: string;
  kind: string;
  at: string;
  body: unknown;
  sealed: Buffer | null;
  mealLogId: string | null;
}

/**
 * An event as stored: the client id, kind and date are columns; `body` holds the rest of the core event, or, for a
 * sealed kind, `sealed` does (opened here with the player's key; a blob that won't open throws, never a guess).
 */
function eventOf(row: EventRow, open: ((rowId: string, sealed: Buffer) => Record<string, unknown>) | null): ProgressEvent {
  if (row.sealed !== null && open === null) throw new Error('progress: a sealed event without its key');
  const raw = row.sealed === null ? row.body : open!(row.id, row.sealed);
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {};
  return { ...body, id: row.clientId, kind: row.kind, at: row.at, ...(row.mealLogId === null ? {} : { mealLogId: row.mealLogId }) } as ProgressEvent;
}

async function eventsOf(db: Reader, keyring: Keyring, userId: string, rows: readonly EventRow[]): Promise<ProgressEvent[]> {
  // The key is loaded only when a row is sealed: a player with no sealed row may have no data key at all.
  const open = rows.some((r) => r.sealed !== null) ? await eventBodyOpener(db, keyring, userId) : null;
  return rows.map((r) => eventOf(r, open));
}

const eventColumns = {
  id: progressEvents.id,
  clientId: progressEvents.clientId,
  kind: progressEvents.kind,
  at: progressEvents.at,
  body: progressEvents.body,
  sealed: progressEvents.sealed,
  mealLogId: progressEvents.mealLogId,
};

/** A grant as stored: the kind is a column; `body` holds the rest of the self-contained core grant. */
function grantOf(row: { kind: string; body: unknown }): RewardGrant {
  const body = typeof row.body === 'object' && row.body !== null && !Array.isArray(row.body) ? row.body : {};
  return { ...body, kind: row.kind } as RewardGrant;
}

/** Core grant ids are `<eventId>#<n>`: by event, then n as a number, so an event's grants keep their order. */
function byGrantId(a: RewardGrant, b: RewardGrant): number {
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  const n = (g: RewardGrant) => Number(/#(\d+)$/.exec(g.id)?.[1] ?? 0);
  return n(a) - n(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The player's whole progress history, events in the order they were recorded (`seq`) and every grant, including
 * those whose event was erased. `base` is null: this is the ledgers themselves, which are never compacted (C15 is
 * device-only). Sealed bodies (every `stall_round`) are opened with the player's key (M6 Step 6). The export reads
 * this, and so does a snapshot rebuild (M6 Step 7); requests read through `progress/snapshot.ts`.
 */
export async function loadFullHistory(db: Reader, keyring: Keyring, userId: string): Promise<ProgressHistory> {
  const { events, grants } = await loadHistoryAfter(db, keyring, userId, null);
  return { events, grants, base: null };
}

/**
 * The ledgers after a snapshot (M6 Step 7): the events with `seq > afterSeq`, in order, and only the grants made for
 * those events (by their row). With `afterSeq` null, every event and every grant, the erased events' included, as
 * `loadFullHistory`. `lastSeq` is the newest event's `seq` read (or `afterSeq`, or 0, when there is none).
 * Grants are only ever written with their event (`insertEvents`), and any event delete drops the snapshot (the
 * `progress_events_drop_snapshot` trigger), so every grant not returned here is one the snapshot already folded.
 */
export async function loadHistoryAfter(
  db: Reader,
  keyring: Keyring,
  userId: string,
  afterSeq: number | null,
): Promise<{ events: ProgressEvent[]; grants: RewardGrant[]; lastSeq: number }> {
  const rows = await db
    .select({ ...eventColumns, seq: progressEvents.seq })
    .from(progressEvents)
    .where(afterSeq === null ? eq(progressEvents.userId, userId) : and(eq(progressEvents.userId, userId), gt(progressEvents.seq, afterSeq)))
    .orderBy(asc(progressEvents.seq));
  const grants =
    afterSeq === null
      ? await db.select({ kind: rewardGrants.kind, body: rewardGrants.body }).from(rewardGrants).where(eq(rewardGrants.userId, userId))
      : rows.length === 0
        ? []
        : await db
            .select({ kind: rewardGrants.kind, body: rewardGrants.body })
            .from(rewardGrants)
            .where(and(eq(rewardGrants.userId, userId), inArray(rewardGrants.eventId, rows.map((r) => r.id))));
  return {
    events: await eventsOf(db, keyring, userId, rows),
    grants: grants.map(grantOf).sort(byGrantId),
    lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : (afterSeq ?? 0),
  };
}

/** How many of the player's events have `seq > afterSeq` (all of them for null): the tail a snapshot would fold. */
export async function countEventsAfter(db: Reader, userId: string, afterSeq: number | null): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(progressEvents)
    .where(afterSeq === null ? eq(progressEvents.userId, userId) : and(eq(progressEvents.userId, userId), gt(progressEvents.seq, afterSeq)));
  return row.n;
}

/**
 * What the ledgers already hold for a batch, read from the tables rather than from a loaded history (which, from a
 * snapshot, holds only the tail; M6 Step 7): which of `clientIds` were seen (an event row's client id, or a grant's
 * `eventId`, so an erased event's id stays seen), and which claims are held (`import:<technique>` for every imported
 * technique, `meal:<id>` for each of `mealLogIds` that has its event). The same sets M5 built from the whole history.
 */
export async function recordedFacts(
  db: Reader,
  userId: string,
  clientIds: readonly string[],
  mealLogIds: readonly string[],
): Promise<{ seen: Set<string>; claimed: Set<string> }> {
  const seen = new Set<string>();
  const claimed = new Set<string>();
  if (clientIds.length > 0) {
    const events = await db
      .select({ clientId: progressEvents.clientId })
      .from(progressEvents)
      .where(and(eq(progressEvents.userId, userId), inArray(progressEvents.clientId, [...clientIds])));
    for (const e of events) seen.add(e.clientId);
    const granted = await db
      .select({ eventId: sql<string>`${rewardGrants.body}->>'eventId'` })
      .from(rewardGrants)
      .where(and(eq(rewardGrants.userId, userId), inArray(sql`${rewardGrants.body}->>'eventId'`, [...clientIds])));
    for (const g of granted) seen.add(g.eventId);
  }
  const claims = await db
    .select({ kind: progressEvents.kind, technique: sql<string | null>`${progressEvents.body}->>'technique'`, mealLogId: progressEvents.mealLogId })
    .from(progressEvents)
    .where(
      and(
        eq(progressEvents.userId, userId),
        or(
          eq(progressEvents.kind, 'imported'),
          mealLogIds.length > 0 ? and(isNotNull(progressEvents.mealLogId), inArray(progressEvents.mealLogId, [...mealLogIds])) : sql`false`,
        ),
      ),
    );
  for (const c of claims) {
    if (c.kind === 'imported' && typeof c.technique === 'string') claimed.add(`import:${c.technique}`);
    if (c.kind === 'meal_logged' && c.mealLogId !== null) claimed.add(`meal:${c.mealLogId}`);
  }
  return { seen, claimed };
}

/**
 * Inserts accepted events, in order, and the grants each earned, inside the caller's transaction (which holds
 * `lockLiveUser` and `progress:`). Events go first and grants after (the lock order's table order). `event` must be
 * the event as `grantsFor` returned it, a dropped claim removed. A sealed kind (`SEALED_KINDS`: every `stall_round`)
 * stores `body: {}` and its whole body in `sealed`, with AAD `{ table: 'progress_events', userId, rowId }`.
 */
export async function insertEvents(
  tx: Tx,
  keyring: Keyring,
  userId: string,
  accepted: readonly { event: ProgressEvent; grants: readonly RewardGrant[] }[],
  at: Date,
): Promise<void> {
  if (accepted.length === 0) return;
  const rows: (typeof progressEvents.$inferInsert & { id: string })[] = [];
  // The player's key is loaded once for the post (Task 6 review M4), and only when a sealed kind is in it.
  const seal = accepted.some(({ event }) => SEALED_KINDS.has(event.kind)) ? await eventBodySealer(tx, keyring, userId, at) : null;
  for (const { event } of accepted) {
    // A meal log's id is a column (the cascade from meal_logs), never in the body.
    const { id: clientId, kind, at: day, mealLogId, ...body } = event as ProgressEvent & { mealLogId?: string };
    const id = randomUUID();
    const sealed = seal !== null && SEALED_KINDS.has(kind) ? seal(id, body) : null;
    rows.push({ id, userId, clientId, kind, at: day, body: sealed === null ? body : {}, sealed, mealLogId: mealLogId ?? null, createdAt: at });
  }
  // One statement, so `seq` follows the batch's order.
  await tx.insert(progressEvents).values(rows);
  const grants = accepted.flatMap(({ grants: gs }, i) =>
    gs.map((g) => {
      const { kind, ...body } = g;
      // No time of day (I2 ruling): the grant's own `isoDay` is its only date.
      return { userId, eventId: rows[i].id, kind, body };
    }),
  );
  if (grants.length > 0) await tx.insert(rewardGrants).values(grants);
}

/**
 * The export's events and grants (C-7): every stored field but the internal row ids, events oldest first, grants by
 * day. A sealed body is shown opened: the whole event, decrypted (M6 Step 6).
 */
export async function loadProgressForExport(db: Reader, keyring: Keyring, userId: string) {
  const events = await db
    .select({ ...eventColumns, createdAt: progressEvents.createdAt })
    .from(progressEvents)
    .where(eq(progressEvents.userId, userId))
    .orderBy(asc(progressEvents.seq));
  const grants = await db.select({ kind: rewardGrants.kind, body: rewardGrants.body }).from(rewardGrants).where(eq(rewardGrants.userId, userId));
  return {
    events: (await eventsOf(db, keyring, userId, events)).map((e, i) => ({ ...e, createdAt: events[i].createdAt.toISOString() })),
    // Grants hold no time (I2 ruling): their `isoDay` is the date shown.
    grants: grants.map(grantOf).sort((a, b) => (a.isoDay < b.isoDay ? -1 : a.isoDay > b.isoDay ? 1 : byGrantId(a, b))),
  };
}
