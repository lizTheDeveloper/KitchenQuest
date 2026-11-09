import type { IngredientGraph } from '../ingredients/graph';
import type { Rule } from './types';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const TYPES: readonly unknown[] = ['avoid', 'limit', 'prefer'];
const SEVERITIES: readonly unknown[] = ['anaphylactic', 'allergy', 'intolerance', 'preference'];
const KINDS: readonly unknown[] = ['ingredient', 'category', 'component'];
const PERS: readonly unknown[] = ['serving', 'day'];

/** A real calendar date written as `YYYY-MM-DD` (no time, no other format). */
export function isValidDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Every problem with `rules`, each naming the rule. Rules may come from untyped data (a save
 * file, a form), so every field is checked at runtime, not just trusted from the type.
 */
export function validateRules(rules: Rule[], graph: IngredientGraph): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  rules.forEach((rule: unknown, index) => {
    if (!isObject(rule)) {
      problems.push(`Rule ${index + 1}: is not an object`);
      return;
    }
    const { id, type, severity, target, limit, phase } = rule;
    let name: string;
    if (typeof id !== 'string' || id.trim() === '') {
      name = `Rule ${index + 1}`;
      problems.push(`${name}: id must be a non-empty string`);
    } else {
      name = `Rule "${id}"`;
      if (seen.has(id)) problems.push(`${name}: duplicate rule id "${id}"`);
      seen.add(id);
    }

    if (!TYPES.includes(type)) problems.push(`${name}: type ${JSON.stringify(type)} is not avoid, limit or prefer`);
    if (!SEVERITIES.includes(severity)) {
      problems.push(`${name}: severity ${JSON.stringify(severity)} is not anaphylactic, allergy, intolerance or preference`);
    }

    if (!isObject(target)) {
      problems.push(`${name}: target must be an object with kind and ids`);
    } else {
      if (!KINDS.includes(target.kind)) {
        problems.push(`${name}: target.kind ${JSON.stringify(target.kind)} is not ingredient, category or component`);
      }
      const ids = target.ids;
      if (!Array.isArray(ids) || ids.length === 0) {
        problems.push(`${name}: target.ids must be a non-empty list`);
      } else {
        for (const tid of ids) {
          if (typeof tid !== 'string' || tid === '') {
            problems.push(`${name}: target id ${JSON.stringify(tid)} is not a non-empty string`);
          } else if (!graph.has(tid)) {
            problems.push(`${name}: target id "${tid}" is not in the ingredient graph`);
          }
        }
      }
    }

    if (type === 'limit') {
      if (!isObject(limit)) {
        problems.push(`${name}: limit rule has no limit`);
      } else {
        const { amount, unit, per } = limit;
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          problems.push(`${name}: limit.amount ${JSON.stringify(amount)} must be a finite number >= 0`);
        }
        if (typeof unit !== 'string' || unit.trim() === '') {
          problems.push(`${name}: limit.unit must be a non-empty string`);
        }
        if (!PERS.includes(per)) problems.push(`${name}: limit.per ${JSON.stringify(per)} is not serving or day`);
      }
    } else if (limit !== undefined) {
      problems.push(`${name}: has a limit but is not a limit rule`);
    }

    if (phase !== undefined) {
      if (!isObject(phase)) {
        problems.push(`${name}: phase must be an object with a start date`);
      } else {
        const { start, end } = phase;
        if (!isValidDate(start)) {
          problems.push(`${name}: phase.start ${JSON.stringify(start)} is not a valid YYYY-MM-DD date`);
        }
        if (end !== undefined && !isValidDate(end)) {
          problems.push(`${name}: phase.end ${JSON.stringify(end)} is not a valid YYYY-MM-DD date`);
        }
        if (isValidDate(start) && isValidDate(end) && end < start) {
          problems.push(`${name}: phase.end "${end}" is before phase.start "${start}"`);
        }
      }
    }
  });
  return problems;
}

export function assertValidDate(date: string): void {
  if (!isValidDate(date)) throw new Error(`Invalid date ${JSON.stringify(date)}: expected a real YYYY-MM-DD date`);
}

/** Phase bounds are inclusive; ISO dates compare correctly as strings. Throws on an invalid date. */
export function isActive(rule: Rule, date: string): boolean {
  assertValidDate(date);
  const phase = rule.phase;
  if (!phase) return true;
  if (date < phase.start) return false;
  if (phase.end !== undefined && date > phase.end) return false;
  return true;
}
