import type { Keyring } from '../crypto/keyring.js';
import { openerFor, openFor, sealerFor, type SealContext } from '../crypto/userkeys.js';
import type { Db } from '../types.js';

/**
 * The seal context of a `progress_events` row (C-3, M6 Step 6): bound to the table, owner and row, so a sealed round
 * copied to another row or another player's account fails to open.
 */
export const eventSealContext = (userId: string, rowId: string): SealContext => ({ table: 'progress_events', userId, rowId });

/**
 * Seals stall rounds' whole bodies (everything but the id, kind and date columns: the stall and each answered question
 * id with its pick) with the player's data key, as margin notes are (S-U), each bound to its own row. The key is loaded
 * (or created, stamped `now`) once per post, not once per event (Task 6 review M4).
 */
export async function eventBodySealer(db: Pick<Db, 'select' | 'insert'>, keyring: Keyring, userId: string, now: Date): Promise<(rowId: string, body: Record<string, unknown>) => Buffer> {
  const seal = await sealerFor(db, keyring, userId, now);
  return (rowId, body) => seal(eventSealContext(userId, rowId), body);
}

/** Opens a body sealed by `eventBodySealer` under the same row; throws if it was moved, tampered with or shredded. */
export function openEventBody(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, rowId: string, sealed: Buffer): Promise<Record<string, unknown>> {
  return openFor<Record<string, unknown>>(db, keyring, eventSealContext(userId, rowId), sealed);
}

/** `openEventBody` for many rows of one player, loading their key once (a history may hold many sealed rounds). */
export async function eventBodyOpener(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<(rowId: string, sealed: Buffer) => Record<string, unknown>> {
  const open = await openerFor(db, keyring, userId);
  return (rowId, sealed) => open<Record<string, unknown>>(eventSealContext(userId, rowId), sealed);
}
