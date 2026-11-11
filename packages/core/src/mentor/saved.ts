import type { IngredientGraph } from '../ingredients/graph';
import type { Rule, Severity } from '../rules/types';
import { SEVERITY_WORDS, type LineRef, type RuleCard } from './cards';
import type { RuleTerm } from './rule-terms';

/**
 * The Step 12 S13 ruling ("never a rule card below the saved rule"), in core so the server agent and the client's
 * scripted engine and intake decide it the same way (M4 final M-5, pre-flight C14).
 */
const SEVERITY_RANK: Readonly<Record<Severity, number>> = { preference: 0, intolerance: 1, allergy: 2, anaphylactic: 3 };

const sameIds = (a: readonly string[], b: readonly string[]) => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/**
 * A saved rule's name as the Rules screen shows it (apps/game/src/rules/rules-screen.ts `ruleName`): a rule term's
 * name with its targets, or the ledger names of its targets.
 */
export function savedRuleName(rule: Pick<Rule, 'target'>, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): string {
  const term = ruleTerms.find((t) => sameIds(t.ids, rule.target.ids));
  const names = rule.target.ids.map((id) => (graph.has(id) ? graph.get(id).name : id));
  return term ? `${term.name} (${names.join(', ')})` : names.join(', ');
}

/**
 * The player's saved avoid rule that covers every target of `card` (the same ids, or a saved category they are
 * kinds of) at a STRICTER severity than the card's, or null. Such a card is never offered: it would read back a
 * milder level than the one on file.
 */
export function stricterSaved(card: RuleCard, saved: readonly Rule[], graph: IngredientGraph): Rule | null {
  const covers = (r: Rule, id: string) => r.target.ids.includes(id) || r.target.ids.some((s) => graph.has(s) && graph.descendants(s).includes(id));
  return (
    saved
      .filter((r) => r.type === 'avoid' && r.phase === undefined && card.rule.target.ids.every((id) => covers(r, id)))
      .filter((r) => SEVERITY_RANK[r.severity] > SEVERITY_RANK[card.rule.severity])
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])[0] ?? null
  );
}

/** `rule.already_saved` for a card a stricter saved rule already covers (offer nothing then), or null. */
export function alreadySavedLine(card: RuleCard, saved: readonly Rule[], graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): LineRef | null {
  const stricter = stricterSaved(card, saved, graph);
  if (stricter === null) return null;
  return {
    trigger: 'rule.already_saved',
    vars: { ingredient: card.display.ingredient, rule: savedRuleName(stricter, graph, ruleTerms), severity: SEVERITY_WORDS[stricter.severity] },
  };
}
