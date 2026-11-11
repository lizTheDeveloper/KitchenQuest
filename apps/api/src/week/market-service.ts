import { randomUUID } from 'node:crypto';
import { marketList, normalizeName, STALL_IDS, type ListItem, type MarketRunView } from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { lockConsentIn } from '../consent/ledger.js';
import { sealFor } from '../crypto/userkeys.js';
import { lockUserPlan } from '../db/advisory-locks.js';
import { marketRuns } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { changePantryIn, lockUserPantry } from '../pantry/service.js';
import { loadPantry } from '../pantry/store.js';
import { loadRules } from '../rules/store.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import { planContext, WEEK_WRITE_ACTIONS, type WeekDeps } from './plan-service.js';
import { loadPlan, loadRunById, loadRunForPlan, runSealContext, viewOf, type SealedRun, type StoredRun, type Tx } from './store.js';

const runNotFound = () => new ApiError(404, 'not_found', 'Market run not found');
const closed = () => new ApiError(409, 'run_closed', 'This market run is done');

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** core `marketList`'s own order: stall (STALL_IDS order), then name, then key. */
const listOrder = (a: ListItem, b: ListItem): number =>
  STALL_IDS.indexOf(a.stall) - STALL_IDS.indexOf(b.stall) || byText(normalizeName(a.name), normalizeName(b.name)) || byText(a.key, b.key);

async function sealRun(tx: Tx, deps: WeekDeps, userId: string, runId: string, run: SealedRun, at: Date): Promise<Buffer> {
  return sealFor(tx, deps.keyring, runSealContext(userId, runId), { items: run.items, pantryIds: run.pantryIds } satisfies SealedRun, at);
}

/** The run's write locks after the user row and any `pantry:`: `plan:` → the daily write cap → `health_data`. */
async function lockRun(tx: Tx, userId: string, at: Date): Promise<void> {
  await lockUserPlan(tx, userId);
  await assertUnderWriteCap(tx, userId, WEEK_WRITE_ACTIONS, at);
  await lockConsentIn(tx, userId, 'health_data', at);
}

/**
 * Opens the market run for the player's plan of `weekStart` (Form 12-M, Ruling 16), inside the caller's transaction.
 * Live user → `plan:` → the daily write cap → `health_data` (403) → the plan (404 when the week has none) → the run.
 * C20: one run per plan (unique `plan_id`). The first open creates it (audit 'market_run.create'); every open returns
 * that same run, with its unticked rows recomputed from the current plan, pantry and rules by core `marketList`, and
 * nothing else: a dish the rules now block drops its unticked rows, and a row the pantry now holds drops off. Ticked
 * rows, and the pantry rows their ticks added, are kept exactly as they are. A finished run is returned unchanged.
 */
export async function openRunIn(tx: Tx, deps: WeekDeps, userId: string, weekStart: string, at: Date, requestId?: string): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockRun(tx, userId, at);
  const plan = await loadPlan(tx, deps.keyring, userId, weekStart);
  if (plan === null) throw new ApiError(404, 'not_found', 'There is no plan for that week');
  const existing = await loadRunForPlan(tx, deps.keyring, userId, plan.id, true);
  if (existing?.doneAt) return viewOf(existing);

  const rules = await loadRules(tx, deps.keyring, userId);
  const pantry = await loadPantry(tx, deps.keyring, userId);
  const fresh = marketList(plan, planContext(deps, weekStart, rules), pantry, deps.loop.stallOf);
  const ticked = (existing?.items ?? []).filter((i) => i.ticked);
  const tickedKeys = new Set(ticked.map((i) => i.key));
  const items = [...ticked, ...fresh.filter((i) => !tickedKeys.has(i.key))].sort(listOrder);
  const pantryIds = Object.fromEntries(Object.entries(existing?.pantryIds ?? {}).filter(([k]) => tickedKeys.has(k)));

  if (existing === null) {
    const id = randomUUID();
    const sealed = await sealRun(tx, deps, userId, id, { items, pantryIds }, at);
    await tx.insert(marketRuns).values({ id, userId, planId: plan.id, sealed, createdAt: at });
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'market_run.create', requestId }, at);
    return viewOf({ id, weekStart, items, doneAt: null });
  }
  const sealed = await sealRun(tx, deps, userId, existing.id, { items, pantryIds }, at);
  await tx.update(marketRuns).set({ sealed }).where(and(eq(marketRuns.id, existing.id), eq(marketRuns.userId, userId)));
  return viewOf({ ...existing, items });
}

/** The player's run by id, row-locked; 404 when it is not theirs; 409 `run_closed` once it is done. */
async function openForChange(tx: Tx, deps: WeekDeps, userId: string, runId: string): Promise<StoredRun> {
  const run = await loadRunById(tx, deps.keyring, userId, runId, true);
  if (run === null) throw runNotFound();
  return run;
}

/**
 * Ticks or unticks one row of the player's run (§7.0 "None (undoable)": no `confirmed`; unticking is the undo).
 * Live user → `pantry:` (a tick writes the pantry) → `plan:` → the daily write cap → `health_data` → the run row
 * (404 when not theirs) → 409 `run_closed` after `done_at` → 404 for a key no longer in the run (a recompute dropped
 * it). Ticking adds `{ name, ingredientId, addedOn: today, source: 'market' }` to the pantry (Ruling 16) and
 * remembers that row's id; unticking removes exactly that row by id, never an item of the same name (the M4 undo
 * rule). Ticking a ticked row, or unticking an unticked one, changes nothing. The pantry change audits itself
 * ('pantry.change'); its 400 `too_many_items` leaves the run as it was.
 */
export async function tickIn(tx: Tx, deps: WeekDeps, userId: string, runId: string, key: string, ticked: boolean, at: Date, requestId?: string): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockUserPantry(tx, userId);
  await lockRun(tx, userId, at);
  const run = await openForChange(tx, deps, userId, runId);
  if (run.doneAt !== null) throw closed();
  const index = run.items.findIndex((i) => i.key === key);
  if (index < 0) throw new ApiError(404, 'not_found', 'That item is not on this list');
  const row = run.items[index];
  if (row.ticked === ticked) return viewOf(run);

  const pantryIds = { ...run.pantryIds };
  if (ticked) {
    const today = at.toISOString().slice(0, 10);
    const add = [{ name: row.name, ingredientId: row.ingredientId, addedOn: today, source: 'market' as const }];
    const { addedIds } = await changePantryIn(tx, deps, userId, { add, removeNames: [], removeIds: [] }, at, requestId);
    pantryIds[key] = addedIds[0];
  } else {
    const id = pantryIds[key];
    // A row the player already used up (removed) is simply gone: nothing else is ever removed.
    if (id !== undefined) await changePantryIn(tx, deps, userId, { add: [], removeNames: [], removeIds: [id] }, at, requestId);
    delete pantryIds[key];
  }
  const items = run.items.map((i, n) => (n === index ? { ...i, ticked } : i));
  const sealed = await sealRun(tx, deps, userId, run.id, { items, pantryIds }, at);
  await tx.update(marketRuns).set({ sealed }).where(and(eq(marketRuns.id, run.id), eq(marketRuns.userId, userId)));
  return viewOf({ ...run, items });
}

/**
 * "That's the shop done" (Ruling 16): sets `done_at` once, inside the caller's transaction. Live user → `plan:` →
 * the daily write cap → `health_data` → the run row (404). A second finish returns the run unchanged, the first
 * `done_at` kept. Audits 'market_run.finish' the first time. The client then posts the `market_run` progress event.
 */
export async function finishRunIn(tx: Tx, deps: WeekDeps, userId: string, runId: string, at: Date, requestId?: string): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockRun(tx, userId, at);
  const run = await openForChange(tx, deps, userId, runId);
  if (run.doneAt !== null) return viewOf(run);
  await tx.update(marketRuns).set({ doneAt: at }).where(and(eq(marketRuns.id, run.id), eq(marketRuns.userId, userId)));
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'market_run.finish', requestId }, at);
  return viewOf({ ...run, doneAt: at });
}
