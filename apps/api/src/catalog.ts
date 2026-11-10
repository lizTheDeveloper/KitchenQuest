import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IngredientGraph,
  validateRuleTerms,
  validateSubstitutions,
  type IngredientData,
  type RuleTerm,
  type Substitution,
} from '@kitchenquest/core';

/** The shared safety data: the ingredient graph, and the substitutions and rule terms checked against it. */
export interface Catalog {
  graph: IngredientGraph;
  substitutions: readonly Substitution[];
  /** `rule-terms.json` (pre-flight C7): words such as "vegetarian" that name a rule, not one ingredient. */
  ruleTerms: readonly RuleTerm[];
}

/** The repository's `data/` directory. */
const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Catalog: cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Catalog: ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Loads `ingredients.json`, `substitutions.json` and `rule-terms.json` from
 * `dir`, builds the graph and checks every substitution and rule term against it. Throws, naming the file and the
 * problem, on anything wrong: the server must not start on bad safety data.
 */
export function loadCatalog(dir: string = DATA_DIR): Catalog {
  const ingredients = readJson(dir, 'ingredients.json') as IngredientData;
  if (typeof ingredients !== 'object' || ingredients === null || !Array.isArray(ingredients.ingredients)) {
    throw new Error(`Catalog: ${join(dir, 'ingredients.json')} must be an object with an "ingredients" array`);
  }
  let graph: IngredientGraph;
  try {
    graph = IngredientGraph.fromData(ingredients);
  } catch (e) {
    throw new Error(`Catalog: ${join(dir, 'ingredients.json')}: ${(e as Error).message}`);
  }
  const substitutions = readJson(dir, 'substitutions.json');
  if (!Array.isArray(substitutions)) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')} must be an array`);
  }
  if (!substitutions.every((s) => typeof s === 'object' && s !== null && !Array.isArray(s))) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')} must hold only objects`);
  }
  const problems = validateSubstitutions(substitutions as Substitution[], graph);
  if (problems.length > 0) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')}: ${problems.join('; ')}`);
  }
  const ruleTerms = readJson(dir, 'rule-terms.json');
  const termProblems = validateRuleTerms(ruleTerms, graph);
  if (termProblems.length > 0) {
    throw new Error(`Catalog: ${join(dir, 'rule-terms.json')}: ${termProblems.join('; ')}`);
  }
  return {
    graph,
    substitutions: Object.freeze([...(substitutions as Substitution[])]),
    ruleTerms: Object.freeze([...(ruleTerms as RuleTerm[])]),
  };
}

let loaded: Catalog | undefined;

/** The catalog from `DATA_DIR`, loaded on first use (at boot, from buildApp) and shared after. */
export function defaultCatalog(): Catalog {
  loaded ??= loadCatalog();
  return loaded;
}
