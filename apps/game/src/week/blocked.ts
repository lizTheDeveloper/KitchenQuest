import { blockedDishLine, checkPlan, type LineRef, type Plan, type Rule } from '@kitchenquest/core/engine';
import { graph } from '../content';
import { canonRecipes, planContextFor } from './context';

/**
 * Ruling 5: a save refused because a dish is ⛔ now (a rule filed after it was planned) says `plan.blocked_dish`,
 * naming each such dish and what blocks it, from the rules engine's own findings. Never a plain "try again".
 */
export function blockedLinesFor(plan: Plan, rules: Rule[]): LineRef[] {
  const out: LineRef[] = [];
  const seen = new Set<string>();
  for (const c of checkPlan(plan, planContextFor(plan.weekStart, rules))) {
    if (c.status !== 'blocked' || seen.has(c.item.slug)) continue;
    seen.add(c.item.slug);
    out.push(blockedDishLine(c.item.slug, c.findings, canonRecipes(), graph));
  }
  return out;
}

/** The slugs of a save's `blocked: <slug>` problems (the device's and the API's own). */
export const blockedSlugs = (problems: readonly string[]): string[] =>
  [...new Set(problems.flatMap((p) => (p.startsWith('blocked: ') ? [p.slice('blocked: '.length)] : [])))];
