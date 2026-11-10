import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { Severity } from '../rules/types';

/**
 * A word that names a rule but not one ingredient ("vegetarian", "coeliac", "no pork"), from
 * data/rule-terms.json. `ids` must cover everything the word excludes: a term is never
 * narrower than the word (spec §2.2). A word one target can't express (halal, kosher, Jain) is
 * left out, so it resolves to `rule.unknown_term` or options, never a partial rule.
 */
export interface RuleTerm {
  phrases: string[];
  name: string;
  ids: string[];
  severity: Severity | null;
  form: 'rule_allergen' | 'rule_intolerance' | 'rule_diet';
}

const SEVERITIES: readonly unknown[] = ['anaphylactic', 'allergy', 'intolerance', 'preference'];
const FORMS: readonly unknown[] = ['rule_allergen', 'rule_intolerance', 'rule_diet'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmptyStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.trim() !== '');

/** Every problem with untyped rule-term data, each naming the term. Empty when it is valid. */
export function validateRuleTerms(terms: unknown, graph: IngredientGraph): string[] {
  if (!Array.isArray(terms)) return ['Rule terms: must be an array'];
  const problems: string[] = [];
  const owners = new Map<string, string>();
  terms.forEach((term: unknown, index) => {
    if (!isObject(term)) {
      problems.push(`Rule term ${index + 1}: is not an object`);
      return;
    }
    const { name, phrases, ids, severity, form } = term;
    let label: string;
    if (typeof name !== 'string' || name.trim() === '') {
      label = `Rule term ${index + 1}`;
      problems.push(`${label}: name must be a non-empty string`);
    } else {
      label = `Rule term "${name}"`;
    }

    if (!nonEmptyStrings(phrases)) {
      problems.push(`${label}: phrases must be a non-empty list of non-empty strings`);
    } else {
      for (const phrase of phrases) {
        const key = normalizeName(phrase);
        const owner = owners.get(key);
        if (owner !== undefined && owner !== label) problems.push(`${label}: phrase "${key}" is also used by ${owner}`);
        owners.set(key, label);
      }
    }

    if (!nonEmptyStrings(ids)) {
      problems.push(`${label}: ids must be a non-empty list of non-empty strings`);
    } else {
      for (const id of ids) if (!graph.has(id)) problems.push(`${label}: id "${id}" is not in the ingredient graph`);
    }

    if (severity !== null && !SEVERITIES.includes(severity)) {
      problems.push(`${label}: severity ${JSON.stringify(severity)} is not anaphylactic, allergy, intolerance, preference or null`);
    }
    if (!FORMS.includes(form)) {
      problems.push(`${label}: form ${JSON.stringify(form)} is not rule_allergen, rule_intolerance or rule_diet`);
    }
  });
  return problems;
}
