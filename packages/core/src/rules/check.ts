import type { IngredientGraph } from '../ingredients/graph';
import type { ParsedRecipe, RecipeIngredient } from '../recipe/types';
import { isActive, validateRules } from './active';
import { SEVERE } from './types';
import type { Rule, Severity } from './types';

export type CheckStatus = 'ok' | 'swap' | 'blocked' | 'unverified';

/** `from` and `to` are ingredient ids. */
export interface Substitution {
  from: string;
  to: string;
  note?: string;
}

export interface Finding {
  ingredient: string; // name as written in the recipe
  ingredientId: string | null;
  kind: 'match' | 'unresolved' | 'label';
  status: Exclude<CheckStatus, 'ok'>;
  ruleId?: string;
  severity?: Severity;
  path?: string[]; // e.g. ['worcestershire','anchovy','fish']
  swap?: { toId: string; toName: string; note?: string };
}

export interface CheckResult {
  status: CheckStatus;
  findings: Finding[];
  severe: boolean;
  disclaimer: string | null;
}

export const DISCLAIMER =
  "Kitchen Quest can't guarantee a dish is safe for your allergy. Always check labels.";

const RANK: Record<CheckStatus, number> = { ok: 0, swap: 1, unverified: 2, blocked: 3 };

/** The first path from `id` to any of the rule's targets, or null. */
function pathToAny(graph: IngredientGraph, id: string, rule: Rule): string[] | null {
  for (const target of rule.target.ids) {
    const path = graph.pathTo(id, target);
    if (path) return path;
  }
  return null;
}

type RuleHit = { kind: 'match' | 'label'; rule: Rule; path: string[] };

/** How one avoid/limit rule applies to one recipe ingredient, or null if it doesn't. */
function evaluate(
  graph: IngredientGraph,
  id: string,
  item: RecipeIngredient,
  servings: number,
  rule: Rule,
): RuleHit | null {
  const path = pathToAny(graph, id, rule);
  if (!path) return null;
  if (rule.type === 'avoid') return { kind: 'match', rule, path };

  // limit: validateRules guarantees rule.limit exists. Only per-serving limits reach here.
  const limit = rule.limit!;
  if (item.quantity === null || item.unit !== limit.unit) return { kind: 'label', rule, path };
  return item.quantity / servings > limit.amount ? { kind: 'match', rule, path } : null;
}

/**
 * The first substitution for `fromId` whose replacement would itself produce no findings:
 * it reaches no active avoid/limit target (regardless of quantity, since the swap's amount
 * is unknown) and is not label-dependent.
 */
function findSwap(
  graph: IngredientGraph,
  fromId: string,
  subs: Substitution[],
  rules: Rule[],
): Finding['swap'] {
  for (const sub of subs) {
    if (sub.from !== fromId) continue;
    const node = graph.get(sub.to);
    if (node.labelDependent) continue;
    if (rules.some((rule) => pathToAny(graph, sub.to, rule) !== null)) continue;
    return sub.note === undefined
      ? { toId: sub.to, toName: node.name }
      : { toId: sub.to, toName: node.name, note: sub.note };
  }
  return undefined;
}

export function check(
  recipe: ParsedRecipe,
  rules: Rule[],
  graph: IngredientGraph,
  subs: Substitution[],
  date: string,
): CheckResult {
  const problems = validateRules(rules, graph);
  if (problems.length > 0) throw new Error(`Invalid rules: ${problems.join('; ')}`);

  const badSubs = subs.flatMap((sub) =>
    [sub.from, sub.to]
      .filter((id) => !graph.has(id))
      .map((id) => `Substitution "${sub.from}" -> "${sub.to}": "${id}" is not in the ingredient graph`),
  );
  if (badSubs.length > 0) throw new Error(`Invalid substitutions: ${badSubs.join('; ')}`);

  const active = rules.filter((rule) => isActive(rule, date));
  // per: 'day' limits need the meal log (milestone 9), so in M1 they are ignored entirely:
  // no findings, no label-dependent trigger, no part in the swap re-check.
  const restricting = active.filter(
    (rule) => rule.type === 'avoid' || (rule.type === 'limit' && rule.limit?.per === 'serving'),
  );
  const findings: Finding[] = [];

  for (const item of recipe.ingredients) {
    const id = graph.resolve(item.name);
    if (id === null) {
      findings.push({ ingredient: item.name, ingredientId: null, kind: 'unresolved', status: 'unverified' });
      continue;
    }

    const hits = restricting
      .map((rule) => evaluate(graph, id, item, recipe.meta.servings, rule))
      .filter((hit): hit is RuleHit => hit !== null);

    const swap = hits.some((h) => h.kind === 'match') ? findSwap(graph, id, subs, restricting) : undefined;

    for (const hit of hits) {
      const finding: Finding = {
        ingredient: item.name,
        ingredientId: id,
        kind: hit.kind,
        status: hit.kind === 'label' ? 'unverified' : swap ? 'swap' : 'blocked',
        ruleId: hit.rule.id,
        severity: hit.rule.severity,
        path: hit.path,
      };
      if (hit.kind === 'match' && swap) finding.swap = swap;
      findings.push(finding);
    }

    if (hits.length === 0 && restricting.length > 0 && graph.get(id).labelDependent) {
      findings.push({ ingredient: item.name, ingredientId: id, kind: 'label', status: 'unverified' });
    }
  }

  let status: CheckStatus = 'ok';
  for (const f of findings) if (RANK[f.status] > RANK[status]) status = f.status;

  const severe = active.some((rule) => SEVERE.has(rule.severity));
  return { status, findings, severe, disclaimer: severe ? DISCLAIMER : null };
}
