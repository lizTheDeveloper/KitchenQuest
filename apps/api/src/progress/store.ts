import { randomUUID } from 'node:crypto';
import type { ProgressEvent, ProgressEventKind, ProgressHistory, RewardGrant } from '@kitchenquest/core';
import { and, asc, eq } from 'drizzle-orm';
import { progressEvents, rewardGrants, type GRANT_KINDS, type PROGRESS_KINDS } from '../db/schema.js';
import type { Db } from '../types.js';

// The stored kinds are exactly core's: each list holds every kind and nothing else (a compile error otherwise).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsAgree: Same<(typeof PROGRESS_KINDS)[number], ProgressEventKind> = true;
const grantKindsAgree: Same<(typeof GRANT_KINDS)[number], RewardGrant['kind']> = true;
void kindsAgree;
void grantKindsAgree;

type Reader = Pick<Db, 'select'>;
/** A transaction (the same type as `consent/ledger.ts`'s, declared here: progress/ imports nothing from consent/). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** An event as stored: the client id, kind and date are columns; `body` holds the rest of the core event. */
function eventOf(row: { clientId: string; kind: string; at: string; body: unknown }): ProgressEvent {
  const body = typeof row.body === 'object' && row.body !== null && !Array.isArray(row.body) ? row.body : {};
  return { ...body, id: row.clientId, kind: row.kind, at: row.at } as ProgressEvent;
}

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
    .select({ clientId: progressEvents.clientId, kind: progressEvents.kind, at: progressEvents.at, body: progressEvents.body })
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
    const { id: clientId, kind, at: day, ...body } = event;
    return { id: randomUUID(), userId, clientId, kind, at: day, body, createdAt: at };
  });
  // One statement, so `seq` follows the batch's order.
  await tx.insert(progressEvents).values(rows);
  const grants = accepted.flatMap(({ grants: gs }, i) =>
    gs.map((g) => {
      const { kind, ...body } = g;
      return { userId, eventId: rows[i].id, kind, body, createdAt: at };
    }),
  );
  if (grants.length > 0) await tx.insert(rewardGrants).values(grants);
}

/**
 * Erases one `meal_logged` event by its client id (a meal-log undo), keeping its grants: XP, level and the day's
 * nourishment count never drop (spec §6, I2 ruling), and no row or content of the event is kept. Any other kind is
 * never erased here. Returns whether a row went. The caller holds `lockLiveUser` and `progress:`.
 */
export async function eraseMealEventIn(tx: Tx, userId: string, clientId: string): Promise<boolean> {
  const gone = await tx
    .delete(progressEvents)
    .where(and(eq(progressEvents.userId, userId), eq(progressEvents.clientId, clientId), eq(progressEvents.kind, 'meal_logged')))
    .returning({ id: progressEvents.id });
  return gone.length > 0;
}

/** The export's events and grants (C-7): every stored field but the internal row ids, oldest first. */
export async function loadProgressForExport(db: Reader, userId: string) {
  const events = await db
    .select({ clientId: progressEvents.clientId, kind: progressEvents.kind, at: progressEvents.at, body: progressEvents.body, createdAt: progressEvents.createdAt })
    .from(progressEvents)
    .where(eq(progressEvents.userId, userId))
    .orderBy(asc(progressEvents.seq));
  const grants = await db
    .select({ kind: rewardGrants.kind, body: rewardGrants.body, createdAt: rewardGrants.createdAt })
    .from(rewardGrants)
    .where(eq(rewardGrants.userId, userId))
    .orderBy(asc(rewardGrants.createdAt));
  return {
    events: events.map((r) => ({ ...eventOf(r), createdAt: r.createdAt.toISOString() })),
    grants: grants
      .map((r) => ({ grant: grantOf(r), createdAt: r.createdAt.toISOString() }))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : byGrantId(a.grant, b.grant)))
      .map(({ grant, createdAt }) => ({ ...grant, createdAt })),
  };
}
