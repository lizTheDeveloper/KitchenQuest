import { randomUUID } from 'node:crypto';
import {
  markOutOfStock,
  marketList,
  normalizeName,
  planWeekStart,
  STALL_IDS,
  stockSwaps,
  takeStockSwap,
  undoStock,
  type ListItem,
  type MarketRunView,
  type Plan,
} from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { consentHeldIn, lockConsentIn } from '../consent/ledger.js';
import { sealFor } from '../crypto/userkeys.js';
import { lockUserPlan } from '../db/advisory-locks.js';
import { marketRuns, profiles } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { changePantryIn, lockUserPantry } from '../pantry/service.js';
import { loadPantry } from '../pantry/store.js';
import { loadRules } from '../rules/store.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import { planContext, WEEK_WRITE_ACTIONS, type WeekDeps } from './plan-service.js';
import { loadPlan, loadRunById, loadRunForPlan, runSealContext, viewOf, type SealedRun, type StoredRun, type Tx } from './store.js';

const runNotFound = () => new ApiError(404, 'not_found', 'Market run not found');
const closed = () => new ApiError(409, 'run_closed', 'This market run is done');
/** 400 `stock_invalid` (M6 Step 6): never names the row, the item or the swap (C-9: messages reach logs). */
const stockInvalid = (why: string) => new ApiError(400, 'stock_invalid', why);

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** core `marketList`'s own order: stall (STALL_IDS order), then name, then key. */
const listOrder = (a: ListItem, b: ListItem): number =>
  STALL_IDS.indexOf(a.stall) - STALL_IDS.indexOf(b.stall) || byText(normalizeName(a.name), normalizeName(b.name)) || byText(a.key, b.key);

async function sealRun(tx: Tx, deps: WeekDeps, userId: string, runId: string, run: SealedRun, at: Date): Promise<Buffer> {
  return sealFor(tx, deps.keyring, runSealContext(userId, runId), { items: run.items, pantryIds: run.pantryIds } satisfies SealedRun, at);
}

/**
 * The run's rows now (C20, I1): the ticked rows of `existing` and its stall-swap (`stock:`) rows kept exactly, with
 * their pantry ids, and every other row from core `marketList` over the plan, pantry and rules as they are now (a ⛔
 * dish adds none; ❓ lines are flagged; each row's `amounts`, M6 Ruling 12). A fresh row the existing run had marked
 * out of stock keeps `outOfStock` (M6 Step 6, C23); a row the recompute drops (its dish now ⛔, or the pantry holds it)
 * goes with its flag, as any unticked row does, and its ticked `stock:` row stays.
 */
async function recompute(tx: Tx, deps: WeekDeps, userId: string, plan: Plan, existing: SealedRun | null): Promise<SealedRun> {
  const rules = await loadRules(tx, deps.keyring, userId);
  const pantry = await loadPantry(tx, deps.keyring, userId);
  const fresh = marketList(plan, planContext(deps, plan.weekStart, rules), pantry, deps.loop.stallOf);
  const kept = (existing?.items ?? []).filter((i) => i.ticked || i.stockSwap !== undefined);
  const keptKeys = new Set(kept.map((i) => i.key));
  const out = new Set((existing?.items ?? []).filter((i) => i.outOfStock === true).map((i) => i.key));
  const recomputed = fresh.filter((i) => !keptKeys.has(i.key)).map((i): ListItem => (out.has(i.key) ? { ...i, outOfStock: true, ticked: false } : i));
  const items = [...kept, ...recomputed].sort(listOrder);
  const pantryIds = Object.fromEntries(Object.entries(existing?.pantryIds ?? {}).filter(([k]) => keptKeys.has(k)));
  return { items, pantryIds };
}

/**
 * The audited actions a run write's daily cap counts: the week's, and (M6 Step 6) the stock route's own, since an
 * out-of-stock mark or its undo may change no pantry row.
 */
const RUN_WRITE_ACTIONS = [...WEEK_WRITE_ACTIONS, 'market_run.stock'] as const;

/** The run's write locks after the user row and any `pantry:`: `plan:` → the daily write cap → `health_data`. */
async function lockRun(tx: Tx, userId: string, at: Date): Promise<void> {
  await lockUserPlan(tx, userId);
  await assertUnderWriteCap(tx, userId, RUN_WRITE_ACTIONS, at);
  await lockConsentIn(tx, userId, 'health_data', at);
}

/**
 * Opens the market run for the player's plan of `weekStart` (Form 12-M, Ruling 16), inside the caller's transaction.
 * Live user → `plan:` → `health_data` (share-locked) → with it, the daily write cap → the plan (404 when the week has
 * none) → the run. Without `health_data` (M2: after a "keep" withdrawal) an existing run is read only: its rows are
 * computed now, as below, and nothing is written; with no run yet, creating one is a write (403 `consent_required`).
 * C20: one run per plan (unique `plan_id`). The first open creates it (audit 'market_run.create'); every open returns
 * that same run, with its unticked rows recomputed from the current plan, pantry and rules by core `marketList`, and
 * nothing else: a dish the rules now block drops its unticked rows, and a row the pantry now holds drops off. Ticked
 * rows, and the pantry rows their ticks added, are kept exactly as they are. A finished run is returned unchanged.
 */
export async function openRunIn(tx: Tx, deps: WeekDeps, userId: string, weekStart: string, at: Date, requestId?: string): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockUserPlan(tx, userId);
  const consented = await consentHeldIn(tx, userId, 'health_data', at);
  if (consented) await assertUnderWriteCap(tx, userId, RUN_WRITE_ACTIONS, at);
  const plan = await loadPlan(tx, deps.keyring, userId, weekStart);
  const existing = plan === null ? null : await loadRunForPlan(tx, deps.keyring, userId, plan.id, consented);
  // No consent and nothing to read: opening would be a write.
  if (!consented && existing === null) throw new ApiError(403, 'consent_required', 'This needs your consent for health_data', { purpose: 'health_data' });
  if (plan === null) throw new ApiError(404, 'not_found', 'There is no plan for that week');
  if (existing?.doneAt) return viewOf(existing);

  const { items, pantryIds } = await recompute(tx, deps, userId, plan, existing);
  if (!consented) return viewOf({ ...existing!, items });

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

/**
 * M6 Step 8: the player's OPEN market run for the plan week of `today` (their local date, Ruling 11), its rows computed
 * now as an open computes them (C20, I1: a dish the rules now block has dropped its unticked rows), read only: no lock
 * is taken and nothing is written (the profile is read, never created). Null when that week has no plan, the plan no
 * run, or the run is done. The Pan's check-off matches the player's words against these rows; a tick re-reads the run
 * under its locks (`tickIn`).
 */
export async function openRunViewIn(tx: Tx, deps: WeekDeps, userId: string, today: string): Promise<MarketRunView | null> {
  const row = (await tx.select({ marketDays: profiles.marketDays }).from(profiles).where(eq(profiles.userId, userId))).at(0);
  const plan = await loadPlan(tx, deps.keyring, userId, planWeekStart(today, row?.marketDays ?? []));
  if (plan === null) return null;
  const run = await loadRunForPlan(tx, deps.keyring, userId, plan.id);
  if (run === null || run.doneAt !== null) return null;
  const { items } = await recompute(tx, deps, userId, plan, run);
  return viewOf({ ...run, items });
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
 * (404 when not theirs) → 409 `run_closed` after `done_at` → the run's rows recomputed now, as an open does (I1: so a
 * row of a dish the rules now block is gone and can never be ticked into the pantry, and the response shows the list
 * as the rules stand) → 404 for a key no longer in the run. Ticking adds `{ name, ingredientId, addedOn: today,
 * source: 'market' }` (`today` the player's local date, I2) to the pantry (Ruling 16) and
 * remembers that row's id; unticking removes exactly that row by id, never an item of the same name (the M4 undo
 * rule). Ticking a ticked row, or unticking an unticked one, changes no tick or pantry row. The pantry change audits itself
 * ('pantry.change'); its 400 `too_many_items` leaves the run as it was. M6: a row marked out of stock can't be ticked,
 * and a stall swap's row can't be unticked, here (400 `stock_invalid`): both are undone with the stock route's `undo`.
 */
export async function tickIn(
  tx: Tx,
  deps: WeekDeps,
  userId: string,
  runId: string,
  key: string,
  ticked: boolean,
  at: Date,
  requestId?: string,
  today: string = at.toISOString().slice(0, 10),
): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockUserPantry(tx, userId);
  await lockRun(tx, userId, at);
  const stored = await openForChange(tx, deps, userId, runId);
  if (stored.doneAt !== null) throw closed();
  const plan = await loadPlan(tx, deps.keyring, userId, stored.weekStart);
  if (plan === null) throw runNotFound();
  const run = { ...stored, ...(await recompute(tx, deps, userId, plan, stored)) };
  const index = run.items.findIndex((i) => i.key === key);
  if (index < 0) throw new ApiError(404, 'not_found', 'That item is not on this list');
  const row = run.items[index];
  if (ticked && row.outOfStock === true) throw stockInvalid('That item is marked out of stock: undo that first');
  if (!ticked && row.stockSwap !== undefined) throw stockInvalid('That is a stall swap: undo the swap instead');
  const pantryIds = { ...run.pantryIds };
  if (ticked && !row.ticked) {
    const add = [{ name: row.name, ingredientId: row.ingredientId, addedOn: today, source: 'market' as const }];
    const { addedIds } = await changePantryIn(tx, deps, userId, { add, removeNames: [], removeIds: [] }, at, requestId);
    pantryIds[key] = addedIds[0];
  } else if (!ticked && row.ticked) {
    // A row the player already used up (removed) is simply gone: nothing else is ever removed.
    if (Object.hasOwn(pantryIds, key)) await changePantryIn(tx, deps, userId, { add: [], removeNames: [], removeIds: [pantryIds[key]] }, at, requestId);
    delete pantryIds[key];
  }
  // The recompute is stored either way, so the next read matches this response.
  const items = run.items.map((i, n) => (n === index ? { ...i, ticked } : i));
  const sealed = await sealRun(tx, deps, userId, run.id, { items, pantryIds }, at);
  await tx.update(marketRuns).set({ sealed }).where(and(eq(marketRuns.id, run.id), eq(marketRuns.userId, userId)));
  return viewOf({ ...run, items });
}

/** The stock route's body (M6 Step 6, Ruling 11): mark a row out, take a swap core offers for it now, or undo both. */
export type StockAction = { key: string; action: 'out' | 'take'; toId?: string } | { key: string; action: 'undo' };

/** The core stock functions' RangeError (a row they refuse) as 400 `stock_invalid`; anything else is rethrown. */
function stockStep<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof RangeError) throw stockInvalid('That stall change is not possible on this list');
    throw e;
  }
}

/**
 * A stall swap or out-of-stock mark on one row of the player's run (M6 Ruling 11, §7.0 "None (undoable)": no
 * `confirmed`; `undo` is the undo). Live user → `pantry:` → `plan:` → the daily write cap → `health_data` (403) → the
 * run row (404 when not theirs) → 409 `run_closed` after `done_at` → the rows recomputed now, as a tick does (C20) →
 * - `out`: core `markOutOfStock` (a ticked row is unticked first, its pantry row removed by id, the M5 rule);
 * - `take`: `toId` must be one of core `stockSwaps(row, plan, ctx)` computed NOW with the player's rules (the
 *   client's offer is never trusted: a swap a rule added since makes unsafe is gone), else 400 `stock_invalid`; then
 *   `takeStockSwap` (a ticked row is unticked first, as for `out`), and the added row is ticked into the pantry
 *   `{ name, ingredientId, addedOn: today, source: 'market' }`, its id remembered;
 * - `undo`: core `undoStock`; the swap row's pantry row is removed by id, never by name.
 * Any row core refuses (not on the run, a swap's own row, a second swap, the run at MAX_STOCK_SWAPS_PER_RUN) → 400
 * `stock_invalid`, nothing changed. Audits 'market_run.stock' with the run's stall-swap count only (content-free).
 */
export async function stockIn(tx: Tx, deps: WeekDeps, userId: string, runId: string, body: StockAction, at: Date, today: string, requestId?: string): Promise<MarketRunView> {
  await lockLiveUser(tx, userId);
  await lockUserPantry(tx, userId);
  await lockRun(tx, userId, at);
  const stored = await openForChange(tx, deps, userId, runId);
  if (stored.doneAt !== null) throw closed();
  const plan = await loadPlan(tx, deps.keyring, userId, stored.weekStart);
  if (plan === null) throw runNotFound();
  const run = { ...stored, ...(await recompute(tx, deps, userId, plan, stored)) };
  const view = viewOf(run);
  const pantryIds = { ...run.pantryIds };
  const removeIds: string[] = [];
  const dropTick = (key: string) => {
    if (Object.hasOwn(pantryIds, key)) removeIds.push(pantryIds[key]);
    delete pantryIds[key];
  };
  let next: MarketRunView;
  let added: ListItem | null = null;
  if (body.action === 'out') {
    next = stockStep(() => markOutOfStock(view, body.key));
    dropTick(body.key);
  } else if (body.action === 'take') {
    const row = view.items.find((i) => i.key === body.key);
    if (row === undefined || body.toId === undefined) throw stockInvalid('That stall swap is not on offer');
    const rules = await loadRules(tx, deps.keyring, userId);
    const offer = stockSwaps(row, plan, planContext(deps, plan.weekStart, rules)).find((sw) => sw.toId === body.toId);
    if (offer === undefined) throw stockInvalid('That stall swap is not on offer');
    ({ run: next, added } = stockStep(() => takeStockSwap(view, body.key, offer)));
    dropTick(body.key);
  } else {
    const undone = stockStep(() => undoStock(view, body.key));
    next = undone.run;
    if (undone.removedKey !== null) dropTick(undone.removedKey);
  }
  const add = added === null ? [] : [{ name: added.name, ingredientId: added.ingredientId, addedOn: today, source: 'market' as const }];
  if (add.length > 0 || removeIds.length > 0) {
    const { addedIds } = await changePantryIn(tx, deps, userId, { add, removeNames: [], removeIds }, at, requestId);
    if (added !== null) pantryIds[added.key] = addedIds[0];
  }
  const items = [...next.items].sort(listOrder);
  const sealed = await sealRun(tx, deps, userId, run.id, { items, pantryIds }, at);
  await tx.update(marketRuns).set({ sealed }).where(and(eq(marketRuns.id, run.id), eq(marketRuns.userId, userId)));
  const swaps = items.filter((i) => i.stockSwap !== undefined).length;
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'market_run.stock', target: `stock_rows:${swaps}`, requestId }, at);
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
