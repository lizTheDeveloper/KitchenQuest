import { randomUUID } from 'node:crypto';
import type { ProgressEvent, ProgressEventKind, ProgressHistory, RewardGrant } from '@kitchenquest/core';
import { asc, eq } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { progressEvents, rewardGrants, type GRANT_KINDS, type PROGRESS_KINDS } from '../db/schema.js';
import type { Db } from '../types.js';
import { eventBodyOpener, sealEventBody } from './seal.js';

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
export const SEALED_KINDS: ReadonlySet<ProgressEventKind> = new Set(['stall_round']);

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
 * those whose event was erased. `base` is always null: the account ledger is never compacted (C15 is device-only).
 * Sealed bodies (every `stall_round`) are opened with the player's key (M6 Step 6).
 */
export async function loadHistory(db: Reader, keyring: Keyring, userId: string): Promise<ProgressHistory> {
  const events = await db
    .select(eventColumns)
    .from(progressEvents)
    .where(eq(progressEvents.userId, userId))
    .orderBy(asc(progressEvents.seq));
  const grants = await db.select({ kind: rewardGrants.kind, body: rewardGrants.body }).from(rewardGrants).where(eq(rewardGrants.userId, userId));
  return { events: await eventsOf(db, keyring, userId, events), grants: grants.map(grantOf).sort(byGrantId), base: null };
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
  for (const { event } of accepted) {
    // A meal log's id is a column (the cascade from meal_logs), never in the body.
    const { id: clientId, kind, at: day, mealLogId, ...body } = event as ProgressEvent & { mealLogId?: string };
    const id = randomUUID();
    const sealed = SEALED_KINDS.has(kind) ? await sealEventBody(tx, keyring, userId, id, body, at) : null;
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
