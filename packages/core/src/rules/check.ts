import type { IngredientGraph } from '../ingredients/graph';
import type { ParsedRecipe } from '../recipe/types';
import { assertValidDate, isActive, validateRules } from './active';
import { SEVERE } from './types';
import type { Rule, Severity } from './types';

export type CheckStatus = 'ok' | 'swap' | 'blocked' | 'unverified';

/**
 * A curated swap. `from` and `to` are ingredient ids. `unsafeFor` lists rule target ids for
 * which this swap must never be offered, even though `to` doesn't reach them in the graph
 * (e.g. garlic-infused oil carries garlic flavour, so it is unsafe for a garlic allergy, but it
 * has no fructans, so it still suits a low-FODMAP rule).
 */
export interface Substitution {
  from: string;
  to: string;
  note?: string;
  unsafeFor?: string[];
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

/**
 * How ingredient `id` counts as one of the rule's targets: a path through the graph, else
 * `[id, target]` when the node's `unsafeFor` lists one of the rule's exact target ids (not
 * their ancestors: garlic-infused oil is unsafe for "garlic" but fine for "fodmap_fructan"),
 * else null.
 */
function reach(graph: IngredientGraph, id: string, rule: Rule): string[] | null {
  const path = pathToAny(graph, id, rule);
  if (path) return path;
  const unsafe = graph.get(id).unsafeFor ?? [];
  const target = rule.target.ids.find((t) => unsafe.includes(t));
  return target === undefined ? null : [id, target];
}

/**
 * For a category line ("nuts" → nut) that doesn't reach the rule itself: the path
 * `[id, ..., kind, ..., target]` through the first isA descendant that does (the line could
 * be peanuts), or null. Only reverse isA is followed: "pork" can't be lard, which contains pork.
 */
function reachViaKind(graph: IngredientGraph, id: string, rule: Rule): string[] | null {
  for (const kind of graph.descendants(id)) {
    const up = reach(graph, kind, rule);
    if (up) return [...graph.pathTo(kind, id)!.reverse(), ...up.slice(1)];
  }
  return null;
}

/**
 * Limit units match case-insensitively ("G" is "g"), except that "T" (tablespoon) and "t"
 * (teaspoon) are different units by cooking convention and are never folded together.
 */
function sameUnit(a: string | null, b: string): boolean {
  if (a === null) return false;
  if (a === b) return true;
  if (a.toLowerCase() === 't') return false;
  return a.toLowerCase() === b.toLowerCase();
}

type RuleHit = { kind: 'match' | 'label'; rule: Rule; path: string[] };

/**
 * The first substitution for `fromId` whose replacement would itself produce no findings:
 * it reaches no active avoid/limit target (through the graph, its own `unsafeFor`, or an isA
 * descendant; regardless of quantity, since the swap's amount is unknown) and is not
 * label-dependent. A substitution is also skipped when any target id of a rule that hit the
 * ingredient (`hitTargets`) is in its `unsafeFor`. Like node `unsafeFor`, that list is matched
 * against exact rule target ids, not ancestry: garlic (listed) is a fructan, and matching by
 * ancestry would withhold the garlic-infused oil swap from the low-FODMAP rule it exists for.
 */
function findSwap(
  graph: IngredientGraph,
  fromId: string,
  subs: Substitution[],
  rules: Rule[],
  hitTargets: string[],
): Finding['swap'] {
  for (const sub of subs) {
    if (sub.from !== fromId) continue;
    if (sub.unsafeFor?.some((id) => hitTargets.includes(id))) continue;
    const node = graph.get(sub.to);
    if (node.labelDependent) continue;
    if (rules.some((rule) => reach(graph, sub.to, rule) !== null || reachViaKind(graph, sub.to, rule) !== null)) {
      continue;
    }
    return sub.note === undefined
      ? { toId: sub.to, toName: node.name }
      : { toId: sub.to, toName: node.name, note: sub.note };
  }
  return undefined;
}

/** Every substitution id (`from`, `to`, `unsafeFor`) missing from the graph, one problem each. */
export function validateSubstitutions(subs: Substitution[], graph: IngredientGraph): string[] {
  return subs.flatMap((sub) =>
    [sub.from, sub.to, ...(sub.unsafeFor ?? [])]
      .filter((id) => !graph.has(id))
      .map((id) => `Substitution "${sub.from}" -> "${sub.to}": "${id}" is not in the ingredient graph`),
  );
}

export function check(
  recipe: ParsedRecipe,
  rules: Rule[],
  graph: IngredientGraph,
  subs: Substitution[],
  date: string,
): CheckResult {
  assertValidDate(date);
  const problems = validateRules(rules, graph);
  if (problems.length > 0) throw new Error(`Invalid rules: ${problems.join('; ')}`);

  const badSubs = validateSubstitutions(subs, graph);
  if (badSubs.length > 0) throw new Error(`Invalid substitutions: ${badSubs.join('; ')}`);

  const active = rules.filter((rule) => isActive(rule, date));
  // per: 'day' limits need the meal log (milestone 9), so in M1 they are ignored entirely:
  // no findings, no label-dependent trigger, no part in the swap re-check.
  const restricting = active.filter(
    (rule) => rule.type === 'avoid' || (rule.type === 'limit' && rule.limit?.per === 'serving'),
  );

  const lines = recipe.ingredients.map((item) => ({ item, id: graph.resolve(item.name) }));
  // hits[k]: how the rules apply to line k, in rule order.
  const hits: RuleHit[][] = lines.map(() => []);

  for (const rule of restricting) {
    const matched: { k: number; path: string[] }[] = [];
    lines.forEach(({ id }, k) => {
      if (id === null) return;
      const path = reach(graph, id, rule);
      if (path) {
        matched.push({ k, path });
        return;
      }
      const viaKind = reachViaKind(graph, id, rule);
      if (viaKind) hits[k]!.push({ kind: 'label', rule, path: viaKind });
    });

    if (rule.type === 'avoid') {
      for (const { k, path } of matched) hits[k]!.push({ kind: 'match', rule, path });
      continue;
    }

    // Per-serving limit (validateRules guarantees rule.limit): the matching lines add up. If any
    // of them can't be measured in the limit's unit, the total is unknown: one label finding.
    const limit = rule.limit!;
    const unmeasured = matched.find(({ k }) => {
      const { quantity, unit } = lines[k]!.item;
      return quantity === null || !sameUnit(unit, limit.unit);
    });
    if (unmeasured) {
      hits[unmeasured.k]!.push({ kind: 'label', rule, path: unmeasured.path });
      continue;
    }
    const total = matched.reduce((sum, { k }) => sum + lines[k]!.item.quantity!, 0);
    if (total / recipe.meta.servings > limit.amount) {
      for (const { k, path } of matched) hits[k]!.push({ kind: 'match', rule, path });
    }
  }

  const findings: Finding[] = [];
  lines.forEach(({ item, id }, k) => {
    if (id === null) {
      findings.push({ ingredient: item.name, ingredientId: null, kind: 'unresolved', status: 'unverified' });
      return;
    }

    const lineHits = hits[k]!;
    const hitTargets = lineHits.flatMap((h) => h.rule.target.ids);
    const swap = lineHits.some((h) => h.kind === 'match')
      ? findSwap(graph, id, subs, restricting, hitTargets)
      : undefined;

    for (const hit of lineHits) {
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

    if (lineHits.length === 0 && restricting.length > 0 && graph.get(id).labelDependent) {
      findings.push({ ingredient: item.name, ingredientId: id, kind: 'label', status: 'unverified' });
    }
  });

  let status: CheckStatus = 'ok';
  for (const f of findings) if (RANK[f.status] > RANK[status]) status = f.status;

  const severe = active.some((rule) => SEVERE.has(rule.severity));
  return { status, findings, severe, disclaimer: severe ? DISCLAIMER : null };
}
