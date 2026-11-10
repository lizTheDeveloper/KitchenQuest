import { randomUUID } from 'node:crypto';
import { normalizeName, type PantryItem } from '@kitchenquest/core';
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
import { loadPantryForExport, pantrySealContext } from './store.js';

export { MAX_PANTRY_ITEMS };
/** A pantry item's name, after trim (N-7; the same cap as core's pantry card). */
const PANTRY_NAME_MAX = 80;
/** Ids are uuids; anything longer is no id of ours. */
const ID_MAX = 64;

/** One pantry item as the client sends it; the name is trimmed, then 1–80 characters. */
const PantryItemBody = z
  .object({
    name: z.string().trim().min(1).max(PANTRY_NAME_MAX),
    ingredientId: z.string().max(ID_MAX).nullable(),
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

/** `change` parsed against the strict shape (a ZodError is a 400), with every `ingredientId` null or in the graph. */
function parseChange(change: unknown, catalog: Catalog): PantryChange {
  const parsed = PantryChangeBody.parse(change);
  if (parsed.add.some((i) => i.ingredientId !== null && !catalog.graph.has(i.ingredientId))) {
    throw new ApiError(400, 'bad_request', 'The pantry change is not valid', { problems: ['add[].ingredientId must be null or an ingredient id'] });
  }
  return parsed;
}

/**
 * Which pantry items a removal names: `removeNames` match case-insensitively
 * (core's normalizeName), or by ingredient id when the name resolves in the
 * graph; `removeIds` match exactly. The one matching rule for the service and
 * for the mentor's pantry card, which resolves names to ids when it is
 * proposed (Step 8: confirm then removes exactly those ids).
 */
export function pantryMatcher(
  removeNames: readonly string[],
  removeIds: readonly string[],
  graph: Catalog['graph'],
): (item: { id: string; name: string; ingredientId: string | null }) => boolean {
  const names = new Set(removeNames.map(normalizeName).filter((n) => n !== ''));
  const resolved = new Set(removeNames.map((n) => graph.resolve(n)).filter((id): id is string => id !== null));
  const ids = new Set(removeIds.map((id) => id.toLowerCase()));
  return (i) => ids.has(i.id) || names.has(normalizeName(i.name)) || (i.ingredientId !== null && resolved.has(i.ingredientId));
}

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
  const change = parseChange(input, deps.catalog);
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
  for (const { name, ingredientId } of change.add) {
    // Generated before insert: the seal is bound to it (C-3).
    const id = randomUUID();
    const value: PantryItem = { name, ingredientId };
    added.push({ ...value, id, createdAt: at, sealed: await sealFor(tx, deps.keyring, pantrySealContext(userId, id), value, at) });
  }
  if (added.length > 0) {
    await tx.insert(pantryItems).values(added.map(({ id, sealed }) => ({ id, userId, sealed, createdAt: at })));
  }
  if (removed.length > 0 || added.length > 0) {
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action, requestId }, at);
  }
  const strip = ({ name, ingredientId, id }: Row): Row => ({ name, ingredientId, id });
  return { items: [...kept, ...added].sort(byAge).map(strip), removed: removed.map(strip), addedIds: added.map((a) => a.id) };
}

/**
 * Changes the player's pantry, inside the caller's transaction. Order: shape
 * (400) → live user (401) → the player's pantry lock → remove → cap (400
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
  const add = removed.map(({ name, ingredientId }) => ({ name, ingredientId }));
  const { addedIds: restored } = await applyChange(tx, deps, userId, { add, removeNames: [], removeIds: addedIds }, at, 'pantry.restore', requestId);
  return { addedIds: restored };
}
