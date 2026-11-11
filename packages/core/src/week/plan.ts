// The week's plan (spec §3.2, Rulings 11 and 14): names become canon slugs through M4's `matchDish` (no aliases,
// Ruling 22), "pick N" is chosen by code, and every dish is checked by the rules engine on the date it is planned
// for. Pure and deterministic: no clock, no randomness.
import type { IngredientGraph } from '../ingredients/graph';
import { matchDish, weekdayNumbers } from '../mentor/route';
import { addDays } from '../progress/week';
import type { ParsedRecipe } from '../recipe/types';
import { isValidDate } from '../rules/active';
import { check, type CheckResult, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';

export type PlanItem =
  | { day: number /* 0–6, offset from weekStart */; kind: 'dish'; slug: string; servings: number }
  | { day: number; kind: 'lesson'; slug: string }; // One More Technique's drill day (Step 2)

export interface Plan {
  weekStart: string;
  items: PlanItem[];
  hard: boolean;
  slot: 'unanswered' | 'offered' | 'accepted' | 'declined';
}

export interface PlanRequest {
  days: { weekday: string; dish: string }[] | null;
  pick: number | null;
  hard: boolean | null;
  after?: string | null;
}

export type FoodGroup = 'veg_fruit' | 'protein' | 'grain';
/** data/food-groups.json: ingredient or category id → group (Step 4). */
export type FoodGroups = Readonly<Record<string, FoodGroup>>;

export interface PlanContext {
  weekStart: string;
  recipes: ReadonlyMap<string, ParsedRecipe>;
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  /** Items already in this week's plan: `suggestPlan` doesn't repeat their dishes or fill their days. */
  existing: readonly PlanItem[];
  foodGroups: FoodGroups;
}

export type PlanItemCheck = { item: PlanItem; status: CheckResult['status']; findings: CheckResult['findings'] };
export type PlanFlag = 'gap_green' | 'gap_protein' | 'balanced' | null;

export const MAX_PLAN_ITEMS = 21;
export const PLAN_DAYS = 7;
export const MIN_SERVINGS = 0.5;
export const MAX_SERVINGS = 10;

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const dayOfWeek = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The plan-day offset (0–6) of one weekday name, or null when it names no single day ("weekend", "tonight"). */
function dayOffset(weekday: string, weekStart: string): number | null {
  const days = weekdayNumbers([weekday]);
  if (days.length !== 1) return null;
  return (days[0] - dayOfWeek(weekStart) + PLAN_DAYS) % PLAN_DAYS;
}

/** The player's words for an unmatched dish (C19): trimmed, one leading "the", "a" or "an" dropped, nothing else. */
function unknownWords(dish: string): string {
  return dish.trim().replace(/^(?:the|a|an)\s+/i, '');
}

/** The servings a planned dish defaults to: the recipe's own yield, kept inside the plan's bounds. */
function defaultServings(r: ParsedRecipe): number {
  const s = r.meta.servings;
  return Number.isFinite(s) ? Math.min(MAX_SERVINGS, Math.max(MIN_SERVINGS, s)) : 1;
}

/** Non-sacred canon dishes, as `matchDish` takes them, by slug. Sacred dishes are never planned (§10). */
function plannable(recipes: ReadonlyMap<string, ParsedRecipe>): { slug: string; title: string }[] {
  return [...recipes]
    .filter(([, r]) => !r.meta.sacred)
    .map(([slug, r]) => ({ slug, title: r.meta.title }))
    .sort((a, b) => byId(a.slug, b.slug));
}

const statusOn = (r: ParsedRecipe, day: number, ctx: PlanContext): CheckResult =>
  check(r, ctx.rules, ctx.graph, ctx.subs, addDays(ctx.weekStart, day));

/**
 * A plan request as code reads it (Ruling 14). Named dishes go through `matchDish` unchanged; an unmatched name is
 * reported in `unknown` in the player's words, never guessed (C1, C19). A named dish the rules block on its date is
 * dropped and reported, never placed; a ❓ one is placed (the player chose it) and shows as ❓. `noDay` holds the dish
 * words of entries whose weekday names no single day. `pick` is `suggestPlan`, after the named dishes, on days
 * strictly after `after` when that names a day. Returns the new items only; `ctx.existing` is left as it is.
 */
export function resolvePlanRequest(
  req: PlanRequest,
  ctx: PlanContext,
): { items: PlanItem[]; unknown: string[]; dropped: { slug: string; status: 'blocked' }[]; noDay: string[] } {
  const candidates = plannable(ctx.recipes);
  const items: PlanItem[] = [];
  const unknown: string[] = [];
  const dropped: { slug: string; status: 'blocked' }[] = [];
  const noDay: string[] = [];
  // The request comes from the model's tool call or a scripted intent: read it defensively.
  for (const entry of (req.days ?? []) as readonly (Partial<Record<'weekday' | 'dish', unknown>> | null)[]) {
    if (typeof entry?.dish !== 'string' || typeof entry.weekday !== 'string') continue;
    const match = matchDish(entry.dish, candidates);
    if (match === null) {
      const words = unknownWords(entry.dish);
      if (words !== '') unknown.push(words);
      continue;
    }
    const day = dayOffset(entry.weekday, ctx.weekStart);
    if (day === null) {
      noDay.push(unknownWords(entry.dish));
      continue;
    }
    const recipe = ctx.recipes.get(match.slug)!;
    if (statusOn(recipe, day, ctx).status === 'blocked') {
      if (!dropped.some((d) => d.slug === match.slug)) dropped.push({ slug: match.slug, status: 'blocked' });
      continue;
    }
    items.push({ day, kind: 'dish', slug: match.slug, servings: defaultServings(recipe) });
  }
  if (req.pick !== null && req.pick > 0) {
    const after = typeof req.after === 'string' ? dayOffset(req.after, ctx.weekStart) : null;
    const avoid = after === null ? [] : Array.from({ length: after + 1 }, (_, d) => d);
    items.push(...suggestPlan(req.pick, { ...ctx, existing: [...ctx.existing, ...items] }, avoid));
  }
  return { items, unknown, dropped, noDay };
}

/**
 * Up to `n` dishes for the free days of the week (C18): one a day, earliest free day first, skipping `avoidDays` and
 * days that already hold a dish. Only dishes whose check on that day is ✅ or a labelled swap are picked, never ❓ or
 * ⛔, and the result is never padded: when fewer pass, fewer come back. Variety by cook: a cook not yet in the week
 * comes first, then the cook with the fewest dishes so far, then by slug. A dish already planned is not repeated.
 */
export function suggestPlan(n: number, ctx: PlanContext, avoidDays: readonly number[] = []): PlanItem[] {
  const want = Number.isFinite(n) ? Math.min(PLAN_DAYS, Math.max(0, Math.floor(n))) : 0;
  const dishItems = ctx.existing.filter((i) => i.kind === 'dish');
  const used = new Set(dishItems.map((i) => i.slug));
  const busy = new Set([...dishItems.map((i) => i.day), ...avoidDays]);
  const perCook = new Map<string, number>();
  for (const i of dishItems) {
    const cook = ctx.recipes.get(i.slug)?.meta.cook;
    if (cook !== undefined) perCook.set(cook, (perCook.get(cook) ?? 0) + 1);
  }
  const out: PlanItem[] = [];
  for (let day = 0; day < PLAN_DAYS && out.length < want; day++) {
    if (busy.has(day)) continue;
    const ranked = plannable(ctx.recipes)
      .filter((c) => !used.has(c.slug))
      .map((c) => ({ slug: c.slug, recipe: ctx.recipes.get(c.slug)! }))
      .sort((a, b) => (perCook.get(a.recipe.meta.cook) ?? 0) - (perCook.get(b.recipe.meta.cook) ?? 0) || byId(a.slug, b.slug));
    const pick = ranked.find(({ recipe }) => {
      const { status } = statusOn(recipe, day, ctx);
      return status === 'ok' || status === 'swap';
    });
    if (!pick) continue;
    used.add(pick.slug);
    perCook.set(pick.recipe.meta.cook, (perCook.get(pick.recipe.meta.cook) ?? 0) + 1);
    out.push({ day, kind: 'dish', slug: pick.slug, servings: defaultServings(pick.recipe) });
  }
  return out;
}

/**
 * Every item checked on its own date (weekStart + day), with the player's rules as they are now; a plan never stores
 * a status. A slug the canon doesn't hold can't be verified: ❓, never ✅.
 */
export function checkPlan(plan: Plan, ctx: PlanContext): PlanItemCheck[] {
  return plan.items.map((item) => {
    const r = ctx.recipes.get(item.slug);
    if (!r) return { item, status: 'unverified', findings: [] };
    const result = check(r, ctx.rules, ctx.graph, ctx.subs, addDays(plan.weekStart, item.day));
    return { item, status: result.status, findings: result.findings };
  });
}

/** The food group of an ingredient id: its own entry, else the nearest `isA` ancestor's (breadth first), else null. */
export function foodGroupOf(id: string, graph: IngredientGraph, groups: FoodGroups): FoodGroup | null {
  const own = Object.hasOwn(groups, id) ? groups[id] : undefined;
  if (own !== undefined) return own;
  if (!graph.has(id)) return null;
  const seen = new Set([id]);
  const queue = [...(graph.get(id).isA ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Object.hasOwn(groups, cur)) return groups[cur];
    if (graph.has(cur)) queue.push(...(graph.get(cur).isA ?? []));
  }
  return null;
}

/**
 * The plan's one food-group flag (Step 10's `plan.gap_green` / `plan.gap_protein` / `plan.balanced`), over the dish
 * items the player can cook (an item ⛔ on its date counts for nothing). `balanced` only when every group is
 * present; an ingredient the graph can't resolve, or with no group, counts for nothing. No dishes → null; only the
 * grain group missing → null (there is no grain line, and a flag never nags).
 */
export function planFlags(plan: Plan, ctx: PlanContext): PlanFlag {
  const present = new Set<FoodGroup>();
  let dishes = 0;
  for (const { item, status } of checkPlan(plan, ctx)) {
    if (item.kind !== 'dish' || status === 'blocked') continue;
    const r = ctx.recipes.get(item.slug);
    if (!r) continue;
    dishes++;
    for (const line of r.ingredients) {
      const id = ctx.graph.resolve(line.name);
      const group = id === null ? null : foodGroupOf(id, ctx.graph, ctx.foodGroups);
      if (group !== null) present.add(group);
    }
  }
  if (dishes === 0) return null;
  if (present.has('veg_fruit') && present.has('protein') && present.has('grain')) return 'balanced';
  if (!present.has('veg_fruit')) return 'gap_green';
  if (!present.has('protein')) return 'gap_protein';
  return null;
}

const PLAN_KEYS = new Set(['weekStart', 'items', 'hard', 'slot']);
const DISH_KEYS = new Set(['day', 'kind', 'slug', 'servings']);
const LESSON_KEYS = new Set(['day', 'kind', 'slug']);
const SLOTS = new Set(['unanswered', 'offered', 'accepted', 'declined']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const extraKeys = (o: Record<string, unknown>, allowed: ReadonlySet<string>): string[] => Object.keys(o).filter((k) => !allowed.has(k));

/**
 * The plan's shape against the canon, before it is stored (Step 6): a valid `weekStart`, at most `MAX_PLAN_ITEMS`
 * items, each on day 0–6 with a known, non-sacred slug, dishes with servings 0.5–10, and no field outside the shape
 * (a stored plan can't carry free text). Never throws. Rules are checked separately (`checkPlan`).
 */
export function validatePlan(plan: unknown, ctx: Pick<PlanContext, 'recipes'>): string[] {
  if (!isObject(plan)) return ['plan: not an object'];
  const problems: string[] = extraKeys(plan, PLAN_KEYS).map((k) => `plan: unknown field "${k}"`);
  if (typeof plan.weekStart !== 'string' || !isValidDate(plan.weekStart)) problems.push('plan: weekStart is not a YYYY-MM-DD date');
  if (typeof plan.hard !== 'boolean') problems.push('plan: hard is not a boolean');
  if (typeof plan.slot !== 'string' || !SLOTS.has(plan.slot)) problems.push('plan: slot is not unanswered, offered, accepted or declined');
  if (!Array.isArray(plan.items)) return [...problems, 'plan: items is not a list'];
  if (plan.items.length > MAX_PLAN_ITEMS) problems.push(`plan: more than ${MAX_PLAN_ITEMS} items`);
  plan.items.slice(0, MAX_PLAN_ITEMS + 1).forEach((item: unknown, i: number) => {
    const at = `plan: item ${i}`;
    if (!isObject(item)) {
      problems.push(`${at} is not an object`);
      return;
    }
    if (item.kind !== 'dish' && item.kind !== 'lesson') {
      problems.push(`${at}: kind is not dish or lesson`);
      return;
    }
    problems.push(...extraKeys(item, item.kind === 'dish' ? DISH_KEYS : LESSON_KEYS).map((k) => `${at}: unknown field "${k}"`));
    if (!Number.isInteger(item.day) || (item.day as number) < 0 || (item.day as number) >= PLAN_DAYS) problems.push(`${at}: day is not 0–6`);
    const r = typeof item.slug === 'string' ? ctx.recipes.get(item.slug) : undefined;
    if (r === undefined) problems.push(`${at}: unknown recipe`);
    else if (r.meta.sacred) problems.push(`${at}: sacred recipes are not planned`);
    if (item.kind === 'dish') {
      const s = item.servings;
      if (typeof s !== 'number' || !Number.isFinite(s) || s < MIN_SERVINGS || s > MAX_SERVINGS) problems.push(`${at}: servings is not 0.5–10`);
    }
  });
  return problems;
}

/** Plan-week date of an item (weekStart + day). */
export const itemDate = (plan: Pick<Plan, 'weekStart'>, item: Pick<PlanItem, 'day'>): string => addDays(plan.weekStart, item.day);
