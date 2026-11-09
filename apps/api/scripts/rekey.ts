// Admin script (C-2): re-wraps every user data key to the active ring key.
// Usage: DATA_KEYS=old:...,new:... DATA_KEY_ID=new npm run rekey -w @kitchenquest/api
// Idempotent and batched; safe to re-run. Remove the old key from DATA_KEYS only
// after it reports "0 remaining". See docs/compliance/key-management.md.
import { userInfo } from 'node:os';
import { audit } from '../src/audit/audit.js';
import { loadConfig } from '../src/config.js';
import { rewrapUserKeys } from '../src/crypto/userkeys.js';
import { createDb } from '../src/db/client.js';
import { loggableError } from '../src/errors.js';

const config = loadConfig(process.env);
const batchSize = Number(process.env.REKEY_BATCH_SIZE ?? 500);
if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('REKEY_BATCH_SIZE must be a positive integer');

const { db, sql } = createDb(config.databaseUrl, { max: 1 });
const started = new Date();
let result: { rewrapped: number; remaining: number } | undefined;
let primary: unknown;
try {
  result = await rewrapUserKeys(db, config.keyring, { batchSize });
  console.log(`rekey to ${config.keyring.activeId}: user_keys: ${result.rewrapped} re-wrapped, ${result.remaining} remaining`);
  if (result.remaining > 0) process.exitCode = 1;
} catch (err) {
  primary = err;
}
// C-5: every run is audited, failed ones included, with its outcome and counts (no key material).
const outcome = result === undefined ? 'failed' : result.remaining > 0 ? 'incomplete' : 'ok';
const counts = result === undefined ? '' : ` rewrapped=${result.rewrapped} remaining=${result.remaining}`;
try {
  await audit(
    db,
    { actorKind: 'script', actorId: `rekey:${userInfo().username}`, action: 'keys.rekey', target: `active=${config.keyring.activeId} outcome=${outcome}${counts}` },
    started,
  );
} catch (auditErr) {
  // Never let a failed audit write hide why the rekey itself failed.
  if (primary === undefined) primary = auditErr;
  else console.error('rekey: the keys.rekey audit event could not be written either:', loggableError(auditErr));
} finally {
  await sql.end({ timeout: 5 });
}
if (primary !== undefined) throw primary;
