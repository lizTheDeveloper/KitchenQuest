import type { Keyring } from '../crypto/keyring.js';
import { openerFor, openFor, sealFor, type SealContext } from '../crypto/userkeys.js';
import type { Db } from '../types.js';

/**
 * The seal context of a `progress_events` row (C-3, M6 Step 6): bound to the table, owner and row, so a sealed round
 * copied to another row or another player's account fails to open.
 */
export const eventSealContext = (userId: string, rowId: string): SealContext => ({ table: 'progress_events', userId, rowId });

/**
 * Seals a stall round's whole body (everything but the id, kind and date columns: the stall and each answered
 * question id with its pick) with the player's data key, as margin notes are (S-U). `now` stamps a data key created
 * here.
 */
export function sealEventBody(db: Pick<Db, 'select' | 'insert'>, keyring: Keyring, userId: string, rowId: string, body: Record<string, unknown>, now: Date): Promise<Buffer> {
  return sealFor(db, keyring, eventSealContext(userId, rowId), body, now);
}

/** Opens a body sealed by `sealEventBody` under the same row; throws if it was moved, tampered with or shredded. */
export function openEventBody(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, rowId: string, sealed: Buffer): Promise<Record<string, unknown>> {
  return openFor<Record<string, unknown>>(db, keyring, eventSealContext(userId, rowId), sealed);
}

/** `openEventBody` for many rows of one player, loading their key once (a history may hold many sealed rounds). */
export async function eventBodyOpener(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<(rowId: string, sealed: Buffer) => Record<string, unknown>> {
  const open = await openerFor(db, keyring, userId);
  return (rowId, sealed) => open<Record<string, unknown>>(eventSealContext(userId, rowId), sealed);
}
