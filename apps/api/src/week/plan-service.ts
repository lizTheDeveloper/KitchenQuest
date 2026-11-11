import { randomUUID } from 'node:crypto';
import { checkPlan, planWeekStart, validatePlan, type Plan, type PlanContext, type PlanItemCheck, type Rule } from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog, LoopContent } from '../catalog.js';
import { lockConsentIn } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { sealFor } from '../crypto/userkeys.js';
import { lockUserPlan } from '../db/advisory-locks.js';
import { mealPlans } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { loadProfile } from '../profile/routes.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';
import { loadRules } from '../rules/store.js';
import { assertUnderWriteCap } from '../usage/write-cap.js';
import { loadPlan, planSealContext, type SealedPlan, type Tx } from './store.js';

export interface WeekDeps {
  keyring: Keyring;
  catalog: Catalog;
  loop: LoopContent;
  recipes: RecipeIndex;
}

/**
 * The audited actions the week's daily write cap counts (the M4 cap, the same for every player and plan, abuse
 * only). A tick audits as the pantry change it makes, so `pantry.change` is counted with them.
 */
export const WEEK_WRITE_ACTIONS = ['plan.save', 'plan.restore', 'plan.delete', 'market_run.create', 'market_run.finish', 'pantry.change'] as const;

/** I3 (fix round 1): a plan may be saved for the current plan week − 1 to + 4, never a far past or future week. */
const PLAN_WEEKS_BACK = 1;
const PLAN_WEEKS_AHEAD = 4;
const DAY_MS = 86_400_000;
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const utcToday = (at: Date): string => at.toISOString().slice(0, 10);

const invalid = (problems: string[]) => new ApiError(400, 'plan_invalid', 'The plan is not valid', { problems });

/** The rules engine's view of the week: the player's rules now, the catalog's graph and swaps, the canon. */
export function planContext(deps: Pick<WeekDeps, 'catalog' | 'loop' | 'recipes'>, weekStart: string, rules: Rule[]): PlanContext {
  return {
    weekStart,
    recipes: deps.recipes,
    rules,
    graph: deps.catalog.graph,
    subs: [...deps.catalog.substitutions],
    existing: [],
    foodGroups: deps.loop.foodGroups,
  };
}

/** Every item of `plan` checked now, on its own date, with the player's current rules (a plan never stores a status). */
export async function checksFor(tx: Pick<Tx, 'select'>, deps: WeekDeps, userId: string, plan: Plan): Promise<PlanItemCheck[]> {
  const rules = await loadRules(tx, deps.keyring, userId);
  return checkPlan(plan, planContext(deps, plan.weekStart, rules));
}

/** The plan exactly as stored and returned: core's fields, nothing else (`validatePlan` refuses any other key). */
const canonical = (p: Plan): Plan => ({
  weekStart: p.weekStart,
  items: p.items.map((i) => (i.kind === 'dish' ? { day: i.day, kind: 'dish', slug: i.slug, servings: i.servings } : { day: i.day, kind: 'lesson', slug: i.slug })),
  hard: p.hard,
  slot: p.slot,
});

/** Seals and upserts `plan` for its week (one row per week; the row id, and so its seal context, is kept). */
async function writePlan(tx: Tx, deps: WeekDeps, userId: string, plan: Plan, existingId: string | null, at: Date): Promise<string> {
  const id = existingId ?? randomUUID();
  const value: SealedPlan = { items: plan.items, hard: plan.hard, slot: plan.slot };
  const sealed = await sealFor(tx, deps.keyring, planSealContext(userId, id), value, at);
  if (existingId === null) {
    await tx.insert(mealPlans).values({ id, userId, weekStart: plan.weekStart, sealed, createdAt: at, updatedAt: at });
  } else {
    await tx.update(mealPlans).set({ sealed, updatedAt: at }).where(and(eq(mealPlans.id, id), eq(mealPlans.userId, userId)));
  }
  return id;
}

/** Live user → `plan:` → the daily write cap → the `health_data` grant (share-locked): the week's write locks, in order. */
async function lockForWrite(tx: Tx, userId: string, at: Date): Promise<void> {
  await lockLiveUser(tx, userId);
  await lockUserPlan(tx, userId);
  await assertUnderWriteCap(tx, userId, WEEK_WRITE_ACTIONS, at);
  await lockConsentIn(tx, userId, 'health_data', at);
}

/**
 * Saves the player's plan for its week, inside the caller's transaction (Step 6, Ruling 18). Order: live user (401)
 * → advisory `plan:` → the daily write cap (429) → `health_data` (403 `consent_required`; Step 6 ruling: plans are
 * health data) → `validatePlan` (400 `plan_invalid` with its problems: shape, more than MAX_PLAN_ITEMS items, a
 * sacred or unknown slug) → `weekStart` must be `planWeekStart` of itself for the player's market days, and within
 * PLAN_WEEKS_BACK weeks before and PLAN_WEEKS_AHEAD after the current plan week of `today`, the player's local date
 * (I2, I3; the UTC date of `at` when absent) (400 `plan_invalid`) → core `checkPlan` with the player's rules: any item ⛔ on its date is 400 `plan_invalid` with
 * `blocked: <slug>`, so a stored plan never holds a dish that was blocked when it was saved. A ❓ item is saved (the
 * player chose it knowing) and is always read back as ❓. Then upsert by week (sealed, the row id kept) → audit
 * 'plan.save' (no content). Returns the plan as stored, with its row id, and the plan it replaced (for Step 8's undo).
 */
export async function savePlanIn(
  tx: Tx,
  deps: WeekDeps,
  userId: string,
  plan: Plan,
  at: Date,
  requestId?: string,
  today: string = utcToday(at),
): Promise<{ plan: Plan & { id: string }; previous: Plan | null }> {
  await lockForWrite(tx, userId, at);
  const problems = validatePlan(plan, deps);
  if (problems.length > 0) throw invalid(problems);
  const p = canonical(plan);
  const { marketDays } = await loadProfile(tx, userId, at);
  if (planWeekStart(p.weekStart, marketDays) !== p.weekStart) throw invalid(['plan: weekStart is not the first day of your plan week']);
  const currentWeek = planWeekStart(today, marketDays);
  if (p.weekStart < addDays(currentWeek, -7 * PLAN_WEEKS_BACK) || p.weekStart > addDays(currentWeek, 7 * PLAN_WEEKS_AHEAD)) {
    throw invalid(['plan: weekStart is outside the weeks you can plan']);
  }
  const blocked = (await checksFor(tx, deps, userId, p)).filter((c) => c.status === 'blocked').map((c) => `blocked: ${c.item.slug}`);
  if (blocked.length > 0) throw invalid([...new Set(blocked)]);
  const before = await loadPlan(tx, deps.keyring, userId, p.weekStart);
  const id = await writePlan(tx, deps, userId, p, before?.id ?? null, at);
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'plan.save', requestId }, at);
  const previous = before === null ? null : { weekStart: before.weekStart, items: before.items, hard: before.hard, slot: before.slot };
  return { plan: { ...p, id }, previous };
}

/**
 * Undoes a plan save (Step 8): puts `previous` back for `weekStart`, or, when there was none, deletes the week's plan
 * (its run goes with it). Same locks as `savePlanIn`. `previous` is shape-checked again, but not re-checked against
 * the rules: it is exactly the plan that stood a moment ago. Audits 'plan.restore'.
 */
export async function restorePlanIn(tx: Tx, deps: WeekDeps, userId: string, weekStart: string, previous: Plan | null, at: Date, requestId?: string): Promise<void> {
  await lockForWrite(tx, userId, at);
  const current = await loadPlan(tx, deps.keyring, userId, weekStart);
  if (previous === null) {
    if (current !== null) await tx.delete(mealPlans).where(and(eq(mealPlans.id, current.id), eq(mealPlans.userId, userId)));
  } else {
    const problems = validatePlan(previous, deps);
    if (problems.length > 0 || previous.weekStart !== weekStart) throw invalid(problems.length > 0 ? problems : ['plan: weekStart does not match']);
    await writePlan(tx, deps, userId, canonical(previous), current?.id ?? null, at);
  }
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'plan.restore', requestId }, at);
}

/**
 * Deletes the player's plan for `weekStart`, and with it its market run (cascade); pantry rows its ticks added stay,
 * they are the player's food. No consent needed (kept data must stay deletable after a withdrawal). Live user →
 * `plan:` → delete → audit 'plan.delete' when a plan went. Returns whether one did.
 */
export async function deletePlanIn(tx: Tx, userId: string, weekStart: string, at: Date, requestId?: string): Promise<boolean> {
  await lockLiveUser(tx, userId);
  await lockUserPlan(tx, userId);
  const gone = await tx
    .delete(mealPlans)
    .where(and(eq(mealPlans.userId, userId), eq(mealPlans.weekStart, weekStart)))
    .returning({ id: mealPlans.id });
  if (gone.length > 0) await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'plan.delete', requestId }, at);
  return gone.length > 0;
}

/** The player's current plan week (Ruling 11): `planWeekStart(today, marketDays)`, `today` their local date (I2). */
export async function currentWeekStart(tx: Tx, userId: string, at: Date, today: string): Promise<string> {
  const { marketDays } = await loadProfile(tx, userId, at);
  return planWeekStart(today, marketDays);
}
