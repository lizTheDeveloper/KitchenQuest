import type { Keyring } from '../crypto/keyring.js';
import { openerFor, openFor, sealerFor, type SealContext } from '../crypto/userkeys.js';
import type { Db } from '../types.js';

/**
 * The seal context of a `progress_events` row (C-3, M6 Step 6): bound to the table, owner and row, so a sealed round
 * copied to another row or another player's account fails to open.
 */
const eventSealContext = (userId: string, rowId: string): SealContext => ({ table: 'progress_events', userId, rowId });

/**
 * Seals stall rounds' whole bodies (everything but the id, kind and date columns: the stall and each answered question
 * id with its pick) with the player's data key, as margin notes are (S-U), each bound to its own row. The key is loaded
 * (or created, stamped `now`) once per post, not once per event (Task 6 review M4).
 */
export async function eventBodySealer(db: Pick<Db, 'select' | 'insert'>, keyring: Keyring, userId: string, now: Date): Promise<(rowId: string, body: Record<string, unknown>) => Buffer> {
  const seal = await sealerFor(db, keyring, userId, now);
  return (rowId, body) => seal(eventSealContext(userId, rowId), padded(body));
}

/**
 * M7 Step 7 (M6 final M13): the sealed JSON is padded to a whole number of SEALED_BUCKET_BYTES (one bucket fits every
 * round, MAX_ROUND_ANSWERS = 10), so a blob's length never tells a Protein Counter round (longer `bram-pc-*` ids) from a
 * base one in a database dump. The pad is a `_pad` string of spaces, dropped again on open.
 */
const SEALED_BUCKET_BYTES = 1024;
const PAD = '_pad';

function padded(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.hasOwn(body, PAD)) throw new Error('progress seal: a body may not carry _pad');
  const bare = Buffer.byteLength(JSON.stringify({ ...body, [PAD]: '' }), 'utf8');
  const target = Math.ceil(bare / SEALED_BUCKET_BYTES) * SEALED_BUCKET_BYTES;
  return { ...body, [PAD]: ' '.repeat(target - bare) };
}

/** The body as sealed, without its pad (a round sealed before M7 has none). */
function unpadded(body: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(body, PAD)) return body;
  const { [PAD]: _pad, ...rest } = body;
  return rest;
}

/** Opens a body sealed by `eventBodySealer` under the same row; throws if it was moved, tampered with or shredded. */
export async function openEventBody(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, rowId: string, sealed: Buffer): Promise<Record<string, unknown>> {
  return unpadded(await openFor<Record<string, unknown>>(db, keyring, eventSealContext(userId, rowId), sealed));
}

/** `openEventBody` for many rows of one player, loading their key once (a history may hold many sealed rounds). */
export async function eventBodyOpener(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<(rowId: string, sealed: Buffer) => Record<string, unknown>> {
  const open = await openerFor(db, keyring, userId);
  return (rowId, sealed) => unpadded(open<Record<string, unknown>>(eventSealContext(userId, rowId), sealed));
}
