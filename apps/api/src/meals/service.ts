import { randomUUID } from 'node:crypto';
import { isValidDate, MEAL_DESCRIPTION_MAX, MEAL_SLOTS, type MealEntry, type MealItem } from '@kitchenquest/core';
import { and, eq } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { sealFor } from '../crypto/userkeys.js';
import { canonRecipes, mealLogs } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { mealSealContext } from './store.js';

/** How far back a meal may be logged, and how far ahead (the player's date may be a day past the server's, as in M2). */
const MEAL_DAYS_BACK = 7;
const MEAL_DAYS_AHEAD = 1;
const SERVINGS_MIN = 0.25;
const SERVINGS_MAX = 10;

const DAY_MS = 86_400_000;

/** `date` (YYYY-MM-DD) moved by `days`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Problems with any key of `v` outside `keys` (nothing beyond the meal is sealed into health data). */
const extraKeys = (v: Record<string, unknown>, keys: readonly string[], where: string): string[] =>
  Object.keys(v).some((k) => !keys.includes(k)) ? [`${where} may hold only: ${keys.join(', ')}`] : [];

/**
 * Problems with `meal` as a meal entry, as plain strings (none quotes the
 * input, so none carries what the player ate): `eatenOn` a real date within
 * [today − 7, today + 1]; `slot` in core's `MEAL_SLOTS`; a dish's `slug` in
 * `recipeSlugs` with `servings` a finite number in [0.25, 10]; a free
 * `description` 1–200 characters after trim (core's `MEAL_DESCRIPTION_MAX`).
 * No other keys are allowed. Empty means valid.
 */
export function validateMeal(meal: unknown, today: string, recipeSlugs: ReadonlySet<string>): string[] {
  if (!isObject(meal)) return ['meal must be an object'];
  const problems = extraKeys(meal, ['eatenOn', 'slot', 'item'], 'meal');
  const { eatenOn, slot, item } = meal;
  if (!isValidDate(eatenOn)) problems.push('eatenOn must be a real date, YYYY-MM-DD');
  else if (eatenOn < addDays(today, -MEAL_DAYS_BACK) || eatenOn > addDays(today, MEAL_DAYS_AHEAD)) {
    problems.push(`eatenOn must be within ${MEAL_DAYS_BACK} days before today and ${MEAL_DAYS_AHEAD} day after`);
  }
  if (typeof slot !== 'string' || !(MEAL_SLOTS as readonly string[]).includes(slot)) {
    problems.push(`slot must be one of: ${MEAL_SLOTS.join(', ')}`);
  }
  if (!isObject(item)) {
    problems.push('item must be an object');
  } else if (item.kind === 'dish') {
    problems.push(...extraKeys(item, ['kind', 'slug', 'servings'], 'item'));
    if (typeof item.slug !== 'string' || !recipeSlugs.has(item.slug)) problems.push('item.slug must be a canon recipe');
    const s = item.servings;
    if (typeof s !== 'number' || !Number.isFinite(s) || s < SERVINGS_MIN || s > SERVINGS_MAX) {
      problems.push(`item.servings must be a number from ${SERVINGS_MIN} to ${SERVINGS_MAX}`);
    }
  } else if (item.kind === 'free') {
    problems.push(...extraKeys(item, ['kind', 'description'], 'item'));
    const d = typeof item.description === 'string' ? item.description.trim() : null;
    if (d === null || d.length < 1 || d.length > MEAL_DESCRIPTION_MAX) {
      problems.push(`item.description must be 1 to ${MEAL_DESCRIPTION_MAX} characters`);
    }
  } else {
    problems.push("item.kind must be 'dish' or 'free'");
  }
  return problems;
}

/** The meal as sealed and returned: exactly the entry's fields, a free description trimmed. Call after `validateMeal`. */
function canonical(meal: MealEntry): MealEntry {
  const item: MealItem =
    meal.item.kind === 'dish'
      ? { kind: 'dish', slug: meal.item.slug, servings: meal.item.servings }
      : { kind: 'free', description: meal.item.description.trim() };
  return { eatenOn: meal.eatenOn, slot: meal.slot, item };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new ApiError(404, 'not_found', 'Meal not found');

/**
 * Logs a meal for the player, inside the caller's transaction. Order: live
 * user (401) → `health_data` consent (403) → validation (400 `bad_request`
 * with `problems`) → seal → insert → audit 'meals.create' (the row id only).
 * No advisory lock: meal logs have no cap (user row → consent row, in the
 * global order). `today` is `at`'s UTC date. The caller has already checked
 * the player's explicit yes.
 */
export async function createMealLogIn(
  tx: Tx,
  deps: { keyring: Keyring },
  userId: string,
  meal: MealEntry,
  at: Date,
  requestId?: string,
): Promise<MealEntry & { id: string }> {
  await lockLiveUser(tx, userId);
  await lockConsentIn(tx, userId, 'health_data', at);
  const input: unknown = meal;
  const isDish = (input as { item?: { kind?: unknown } } | null)?.item?.kind === 'dish';
  // Loaded only for a dish, inside the transaction.
  const recipeSlugs = new Set(isDish ? (await tx.select({ slug: canonRecipes.slug }).from(canonRecipes)).map((r) => r.slug) : []);
  const problems = validateMeal(input, at.toISOString().slice(0, 10), recipeSlugs);
  if (problems.length > 0) throw new ApiError(400, 'bad_request', 'The meal is not valid', { problems });
  const value = canonical(meal);
  // Generated before insert: the seal is bound to it (C-3).
  const rowId = randomUUID();
  const sealed = await sealFor(tx, deps.keyring, mealSealContext(userId, rowId), value.item, at);
  await tx.insert(mealLogs).values({ id: rowId, userId, eatenOn: value.eatenOn, slot: value.slot, sealed, createdAt: at });
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'meals.create', target: rowId, requestId }, at);
  return { ...value, id: rowId };
}

/**
 * Deletes one of the player's meal logs, inside the caller's transaction:
 * live user (401), then 404 when `id` is not theirs (a malformed id looks the
 * same and never reaches the database). No consent needed, as rules: kept
 * data must stay deletable after a "keep" withdrawal. Audits 'meals.delete'.
 */
export async function deleteMealLogIn(tx: Tx, userId: string, id: string, at: Date, requestId?: string): Promise<void> {
  await lockLiveUser(tx, userId);
  if (!UUID.test(id)) throw notFound();
  const rowId = id.toLowerCase();
  const deleted = await tx
    .delete(mealLogs)
    .where(and(eq(mealLogs.id, rowId), eq(mealLogs.userId, userId)))
    .returning({ id: mealLogs.id });
  if (deleted.length === 0) throw notFound();
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'meals.delete', target: rowId, requestId }, at);
}
