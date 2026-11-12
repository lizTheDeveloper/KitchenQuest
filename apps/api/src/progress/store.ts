import { randomUUID } from 'node:crypto';
import type { ProgressEvent, ProgressEventKind, ProgressHistory, RewardGrant } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import { progressEvents, rewardGrants, type GRANT_KINDS, type PROGRESS_KINDS } from '../db/schema.js';
import type { Db } from '../types.js';

// The stored kinds are exactly core's: each list holds every kind and nothing else (a compile error otherwise).
// M6: core's `stall_round` (Step 3) is stored only from Step 6, which adds the kind, its strict shape, the sealed body
// of a Protein Counter round (Ruling 17) and the migration together. Until then it is not a stored kind: the service
// rejects it before core sees it (`unknown_kind`), so no round lands unsealed. Step 6 removes this Exclude.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: Same<(typeof PROGRESS_KINDS)[number], Exclude<ProgressEventKind, 'stall_round'>> = true;
const grantKindsAgree: Same<(typeof GRANT_KINDS)[number], RewardGrant['kind']> = true;
void kindsAgree;
void grantKindsAgree;

type Reader = Pick<Db, 'select'>;
/** A transaction (the same type as `consent/ledger.ts`'s, declared here: progress/ imports nothing from consent/). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** An event as stored: the client id, kind and date are columns; `body` holds the rest of the core event. */
function eventOf(row: { clientId: string; kind: string; at: string; body: unknown; mealLogId: string | null }): ProgressEvent {
  const body = typeof row.body === 'object' && row.body !== null && !Array.isArray(row.body) ? row.body : {};
  return { ...body, id: row.clientId, kind: row.kind, at: row.at, ...(row.mealLogId === null ? {} : { mealLogId: row.mealLogId }) } as ProgressEvent;
}

const eventColumns = {
  clientId: progressEvents.clientId,
  kind: progressEvents.kind,
  at: progressEvents.at,
  body: progressEvents.body,
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
 * those whose event was erased. `base` is always null: the account ledger is never compacted (C15 is device-only).
 */
export async function loadHistory(db: Reader, userId: string): Promise<ProgressHistory> {
  const events = await db
    .select(eventColumns)
    .from(progressEvents)
    .where(eq(progressEvents.userId, userId))
    .orderBy(asc(progressEvents.seq));
  const grants = await db.select({ kind: rewardGrants.kind, body: rewardGrants.body }).from(rewardGrants).where(eq(rewardGrants.userId, userId));
  return { events: events.map(eventOf), grants: grants.map(grantOf).sort(byGrantId), base: null };
}

/**
 * Inserts accepted events, in order, and the grants each earned, inside the caller's transaction (which holds
 * `lockLiveUser` and `progress:`). Events go first and grants after (the lock order's table order). `event` must be
 * the event as `grantsFor` returned it, a dropped claim removed.
 */
export async function insertEvents(tx: Tx, userId: string, accepted: readonly { event: ProgressEvent; grants: readonly RewardGrant[] }[], at: Date): Promise<void> {
  if (accepted.length === 0) return;
  const rows = accepted.map(({ event }) => {
    // A meal log's id is a column (the cascade from meal_logs), never in the body.
    const { id: clientId, kind, at: day, mealLogId, ...body } = event as ProgressEvent & { mealLogId?: string };
    return { id: randomUUID(), userId, clientId, kind, at: day, body, mealLogId: mealLogId ?? null, createdAt: at };
  });
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

/** The export's events and grants (C-7): every stored field but the internal row ids, events oldest first, grants by day. */
export async function loadProgressForExport(db: Reader, userId: string) {
  const events = await db
    .select({ ...eventColumns, createdAt: progressEvents.createdAt })
    .from(progressEvents)
    .where(eq(progressEvents.userId, userId))
    .orderBy(asc(progressEvents.seq));
  const grants = await db.select({ kind: rewardGrants.kind, body: rewardGrants.body }).from(rewardGrants).where(eq(rewardGrants.userId, userId));
  return {
    events: events.map((r) => ({ ...eventOf(r), createdAt: r.createdAt.toISOString() })),
    // Grants hold no time (I2 ruling): their `isoDay` is the date shown.
    grants: grants.map(grantOf).sort((a, b) => (a.isoDay < b.isoDay ? -1 : a.isoDay > b.isoDay ? 1 : byGrantId(a, b))),
  };
}
