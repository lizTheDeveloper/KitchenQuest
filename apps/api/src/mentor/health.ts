import { classifyTurn, mentionsHealthTerm, parseRuleStatement, severityFromText } from '@kitchenquest/core';
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

