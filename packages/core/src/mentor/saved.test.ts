import { expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import type { Rule } from '../rules/types';
import { buildRuleCard } from './cards';
import type { RuleTerm } from './rule-terms';
import { alreadySavedLine, stricterSaved } from './saved';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const card = (term: string, severity: 'intolerance' | 'allergy' | 'anaphylactic') => {
  const r = buildRuleCard({ term, severity }, graph, terms);
  if (!r.ok) throw new Error(term);
  return r.card;
};
const rule = (ids: string[], severity: Rule['severity'], kind: Rule['target']['kind'] = 'ingredient'): Rule => ({ id: 'r', target: { kind, ids }, type: 'avoid', severity });

test('M-5: the S13 check lives in core: a stricter saved rule (same ids, or a category over them) covers a milder card', () => {
  expect(stricterSaved(card('peanut', 'intolerance'), [rule(['peanut'], 'anaphylactic')], graph)?.severity).toBe('anaphylactic');
  expect(stricterSaved(card('peanut', 'anaphylactic'), [rule(['peanut'], 'allergy')], graph)).toBeNull();
  expect(stricterSaved(card('peanut', 'allergy'), [rule(['milk'], 'anaphylactic')], graph)).toBeNull();
  expect(alreadySavedLine(card('peanut', 'intolerance'), [rule(['peanut'], 'anaphylactic')], graph, terms)).toEqual({
    trigger: 'rule.already_saved', vars: { ingredient: 'peanut', rule: 'peanut', severity: expect.any(String) as string },
  });
});
