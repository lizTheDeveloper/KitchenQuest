import type { IngredientGraph } from '../ingredients/graph';
import type { Rule } from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function validateRules(rules: Rule[], graph: IngredientGraph): string[] {
  const problems: string[] = [];
  for (const rule of rules) {
    if (rule.target.ids.length === 0) {
      problems.push(`Rule "${rule.id}": target.ids is empty`);
    }
    for (const id of rule.target.ids) {
      if (!graph.has(id)) {
        problems.push(`Rule "${rule.id}": target id "${id}" is not in the ingredient graph`);
      }
    }
    if (rule.type === 'limit' && !rule.limit) {
      problems.push(`Rule "${rule.id}": limit rule has no limit`);
    }
    if (rule.phase) {
      const { start, end } = rule.phase;
      if (!isValidDate(start)) {
        problems.push(`Rule "${rule.id}": phase.start "${start}" is not a valid YYYY-MM-DD date`);
      }
      if (end !== undefined && !isValidDate(end)) {
        problems.push(`Rule "${rule.id}": phase.end "${end}" is not a valid YYYY-MM-DD date`);
      }
    }
  }
  return problems;
}

/** Phase bounds are inclusive; ISO dates compare correctly as strings. */
export function isActive(rule: Rule, date: string): boolean {
  const phase = rule.phase;
  if (!phase) return true;
  if (date < phase.start) return false;
  if (phase.end !== undefined && date > phase.end) return false;
  return true;
}
