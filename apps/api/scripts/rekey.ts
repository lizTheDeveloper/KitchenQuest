// Admin script (C-2): re-wraps every user data key to the active ring key.
// Usage: DATA_KEYS=old:...,new:... DATA_KEY_ID=new npm run rekey -w @kitchenquest/api
// Idempotent and batched; safe to re-run. Remove the old key from DATA_KEYS only
// after it reports "0 remaining". See docs/compliance/key-management.md.
import { userInfo } from 'node:os';
import { audit } from '../src/audit/audit.js';
import { loadConfig } from '../src/config.js';
import { rewrapUserKeys } from '../src/crypto/userkeys.js';
import { createDb } from '../src/db/client.js';

const config = loadConfig(process.env);
const batchSize = Number(process.env.REKEY_BATCH_SIZE ?? 500);
if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('REKEY_BATCH_SIZE must be a positive integer');

const { db, sql } = createDb(config.databaseUrl, { max: 1 });
try {
  const started = new Date();
  const { rewrapped, remaining } = await rewrapUserKeys(db, config.keyring, { batchSize });
  await audit(db, { actorKind: 'script', actorId: `rekey:${userInfo().username}`, action: 'keys.rekey', target: config.keyring.activeId }, started);
  console.log(`rekey to ${config.keyring.activeId}: user_keys: ${rewrapped} re-wrapped, ${remaining} remaining`);
  if (remaining > 0) process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
