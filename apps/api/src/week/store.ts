import type { ListItem, MarketRunView, Plan } from '@kitchenquest/core';
import { and, asc, eq } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { openFor } from '../crypto/userkeys.js';
import { marketRuns, mealPlans } from '../db/schema.js';
import type { Db } from '../types.js';

/** Ruling 18: a plan and its market run are deleted this many weeks after the plan week ends (retention job, C-6). */
export const PLAN_RETENTION_WEEKS = 8;

/** A transaction (the same type as `consent/ledger.ts`'s). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Pick<Db, 'select'>;

/** The seal context of a plan row (C-3): bound to the table, owner and row. */
export const planSealContext = (userId: string, rowId: string) => ({ table: 'meal_plans', userId, rowId });
/** The seal context of a market-run row (C-3). */
export const runSealContext = (userId: string, rowId: string) => ({ table: 'market_runs', userId, rowId });

/** What `meal_plans.sealed` holds: core's `Plan` without `weekStart` (that is the plain `week_start` column). */
export type SealedPlan = Omit<Plan, 'weekStart'>;
/** What `market_runs.sealed` holds: the list rows with their ticks, and the pantry row each tick added, by row key. */
export interface SealedRun {
  items: ListItem[];
  pantryIds: Record<string, string>;
}

/** Exactly the stored fields of a plan, in core's shape (nothing else is ever sealed or returned). */
const planOf = (weekStart: string, s: SealedPlan): Plan => ({ weekStart, items: s.items, hard: s.hard, slot: s.slot });

/** The player's plan for `weekStart`, decrypted, with its row id; null when there is none. */
export async function loadPlan(db: Reader, keyring: Keyring, userId: string, weekStart: string): Promise<(Plan & { id: string }) | null> {
  const row = (
    await db
      .select({ id: mealPlans.id, sealed: mealPlans.sealed })
      .from(mealPlans)
      .where(and(eq(mealPlans.userId, userId), eq(mealPlans.weekStart, weekStart)))
  ).at(0);
  if (row === undefined) return null;
  const sealed = await openFor<SealedPlan>(db, keyring, planSealContext(userId, row.id), row.sealed);
  return { ...planOf(weekStart, sealed), id: row.id };
}

/** A stored run, decrypted, with its plan's week. */
export interface StoredRun extends SealedRun {
  id: string;
  planId: string;
  weekStart: string;
  doneAt: Date | null;
  createdAt: Date;
}

const runColumns = {
  id: marketRuns.id,
  planId: marketRuns.planId,
  sealed: marketRuns.sealed,
  doneAt: marketRuns.doneAt,
  createdAt: marketRuns.createdAt,
  weekStart: mealPlans.weekStart,
};

async function openRun(db: Reader, keyring: Keyring, userId: string, row: { id: string; planId: string; sealed: Buffer; doneAt: Date | null; createdAt: Date; weekStart: string }): Promise<StoredRun> {
  const { items, pantryIds } = await openFor<SealedRun>(db, keyring, runSealContext(userId, row.id), row.sealed);
  return { id: row.id, planId: row.planId, weekStart: row.weekStart, doneAt: row.doneAt, createdAt: row.createdAt, items, pantryIds };
}

/**
 * The player's run `where` selects (by plan or by run id), decrypted; null when there is none or it is not theirs.
 * With `forUpdate` the run row is locked until commit (a tick or finish reads, changes and reseals it).
 */
async function loadRunWhere(db: Reader, keyring: Keyring, userId: string, by: { planId: string } | { runId: string }, forUpdate: boolean): Promise<StoredRun | null> {
  const where = and(eq(marketRuns.userId, userId), 'planId' in by ? eq(marketRuns.planId, by.planId) : eq(marketRuns.id, by.runId));
  const q = db.select(runColumns).from(marketRuns).innerJoin(mealPlans, eq(mealPlans.id, marketRuns.planId)).where(where);
  const row = (forUpdate ? await q.for('update', { of: marketRuns }) : await q).at(0);
  return row === undefined ? null : openRun(db, keyring, userId, row);
}

export const loadRunForPlan = (db: Reader, keyring: Keyring, userId: string, planId: string, forUpdate = false) =>
  loadRunWhere(db, keyring, userId, { planId }, forUpdate);
export const loadRunById = (db: Reader, keyring: Keyring, userId: string, runId: string, forUpdate = false) =>
  loadRunWhere(db, keyring, userId, { runId }, forUpdate);

/** C40: a stored run as core's `MarketRunView` (the pantry ids stay server-side). */
export const viewOf = (run: Pick<StoredRun, 'id' | 'weekStart' | 'items' | 'doneAt'>): MarketRunView => ({
  id: run.id,
  weekStart: run.weekStart,
  items: run.items,
  doneAt: run.doneAt === null ? null : run.doneAt.toISOString(),
});

/** The export's plans (C-7, H-11): every stored plan, decrypted, oldest week first, with row ids and times. */
export async function loadPlansForExport(db: Reader, keyring: Keyring, userId: string) {
  const rows = await db
    .select({ id: mealPlans.id, weekStart: mealPlans.weekStart, sealed: mealPlans.sealed, createdAt: mealPlans.createdAt, updatedAt: mealPlans.updatedAt })
    .from(mealPlans)
    .where(eq(mealPlans.userId, userId))
    .orderBy(asc(mealPlans.weekStart));
  const out = [];
  for (const r of rows) {
    const sealed = await openFor<SealedPlan>(db, keyring, planSealContext(userId, r.id), r.sealed);
    out.push({ id: r.id, ...planOf(r.weekStart, sealed), createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() });
  }
  return out;
}

/** The export's market runs (C-7, H-11): every run, decrypted, with its rows, ticks and the pantry rows its ticks added. */
export async function loadRunsForExport(db: Reader, keyring: Keyring, userId: string) {
  const rows = await db
    .select(runColumns)
    .from(marketRuns)
    .innerJoin(mealPlans, eq(mealPlans.id, marketRuns.planId))
    .where(eq(marketRuns.userId, userId))
    .orderBy(asc(mealPlans.weekStart), asc(marketRuns.id));
  const out = [];
  for (const r of rows) {
    const run = await openRun(db, keyring, userId, r);
    out.push({ ...viewOf(run), planId: run.planId, pantryIds: run.pantryIds, createdAt: run.createdAt.toISOString() });
  }
  return out;
}
