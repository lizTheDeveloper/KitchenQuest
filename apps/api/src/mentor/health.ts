import { isHealthText as isHealthTextIn } from '@kitchenquest/core';
import type { Catalog } from '../catalog.js';

/**
 * The stage-4 health predicate on text alone (pre-flight C1, fix round 1 R1),
 * core's `isHealthText` (the client's scripted engine uses the same one): a
 * health, emergency or medical intent, any graph name, alias, rule-term
 * phrase or health word, any severity, or any rule statement. Over-catches on
 * purpose. The turn adds the intake step and open cards; `minimiseHistory`
 * uses it as is (I2).
 */
export function isHealthText(text: string, catalog: Catalog): boolean {
  return isHealthTextIn(text, catalog.graph, catalog.ruleTerms);
}
