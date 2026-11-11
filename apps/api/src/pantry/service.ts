import { randomUUID } from 'node:crypto';
import { isValidDate, pantryMatcher, type PantryItem } from '@kitchenquest/core';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { sealFor } from '../crypto/userkeys.js';
import { ADVISORY_LOCK } from '../db/advisory-locks.js';
import { pantryItems } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { MAX_PANTRY_ITEMS } from '../mentor/constants.js';
import { loadPantryForExport, pantryFields, pantrySealContext } from './store.js';

export { MAX_PANTRY_ITEMS };

const DAY_MS = 86_400_000;
/** `date` (YYYY-MM-DD) moved by `days` whole calendar days. */
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
/** A pantry item's name, after trim (N-7; the same cap as core's pantry card). */
const PANTRY_NAME_MAX = 80;
/** Ids are uuids; anything longer is no id of ours. */
const ID_MAX = 64;

/** How far back a pantry item's purchase date may be, and how far ahead (the player's date may be a day past ours). */
const PANTRY_ADDED_DAYS_BACK = 60;
const PANTRY_ADDED_DAYS_AHEAD = 1;

/**
 * One pantry item as the client sends it; the name is trimmed, then 1–80 characters. `addedOn` (the local date it
 * was bought) and `source` are optional (M5 Ruling 12): a market tick sets both; nothing else needs to.
 */
const PantryItemBody = z
  .object({
    name: z.string().trim().min(1).max(PANTRY_NAME_MAX),
    ingredientId: z.string().max(ID_MAX).nullable(),
    addedOn: z.string().max(10).optional(),
    source: z.enum(['told', 'market']).optional(),
  })
  .strict();

/** A pantry change: items to add, names and ids to remove. Arrays are bounded by the cap. */
export const PantryChangeBody = z
  .object({
    add: z.array(PantryItemBody).max(MAX_PANTRY_ITEMS),
    removeNames: z.array(z.string().max(PANTRY_NAME_MAX)).max(MAX_PANTRY_ITEMS),
    removeIds: z.array(z.string().max(ID_MAX)).max(MAX_PANTRY_ITEMS),
  })
  .strict();
type PantryChange = z.infer<typeof PantryChangeBody>;

export interface PantryDeps {
  keyring: Keyring;
  catalog: Catalog;
}

type Row = PantryItem & { id: string };

/**
 * Serializes the player's pantry writes: pg_advisory_xact_lock(ADVISORY_LOCK.pantry, hashtext(userId)),
 * held until commit, so the MAX_PANTRY_ITEMS cap sees every committed write of the
 * same player. In the global lock order (pre-flight C13) it comes after
 * `lockLiveUser` and `rules:`, before the consent row. Re-entrant within one transaction.
 */
export async function lockUserPantry(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK.pantry}, hashtext(${userId}))`);
}

/**
 * `change` parsed against the strict shape (a ZodError is a 400), with every `ingredientId` null or in the graph and,
 * unless `anyDate` (an undo puts back rows exactly as they were), every `addedOn` a real date within
 * [today − PANTRY_ADDED_DAYS_BACK, today + PANTRY_ADDED_DAYS_AHEAD] of `at`'s UTC date.
 */
function parseChange(change: unknown, catalog: Catalog, at: Date, anyDate: boolean): PantryChange {
  const parsed = PantryChangeBody.parse(change);
  const problems: string[] = [];
  if (parsed.add.some((i) => i.ingredientId !== null && !catalog.graph.has(i.ingredientId))) {
    problems.push('add[].ingredientId must be null or an ingredient id');
  }
  const today = at.toISOString().slice(0, 10);
  const [from, to] = [addDays(today, -PANTRY_ADDED_DAYS_BACK), addDays(today, PANTRY_ADDED_DAYS_AHEAD)];
  const badDate = (d: string) => !isValidDate(d) || (!anyDate && (d < from || d > to));
  if (parsed.add.some((i) => i.addedOn !== undefined && badDate(i.addedOn))) {
    problems.push(`add[].addedOn must be a real date within ${PANTRY_ADDED_DAYS_BACK} days before today and ${PANTRY_ADDED_DAYS_AHEAD} day after`);
  }
  if (problems.length > 0) throw new ApiError(400, 'bad_request', 'The pantry change is not valid', { problems });
  return parsed;
}

/** The one matching rule for the service, the mentor's pantry card and the client's device pantry (core). */
export { pantryMatcher };

const byAge = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function applyChange(
  tx: Tx,
  deps: PantryDeps,
  userId: string,
  input: unknown,
  at: Date,
  action: 'pantry.change' | 'pantry.restore',
  requestId?: string,
): Promise<{ items: Row[]; removed: Row[]; addedIds: string[] }> {
  const change = parseChange(input, deps.catalog, at, action === 'pantry.restore');
  await lockLiveUser(tx, userId);
  await lockUserPantry(tx, userId);
  const existing = await loadPantryForExport(tx, deps.keyring, userId);

  const matches = pantryMatcher(change.removeNames, change.removeIds, deps.catalog.graph);
  const removed = existing.filter(matches);
  const kept = existing.filter((i) => !matches(i));

  if (kept.length + change.add.length > MAX_PANTRY_ITEMS) {
    throw new ApiError(400, 'too_many_items', `Your pantry can hold at most ${MAX_PANTRY_ITEMS} items`, { max: MAX_PANTRY_ITEMS });
  }
  if (removed.length > 0) {
    await tx.delete(pantryItems).where(and(eq(pantryItems.userId, userId), inArray(pantryItems.id, removed.map((i) => i.id))));
  }
  const added: (Row & { createdAt: Date; sealed: Buffer })[] = [];
  for (const item of change.add) {
    // Generated before insert: the seal is bound to it (C-3).
    const id = randomUUID();
    const value = pantryFields(item);
    added.push({ ...value, id, createdAt: at, sealed: await sealFor(tx, deps.keyring, pantrySealContext(userId, id), value, at) });
  }
  if (added.length > 0) {
    await tx.insert(pantryItems).values(added.map(({ id, sealed }) => ({ id, userId, sealed, createdAt: at })));
  }
  if (removed.length > 0 || added.length > 0) {
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action, requestId }, at);
  }
  const strip = (row: Row): Row => ({ ...pantryFields(row), id: row.id });
  return { items: [...kept, ...added].sort(byAge).map(strip), removed: removed.map(strip), addedIds: added.map((a) => a.id) };
}

/**
 * Changes the player's pantry, inside the caller's transaction. Order: shape
 * (400; an `addedOn` outside [today − 60, today + 1] too) → live user (401) → the player's pantry lock → remove → cap (400
 * `too_many_items`) → seal → insert → audit 'pantry.change' (no content, no
 * ids), only when something changed. No consent: the pantry's basis is
 * contract (H-11). `removeNames` match case-insensitively on name, or on
 * `ingredientId` when the name resolves; `removeIds` match exactly (undo uses
 * ids, so an item of the same name that was already there is never touched).
 * Unmatched names and ids are ignored and not reported. Returns the whole
 * pantry after the change, oldest first, the removed items and the new rows' ids
 * (an undo removes exactly those).
 */
export async function changePantryIn(
  tx: Tx,
  deps: PantryDeps,
  userId: string,
  change: { add: PantryItem[]; removeNames: string[]; removeIds: string[] },
  at: Date,
  requestId?: string,
): Promise<{ items: Row[]; removed: Row[]; addedIds: string[] }> {
  return applyChange(tx, deps, userId, change, at, 'pantry.change', requestId);
}

/**
 * Undoes a pantry change (Step 8): removes `addedIds` and puts `removed` back
 * (as new rows), in the same order of locks and checks as `changePantryIn`
 * (so 400 `too_many_items` when the pantry has filled up since). Audits
 * 'pantry.restore'. Returns the ids of the rows put back.
 */
export async function restorePantryIn(
  tx: Tx,
  deps: PantryDeps,
  userId: string,
  removed: PantryItem[],
  addedIds: string[],
  at: Date,
  requestId?: string,
): Promise<{ addedIds: string[] }> {
  // Put back as they were, purchase date and source included.
  const add = removed.map(pantryFields);
  const { addedIds: restored } = await applyChange(tx, deps, userId, { add, removeNames: [], removeIds: addedIds }, at, 'pantry.restore', requestId);
  return { addedIds: restored };
}
