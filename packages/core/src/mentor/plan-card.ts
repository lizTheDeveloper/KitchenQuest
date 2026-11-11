// The Pan's plan card (Form 7-W, M5 Step 8): code reads the request (Ruling 14), checks every dish on its own date
// (§2.2) and writes the read-back. The server's turn and the client's scripted engine build the same card from it.
import type { IngredientGraph } from '../ingredients/graph';
import type { Finding } from '../rules/check';
import { weeklySlot, type WeeklySlotInput } from '../toolkit/one-more';
import { checkPlan, MAX_PLAN_ITEMS, PLAN_DAYS, PLAN_DISH_SACRED_TRIGGER, resolvePlanRequest, suggestPlan, type PlanContext, type PlanItem, type PlanRequest } from '../week/plan';
import type { LineRef, PlanCard } from './cards';
import { WEEKDAY_NAMES } from './parse';
import { weekdayNumbers } from './route';

const line = (trigger: string, vars: Record<string, string> = {}): LineRef => ({ trigger, vars });
const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const DAY_MS = 86_400_000;

/** A dish's name as the Pan says it: its title without the bracketed gloss ("Parippu Curry (Kerala dal…)" → "Parippu Curry"). */
export function dishName(slug: string, recipes: PlanContext['recipes']): string {
  const title = recipes.get(slug)?.meta.title ?? slug.slice(slug.lastIndexOf('/') + 1).replace(/-/g, ' ');
  return title.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

/** The weekday name of plan-week day `day` ("Sunday"). */
function weekdayOf(weekStart: string, day: number): string {
  const n = new Date(Date.parse(`${weekStart}T00:00:00Z`) + day * DAY_MS).getUTCDay();
  return capitalised(WEEKDAY_NAMES[n]);
}

/** The code-built summary: one sentence per day, in week order ("Sunday: Parippu Curry. Monday: Onigiri."). */
function summaryOf(weekStart: string, items: readonly PlanItem[], recipes: PlanContext['recipes']): string {
  if (items.length === 0) return 'Nothing planned yet.';
  const days = [...new Set(items.map((i) => i.day))].sort((a, b) => a - b);
  return days
    .map((d) => {
      const names = items.filter((i) => i.day === d).map((i) => (i.kind === 'lesson' ? `${dishName(i.slug, recipes)} (lesson)` : dishName(i.slug, recipes)));
      return `${weekdayOf(weekStart, d)}: ${names.join(', ')}.`;
    })
    .join(' ');
}

/** What blocks a dish, in words, from the rules check's first ⛔ finding ("coconut milk counts as coconut"). */
function blockedFinding(findings: readonly Finding[], graph: IngredientGraph): string {
  const f = findings.find((x) => x.status === 'blocked') ?? findings[0];
  if (f === undefined) return 'it clashes with your rules';
  const path = (f.path ?? []).filter((id) => graph.has(id)).map((id) => graph.get(id).name);
  const what = f.ingredient === '' ? 'it' : f.ingredient;
  return path.length > 1 ? `${what} counts as ${path[path.length - 1]}` : `${what} is on your rules`;
}

/** The ⛔ findings of `slug` on the first day of the week it is blocked on (for the read-back's `{finding}`). */
function findingsWhenBlocked(slug: string, ctx: PlanContext): Finding[] {
  const plan = { weekStart: ctx.weekStart, items: Array.from({ length: PLAN_DAYS }, (_, day): PlanItem => ({ day, kind: 'dish', slug, servings: 1 })), hard: false, slot: 'unanswered' as const };
  return checkPlan(plan, ctx).find((c) => c.status === 'blocked')?.findings ?? [];
}

/** The plan-week days strictly before `today` (picks never land in the past; a named dish may). */
function pastDays(weekStart: string, today: string): number[] {
  const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${weekStart}T00:00:00Z`)) / DAY_MS);
  return Array.from({ length: Math.max(0, Math.min(PLAN_DAYS, n)) }, (_, d) => d);
}

const sameItem = (a: PlanItem, b: PlanItem): boolean => a.day === b.day && a.kind === b.kind && a.slug === b.slug;

/**
 * The plan card for a request (M5 Step 8), or the lines to say when there is nothing to plan. `ctx.existing` is the
 * week's plan as stored; the card's `items` are those plus the request's new items (the whole week the confirm
 * saves), and `ctx.slot.week` is that week's `hard` and One More Technique `slot`. Names are resolved by core
 * `resolvePlanRequest` unchanged (Ruling 22: "dal" alone is `plan.dish_unknown`); "pick N" is `suggestPlan`, only
 * on days from `ctx.slot.today` on and after `after`, never padded. Every item is checked on its own date: a ⛔ one
 * never reaches the card (it is read back with `plan.blocked_dish`, an existing one included), a ❓ one is kept and
 * read back with `plan.unverified_dish`. `readback` = [plan.readback { summary }, plan.hard_week when the request
 * says the week is hard, plan.dish_unknown per `unknown` string, plan.unverified_dish per ❓ item,
 * plan.blocked_dish per dropped dish, then plan.dish_sacred per sacred dish, plan.which_day per dish with no single
 * day, plan.after_which_day when `after` names no single day, and plan.fewer_than_asked when "pick N" found fewer].
 */
export function buildPlanCard(req: PlanRequest, ctx: PlanContext & { slot: WeeklySlotInput }): PlanCard | { none: LineRef[] } {
  const r = resolvePlanRequest({ ...req, pick: null }, ctx);
  const named = r.items;
  // "pick N" here, not in resolvePlanRequest, so picks also skip the days already past.
  let picked: PlanItem[] = [];
  const pick = req.pick === null ? null : Math.min(PLAN_DAYS, Math.max(0, Math.floor(req.pick)));
  if (pick !== null && pick > 0 && r.afterNoDay === null) {
    const afterWords = typeof req.after === 'string' ? req.after.trim() : '';
    const afterDay = afterWords === '' ? null : dayOffset(afterWords, ctx.weekStart);
    const avoid = [...pastDays(ctx.weekStart, ctx.slot.today), ...(afterDay === null ? [] : Array.from({ length: afterDay + 1 }, (_, d) => d))];
    picked = suggestPlan(pick, { ...ctx, existing: [...ctx.existing, ...named] }, avoid);
  }

  // The week as it stands, re-checked now: an item the rules block today leaves the card and is read back.
  const merged: PlanItem[] = [];
  for (const item of [...ctx.existing, ...named, ...picked]) if (!merged.some((m) => sameItem(m, item))) merged.push(item);
  const hard = req.hard ?? ctx.slot.week.hard;
  const checked = checkPlan({ weekStart: ctx.weekStart, items: merged, hard, slot: ctx.slot.week.slot }, ctx);
  const dropped = r.dropped.map((d) => d.slug);
  const status = new Map<PlanItem, PlanCard['checks'][number]['status']>();
  for (const c of checked) {
    if (c.status === 'blocked') {
      if (!dropped.includes(c.item.slug)) dropped.push(c.item.slug);
    } else if (status.size < MAX_PLAN_ITEMS) status.set(c.item, c.status);
  }
  const byKey = (a: PlanItem, b: PlanItem): number => a.day - b.day || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const items = [...status.keys()].sort(byKey);
  const checks: PlanCard['checks'] = items.map((i) => ({ slug: i.slug, status: status.get(i)! }));

  const tail: LineRef[] = [
    ...r.unknown.map((dish) => line('plan.dish_unknown', { dish })),
    ...[...new Set(checks.filter((c) => c.status === 'unverified').map((c) => c.slug))].map((slug) => line('plan.unverified_dish', { dish: dishName(slug, ctx.recipes) })),
    ...dropped.map((slug) => line('plan.blocked_dish', { dish: dishName(slug, ctx.recipes), finding: blockedFinding(findingsWhenBlocked(slug, ctx), ctx.graph) })),
    ...r.sacred.map((slug) => line(PLAN_DISH_SACRED_TRIGGER, { dish: dishName(slug, ctx.recipes) })),
    ...r.noDay.map((dish) => line('plan.which_day', { dish })),
    ...(r.afterNoDay === null ? [] : [line('plan.after_which_day', { day: r.afterNoDay })]),
    ...(pick !== null && pick > 0 && r.afterNoDay === null && picked.length < pick ? [line('plan.fewer_than_asked', { count: String(picked.length) })] : []),
  ];
  const added = items.some((i) => !ctx.existing.some((e) => sameItem(e, i)));
  const hardChanged = req.hard !== null && req.hard !== ctx.slot.week.hard;
  if (!added && !hardChanged) return { none: tail.length > 0 ? tail : [line('didnt_understand')] };
  const offer = hard ? null : weeklySlot({ ...ctx.slot, planned: items.map((i) => i.slug), week: { hard, slot: ctx.slot.week.slot } });
  const summary = summaryOf(ctx.weekStart, items, ctx.recipes);
  return {
    kind: 'plan',
    weekStart: ctx.weekStart,
    items,
    hard,
    checks,
    unknown: [...r.unknown],
    dropped,
    offer,
    summary,
    // The line adds its own full stop.
    readback: [line('plan.readback', { summary: summary.replace(/\.$/, '') }), ...(req.hard === true ? [line('plan.hard_week')] : []), ...tail],
  };
}

/** The plan-week day (0–6) one weekday name falls on, or null when it names no single day (resolvePlanRequest's reading). */
function dayOffset(weekday: string, weekStart: string): number | null {
  const days = weekdayNumbers([weekday]);
  if (days.length !== 1) return null;
  return (days[0] - new Date(`${weekStart}T00:00:00Z`).getUTCDay() + PLAN_DAYS) % PLAN_DAYS;
}
