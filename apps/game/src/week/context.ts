import {
  planWeekStart, type ParsedRecipe, type Plan, type PlanContext, type PlanItem, type Rule, type ToolkitState, type WeeklySlotInput,
} from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { activeRules } from '../recipes/rules';
import type { PlayerState } from '../state/store';

/**
 * The week's shared context on the device (M5 Step 10): the canon as core takes it, the player's rules (or null
 * while they can't be read: "can't verify" is never safe), the plan week and One More Technique's slot input. The
 * scripted engine, the writer and the week screens all read the week through these, so each judges it alike.
 */

const DAY_MS = 86_400_000;
/** The local date `days` after `date` (whole calendar days, as core's own). */
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** How long a plan (and its run) stays on the device after its week ends: the server's retention (Ruling 18). */
export const PLAN_RETENTION_WEEKS = 8;

let canon: ReadonlyMap<string, ParsedRecipe> | null = null;
/** Every canon recipe by slug, as core's `PlanContext.recipes` (built once). */
export function canonRecipes(): ReadonlyMap<string, ParsedRecipe> {
  canon ??= new Map(Object.entries(content.recipes));
  return canon;
}

/** Every canon dish for core's name matching (`planIntent`, `matchDish`). */
export function dishList(): { slug: string; title: string }[] {
  return Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
}

/** The player's active rules, or null while they can't be read (then nothing is shown as ✅ and nothing is planned). */
export function rulesOf(state: PlayerState): Rule[] | null {
  const r = activeRules(state, graph);
  return r.status === 'ready' ? r.rules : null;
}

/** The plan week holding `today` for these market days (Ruling 11). */
export const weekOf = (today: string, marketDays: readonly number[]): string => planWeekStart(today, marketDays);

/** Core's `PlanContext` for a week: the canon, the player's rules, the graph and swaps, and what the week holds. */
export function planContextFor(weekStart: string, rules: Rule[], existing: readonly PlanItem[] = []): PlanContext {
  return { weekStart, recipes: canonRecipes(), rules, graph, subs: [...content.substitutions], existing, foodGroups: content.foodGroups };
}

/**
 * One More Technique's input for the week (`weeklySlot`): the toolkit the game shows, every non-sacred canon dish
 * (all taught, Ruling 3), the player's rules and the week's own `hard` and slot answer.
 */
export function slotInputFor(plan: Pick<Plan, 'weekStart' | 'hard' | 'slot'>, rules: Rule[], toolkit: ToolkitState, today: string, planned: readonly string[] = []): WeeklySlotInput {
  const recipes = canonRecipes();
  return {
    toolkit,
    techniques: content.techniques.techniques,
    recipes,
    taught: new Set([...recipes].filter(([, r]) => !r.meta.sacred).map(([slug]) => slug)),
    planned,
    rules,
    graph,
    subs: [...content.substitutions],
    weekStart: plan.weekStart,
    today,
    thresholds: content.techniques.freshness,
    week: { hard: plan.hard, slot: plan.slot },
  };
}

/** An empty plan for a week. */
export const emptyPlan = (weekStart: string): Plan => ({ weekStart, items: [], hard: false, slot: 'unanswered' });

/** The plan-week day (0–6) `today` falls on, or null when it is outside the week. */
export function dayOfWeek(weekStart: string, today: string): number | null {
  for (let d = 0; d < 7; d++) if (addDays(weekStart, d) === today) return d;
  return null;
}
