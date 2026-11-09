import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { auditEvents } from '../db/schema.js';
import type { Db } from '../types.js';

export type AuditActorKind = 'user' | 'system' | 'operator' | 'script';

/**
 * One content-free audit event (C-5). `action` is a dotted verb such as
 * `auth.sign_in`; `target` names a kind of thing (a table, a purpose, an
 * entitlement kind, a key id), never health content, an email or a token.
 */
export interface AuditEvent {
  actorKind: AuditActorKind;
  actorId?: string;
  subjectUserId?: string;
  action: string;
  target?: string;
  requestId?: string;
}

type Writer = Pick<Db, 'insert'>;
type Executor = Pick<Db, 'execute'>;

/** Appends an event. Pass the transaction when the audited change runs in one, so both commit together. */
export async function audit(db: Writer, e: AuditEvent, now: Date): Promise<void> {
  await db.insert(auditEvents).values({
    at: now,
    actorKind: e.actorKind,
    actorId: e.actorId ?? null,
    subjectUserId: e.subjectUserId ?? null,
    action: e.action,
    target: e.target ?? null,
    requestId: e.requestId ?? null,
  });
}

/**
 * The stable stand-in for a deleted user's id: `p:` + HMAC-SHA256 under a key
 * derived from the active ring key, so the database alone cannot link it back
 * to the id.
 */
export function pseudonymFor(keyring: Keyring, userId: string): string {
  return `p:${createHmac('sha256', keyring.derive('audit-pseudonym')).update(userId, 'utf8').digest('hex')}`;
}

/**
 * Replaces `userId` with its pseudonym wherever it is the subject or actor
 * (account delete, C-5/C-8). Runs through `audit_pseudonymize()`, the only
 * update the append-only trigger lets through. Returns the rows changed.
 */
export async function pseudonymizeAudit(db: Executor, keyring: Keyring, userId: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select audit_pseudonymize(${userId}::uuid, ${pseudonymFor(keyring, userId)}) as n`,
  );
  return Number(rows[0]!.n);
}

/**
 * Deletes events older than `cutoff` through `audit_purge_before()`, which
 * clamps the cutoff to the database's now() - 24 months (C-5 retention).
 */
export async function purgeAuditBefore(db: Executor, cutoff: Date): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select audit_purge_before(${cutoff.toISOString()}::timestamptz) as n`);
  return Number(rows[0]!.n);
}
