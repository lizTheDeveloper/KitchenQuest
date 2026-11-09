import { and, asc, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { consents, CONSENT_PURPOSES } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { Db } from '../types.js';

/**
 * C-1 purposes: `health_data` (collect and store allergy, diet, journey,
 * symptom and meal data), `ai_health` (send health data to the AI), `voice`,
 * `pantry_location`, `research` (reserved, never granted by default).
 */
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type ConsentMethod = 'tap' | 'api';

export function isConsentPurpose(v: unknown): v is ConsentPurpose {
  return typeof v === 'string' && (CONSENT_PURPOSES as readonly string[]).includes(v);
}

const active = (userId: string, purpose: ConsentPurpose) =>
  and(eq(consents.userId, userId), eq(consents.purpose, purpose), isNull(consents.withdrawnAt));

/** A transaction handle, so callers can combine ledger changes with other writes. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Records consent under one notice version. A repeat grant of the same notice
 * is a no-op; a grant under a different notice ends the current one at `now`
 * (`ended_reason` 'superseded') and starts a new one, so the ledger shows which
 * text was in force when. Safe under concurrent grants: the partial unique
 * index admits one active row, a losing insert does nothing and the loop
 * re-reads. Writes a `consent.grant` audit event in the same transaction.
 */
export async function grantConsent(
  db: Db,
  userId: string,
  purpose: ConsentPurpose,
  noticeVersion: string,
  noticeSha256: Buffer,
  method: ConsentMethod,
  now: Date,
  requestId?: string,
): Promise<void> {
  if (!isConsentPurpose(purpose)) throw new Error(`unknown consent purpose: ${String(purpose)}`);
  if (noticeSha256.length !== 32) throw new Error('noticeSha256 must be 32 bytes');
  await db.transaction(async (tx) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      // Row-locks the active grant, if any, so a concurrent supersede waits.
      const [current] = await tx.select().from(consents).where(active(userId, purpose)).for('update');
      if (current && current.noticeVersion === noticeVersion && current.noticeSha256.equals(noticeSha256)) return;
      if (current) {
        await tx.update(consents).set({ withdrawnAt: now, endedReason: 'superseded' }).where(eq(consents.id, current.id));
      }
      const inserted = await tx
        .insert(consents)
        .values({ userId, purpose, noticeVersion, noticeSha256, grantedAt: now, method })
        .onConflictDoNothing()
        .returning({ id: consents.id });
      if (inserted.length > 0) {
        await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'consent.grant', target: purpose, requestId }, now);
        return;
      }
      // A concurrent grant committed an active row first: look again.
    }
    throw new Error('grantConsent: could not record the grant after concurrent updates');
  });
}

/** Ends the active grant for `purpose` at `now`, inside the caller's transaction. Returns whether one was active. */
export async function withdrawConsentIn(tx: Tx, userId: string, purpose: ConsentPurpose, now: Date, requestId?: string): Promise<boolean> {
  const ended = await tx
    .update(consents)
    .set({ withdrawnAt: now, endedReason: 'withdrawn' })
    .where(active(userId, purpose))
    .returning({ id: consents.id });
  if (ended.length === 0) return false;
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'consent.withdraw', target: purpose, requestId }, now);
  return true;
}

/** Ends the active grant for `purpose` at `now`, if any. Returns whether one was active. */
export async function withdrawConsent(
  db: Db,
  userId: string,
  purpose: ConsentPurpose,
  now: Date,
  requestId?: string,
): Promise<boolean> {
  return db.transaction((tx) => withdrawConsentIn(tx, userId, purpose, now, requestId));
}

/** Whether a grant for `purpose` was in force at `now` (granted at or before it, not yet withdrawn). */
export async function hasConsent(db: Pick<Db, 'select'>, userId: string, purpose: ConsentPurpose, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: consents.id })
    .from(consents)
    .where(
      and(
        eq(consents.userId, userId),
        eq(consents.purpose, purpose),
        lte(consents.grantedAt, now),
        or(isNull(consents.withdrawnAt), gt(consents.withdrawnAt, now)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Throws 403 `consent_required` unless `purpose` is granted. Health-data writes call this first. */
export async function requireConsent(db: Pick<Db, 'select'>, userId: string, purpose: ConsentPurpose, now: Date): Promise<void> {
  if (!(await hasConsent(db, userId, purpose, now))) {
    throw new ApiError(403, 'consent_required', `This needs your consent for ${purpose}`, { purpose });
  }
}

/**
 * For health writes, inside the write's transaction: share-locks the active
 * grant for `purpose` or throws 403 `consent_required`. A concurrent
 * withdrawal (an UPDATE of that row) then waits until the write commits, so a
 * withdraw-with-delete also removes what the write stored; a withdrawal that
 * committed first leaves no active row, and the write is refused.
 */
export async function lockConsentIn(tx: Tx, userId: string, purpose: ConsentPurpose, now: Date): Promise<void> {
  const [row] = await tx
    .select({ id: consents.id })
    .from(consents)
    .where(and(active(userId, purpose), lte(consents.grantedAt, now)))
    .for('share');
  if (!row) throw new ApiError(403, 'consent_required', `This needs your consent for ${purpose}`, { purpose });
}

export interface ConsentRecord {
  purpose: ConsentPurpose;
  noticeVersion: string;
  noticeSha256: string;
  method: ConsentMethod;
  grantedAt: string;
  withdrawnAt: string | null;
  endedReason: 'withdrawn' | 'superseded' | null;
}

/** The user's full consent history, oldest first (for GET /me/consents and export). */
export async function consentHistory(db: Pick<Db, 'select'>, userId: string): Promise<ConsentRecord[]> {
  const rows = await db.select().from(consents).where(eq(consents.userId, userId)).orderBy(asc(consents.grantedAt), asc(consents.id));
  return rows.map((r) => ({
    purpose: r.purpose as ConsentPurpose,
    noticeVersion: r.noticeVersion,
    noticeSha256: r.noticeSha256.toString('hex'),
    method: r.method as ConsentMethod,
    grantedAt: r.grantedAt.toISOString(),
    withdrawnAt: r.withdrawnAt ? r.withdrawnAt.toISOString() : null,
    endedReason: (r.endedReason ?? null) as ConsentRecord['endedReason'],
  }));
}
