import { and, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { entitlements } from '../db/schema.js';
import type { Db } from '../types.js';

export const ENTITLEMENT_KINDS = [
  'guild',
  'household_member',
  'bursary',
  'founding',
  'seat_licence',
  'accessibility_voice',
] as const;
export type EntitlementKind = (typeof ENTITLEMENT_KINDS)[number];

export const ENTITLEMENT_SOURCES = ['stripe', 'manual', 'school', 'org'] as const;
export type EntitlementSource = (typeof ENTITLEMENT_SOURCES)[number];

/** Kinds active at `now`: starts_at inclusive, ends_at exclusive, each kind once, sorted. */
export async function activeEntitlements(db: Db, userId: string, now: Date): Promise<EntitlementKind[]> {
  const rows = await db
    .selectDistinct({ kind: entitlements.kind })
    .from(entitlements)
    .where(
      and(
        eq(entitlements.userId, userId),
        lte(entitlements.startsAt, now),
        or(isNull(entitlements.endsAt), gt(entitlements.endsAt, now)),
      ),
    )
    .orderBy(entitlements.kind);
  return rows.map((r) => r.kind as EntitlementKind);
}

export async function grant(
  db: Pick<Db, 'insert'>,
  userId: string,
  kind: EntitlementKind,
  source: EntitlementSource,
  startsAt: Date,
  endsAt?: Date,
): Promise<void> {
  if (!ENTITLEMENT_KINDS.includes(kind)) throw new Error(`unknown entitlement kind: ${kind}`);
  if (!ENTITLEMENT_SOURCES.includes(source)) throw new Error(`unknown entitlement source: ${source}`);
  if (endsAt && endsAt <= startsAt) throw new Error('endsAt must be after startsAt');
  await db.insert(entitlements).values({ userId, kind, source, startsAt, endsAt: endsAt ?? null });
}
