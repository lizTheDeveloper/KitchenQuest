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

/**
 * Records consent under one notice version. A repeat grant of the same notice
 * is a no-op; a grant under a different notice ends the current one at `now`
 * and starts a new one, so the ledger shows which text was in force when.
 * Writes a `consent.grant` audit event in the same transaction.
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
    // Row-locks the active grant so two concurrent grants serialize.
    const [current] = await tx.select().from(consents).where(active(userId, purpose)).for('update');
    if (current && current.noticeVersion === noticeVersion && current.noticeSha256.equals(noticeSha256)) return;
    if (current) await tx.update(consents).set({ withdrawnAt: now }).where(eq(consents.id, current.id));
    await tx.insert(consents).values({ userId, purpose, noticeVersion, noticeSha256, grantedAt: now, method });
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'consent.grant', target: purpose, requestId }, now);
  });
}

/** Ends the active grant for `purpose` at `now`, if any. Returns whether one was active. */
export async function withdrawConsent(
  db: Db,
  userId: string,
  purpose: ConsentPurpose,
  now: Date,
  requestId?: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const ended = await tx.update(consents).set({ withdrawnAt: now }).where(active(userId, purpose)).returning({ id: consents.id });
    if (ended.length === 0) return false;
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'consent.withdraw', target: purpose, requestId }, now);
    return true;
  });
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

export interface ConsentRecord {
  purpose: ConsentPurpose;
  noticeVersion: string;
  noticeSha256: string;
  method: ConsentMethod;
  grantedAt: string;
  withdrawnAt: string | null;
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
  }));
}
