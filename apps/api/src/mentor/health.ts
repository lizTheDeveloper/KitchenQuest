import { classifyTurn, mentionsHealthTerm, normalizeName, parseRuleStatement, severityFromText, type Rule } from '@kitchenquest/core';
import type { Catalog } from '../catalog.js';

/**
 * The stage-4 health predicate on text alone (pre-flight C1, fix round 1 R1):
 * a health, emergency or medical intent, any graph name, alias, rule-term
 * phrase or health word (core `mentionsHealthTerm`), any severity, or any rule
 * statement. Over-catches on purpose. The turn adds the intake step and open
 * cards; `minimiseHistory` uses it as is (I2).
 */
export function isHealthText(text: string, catalog: Catalog): boolean {
  const intent = classifyTurn(text);
  return (
    intent === 'health' ||
    intent === 'emergency' ||
    intent === 'medical' ||
    mentionsHealthTerm(text, catalog.graph, catalog.ruleTerms) ||
    severityFromText(text, catalog.graph) !== null ||
    parseRuleStatement(text, catalog.graph) !== null
  );
}

/**
 * Every word that names one of the player's rules, lower-case: each target's
 * name and aliases, every kind of it (isA descendants) and everything it is a
 * kind of (isA ancestors) with theirs, and the
 * phrases of a rule term with the same targets. R2 screens model text with them.
 */
export function ruleWords(rules: readonly Rule[], catalog: Catalog): string[] {
  const { graph } = catalog;
  const words = new Set<string>();
  for (const rule of rules) {
    const ids = rule.target.ids.filter((id) => graph.has(id));
    // Its kinds and what it is a kind of (fix round 2, R7: "there aren't any nuts in this" for a peanut rule).
    for (const id of [...ids, ...ids.flatMap((id) => graph.descendants(id)), ...ids.flatMap((id) => graph.ancestors(id))]) {
      const node = graph.get(id);
      for (const label of [node.name, ...(node.aliases ?? [])]) words.add(normalizeName(label));
    }
    const sorted = [...rule.target.ids].sort();
    for (const term of catalog.ruleTerms) {
      const t = [...term.ids].sort();
      if (t.length === sorted.length && t.every((id, i) => id === sorted[i])) for (const p of term.phrases) words.add(normalizeName(p));
    }
  }
  return [...words];
}
