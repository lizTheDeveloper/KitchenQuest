// M7 §7.6b.8: the scripted filler line said while a turn runs. A turn shaped like a write (a meal, a pantry change, a
// rule statement, a market check-off) gets the ledger line ("Let me write that in the ledger…"); anything else the
// thinking line. Only the line differs: the filler never decides what the turn does. Browser-safe.
import { IngredientGraph } from '../ingredients/graph';
import { checkOffShaped } from '../mentor/check-off';
import { normalizeTurn } from '../mentor/intents';
import { MEAL_VERB_PATTERN, PANTRY_ADD_PATTERN, PANTRY_REMOVAL_PATTERNS, RULE_TRIGGER_PATTERN } from '../mentor/parse';
import type { RuleTerm } from '../mentor/rule-terms';

const NO_FOODS = IngredientGraph.fromData({ ingredients: [] });

/**
 * `voice.filler.ledger` for a meal verb, a pantry add or removal, a rule trigger or a check-off-shaped turn, else
 * `voice.filler.thinking`. The graph and terms only sharpen the check-off test; without them it reads the shape alone.
 */
export function fillerFor(
  transcript: string,
  graph: IngredientGraph = NO_FOODS,
  terms: readonly RuleTerm[] = [],
): 'voice.filler.ledger' | 'voice.filler.thinking' {
  const t = normalizeTurn(transcript);
  const ledger =
    MEAL_VERB_PATTERN.test(t) ||
    t.search(PANTRY_ADD_PATTERN) >= 0 ||
    PANTRY_REMOVAL_PATTERNS.some((p) => t.search(p) >= 0) ||
    t.search(RULE_TRIGGER_PATTERN) >= 0 ||
    checkOffShaped(transcript, graph, terms);
  return ledger ? 'voice.filler.ledger' : 'voice.filler.thinking';
}
