import { randomUUID } from 'node:crypto';
import { COOKED_FOR_COUNTS, COOKED_FOR_WHO, isValidDate, shareTally, type CookedFor, type SharedEntry, type SharedTally } from '@kitchenquest/core';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { LoopContent } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor } from '../crypto/userkeys.js';
import { sharedTable } from '../db/schema.js';
import { ApiError } from '../errors.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';
import type { Db } from '../types.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import { BOOK_WRITE_ACTIONS } from './notes-service.js';

type Reader = Pick<Db, 'select'>;

export interface SharedDeps {
  keyring: Keyring;
  loop: Pick<LoopContent, 'frames'>;
  recipes: RecipeIndex;
}

/** What `shared_table.sealed` holds: the dish (canon slug or frame id) and who ate, as fixed values only (Ruling 10). */
interface SealedShared {
  recipe: string | null;
  frame: string | null;
  cookedFor: CookedFor;
}

/** The seal context of a Shared Table row (C-3). */
const sharedSealContext = (userId: string, rowId: string) => ({ table: 'shared_table', userId, rowId });

/** How far back a shared meal may be recorded (as a meal log, M4), and never ahead of the player's today. */
const SHARED_DAYS_BACK = 7;
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only shape a Shared Table entry may have (Ruling 10): a count from COOKED_FOR_COUNTS, one optional word from
 * COOKED_FOR_WHO, the date, and a canon slug or a frame id (checked against the content below). Strict at every level,
 * so no other key, and no string beyond the slugs, can ever be stored: no name, no free text.
 */
const Entry = z
  .object({
    cookedOn: z.string().max(10),
    recipe: z.string().max(200).nullable(),
    frame: z.string().max(200).nullable(),
    cookedFor: z.object({ count: z.enum(COOKED_FOR_COUNTS), who: z.enum(COOKED_FOR_WHO).nullable() }).strict(),
  })
  .strict();

/** 400 with problems that name only the field, never the value (a rejected value may be a name). */
const invalid = (problems: string[]) => new ApiError(400, 'bad_request', 'The entry is not valid', { problems });

/**
 * Records a meal the player shared (Cooked for Someone, audit M-9, Ruling 10), inside the caller's transaction. Order:
 * live user (401) → the daily write cap (429) → shape (400: only the fixed values; any other key or string is refused
 * and nothing is stored) → exactly one of a canon `recipe` that is not sacred (§10: no cooked-for on a sacred dish) or
 * a Pantry Frame id → `cookedOn` a real date within [today − 7, today], `today` the player's local date → seal →
 * insert → audit 'shared_table.create' (the row id only). Contract basis: no consent needed, not health data.
 * Never a requirement for, or an input to, trust, progress or a gate (M-9).
 */
export async function recordSharedIn(tx: Tx, deps: SharedDeps, userId: string, entry: SharedEntry, at: Date, requestId?: string, today: string = at.toISOString().slice(0, 10)): Promise<{ id: string }> {
  await lockLiveUser(tx, userId);
  await assertUnderWriteCap(tx, userId, BOOK_WRITE_ACTIONS, at);
  const parsed = Entry.safeParse(entry);
  if (!parsed.success) throw invalid([...new Set(parsed.error.issues.map((i) => `entry: ${i.path.map(String).join('.') || '(root)'} is not allowed`))]);
  const e = parsed.data;
  const problems: string[] = [];
  if ((e.recipe === null) === (e.frame === null)) problems.push('entry: exactly one of recipe and frame');
  if (e.recipe !== null) {
    const r = deps.recipes.get(e.recipe);
    if (r === undefined) problems.push('entry: unknown recipe');
    else if (r.meta.sacred) problems.push('entry: sacred recipes take no Shared Table entry');
  }
  if (e.frame !== null && !deps.loop.frames.some((f) => f.id === e.frame)) problems.push('entry: unknown frame');
  if (!isValidDate(e.cookedOn)) problems.push('entry: cookedOn must be a real date, YYYY-MM-DD');
  else if (e.cookedOn < addDays(today, -SHARED_DAYS_BACK) || e.cookedOn > today) problems.push(`entry: cookedOn must be within ${SHARED_DAYS_BACK} days before today`);
  if (problems.length > 0) throw invalid(problems);
  const id = randomUUID();
  const value: SealedShared = { recipe: e.recipe, frame: e.frame, cookedFor: { count: e.cookedFor.count, who: e.cookedFor.who } };
  await tx.insert(sharedTable).values({ id, userId, cookedOn: e.cookedOn, sealed: await sealFor(tx, deps.keyring, sharedSealContext(userId, id), value, at), createdAt: at });
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'shared_table.create', target: id, requestId }, at);
  return { id };
}

/** Every Shared Table row of the player, decrypted, oldest first. */
async function loadShared(db: Reader, keyring: Keyring, userId: string): Promise<(SharedEntry & { id: string; createdAt: Date })[]> {
  const rows = await db
    .select({ id: sharedTable.id, cookedOn: sharedTable.cookedOn, sealed: sharedTable.sealed, createdAt: sharedTable.createdAt })
    .from(sharedTable)
    .where(eq(sharedTable.userId, userId))
    .orderBy(asc(sharedTable.cookedOn), asc(sharedTable.createdAt), asc(sharedTable.id));
  const out = [];
  for (const r of rows) {
    const s = await openFor<SealedShared>(db, keyring, sharedSealContext(userId, r.id), r.sealed);
    out.push({ id: r.id, cookedOn: r.cookedOn, recipe: s.recipe, frame: s.frame, cookedFor: s.cookedFor, createdAt: r.createdAt });
  }
  return out;
}

/**
 * The player's Shared Table as counts only (C21): core `shareTally` over the opened rows, `{ shared, byRecipe }`.
 * Never a list of entries, dates or people, and nothing ranked or compared.
 */
export async function sharedTally(db: Reader, keyring: Keyring, userId: string): Promise<SharedTally> {
  return shareTally(await loadShared(db, keyring, userId));
}

/** The export's Shared Table (C-7, H-13): every row, decrypted, with its row id and time. */
export async function loadSharedForExport(db: Reader, keyring: Keyring, userId: string) {
  return (await loadShared(db, keyring, userId)).map(({ createdAt, ...e }) => ({ ...e, createdAt: createdAt.toISOString() }));
}

/**
 * Deletes one of the player's Shared Table rows: live user (401), then 404 when `id` is not theirs. Nothing earned is
 * touched (an entry never fed a reward). Audits 'shared_table.delete'.
 */
export async function deleteSharedIn(tx: Tx, userId: string, id: string, at: Date, requestId?: string): Promise<void> {
  await lockLiveUser(tx, userId);
  const notFound = () => new ApiError(404, 'not_found', 'Entry not found');
  if (!UUID.test(id)) throw notFound();
  const rowId = id.toLowerCase();
  const gone = await tx
    .delete(sharedTable)
    .where(and(eq(sharedTable.id, rowId), eq(sharedTable.userId, userId)))
    .returning({ id: sharedTable.id });
  if (gone.length === 0) throw notFound();
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'shared_table.delete', target: rowId, requestId }, at);
}
