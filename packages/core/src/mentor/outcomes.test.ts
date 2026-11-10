import { expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { buildMealCard, buildPantryCard, buildProfileCard, buildRuleCard, type RuleCard } from './cards';
import { confirmedLines, listWords, rejectedLine, trailSummary, undoneLine, UNDO_WINDOW_MS } from './outcomes';
import type { RuleTerm } from './rule-terms';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const rule = (term: string, severity: 'allergy' | 'intolerance'): RuleCard => {
  const r = buildRuleCard({ term, severity }, graph, terms);
  if (!r.ok) throw new Error(term);
  return r.card;
};

test('UNDO_WINDOW_MS is five minutes', () => expect(UNDO_WINDOW_MS).toBe(300_000));

test('listWords', () => {
  expect(listWords([])).toBe('');
  expect(listWords(['a'])).toBe('a');
  expect(listWords(['a', 'b', 'c'])).toBe('a, b and c');
});

test('confirmedLines per kind', () => {
  expect(confirmedLines(rule('sesame', 'allergy')).map((l) => l.trigger)).toEqual(['rule.stamped', 'rule.severe_label_reminder']);
  expect(confirmedLines(rule('milk', 'intolerance'))).toEqual([{ trigger: 'rule.stamped', vars: { ingredient: 'milk' } }]);
  const meal = buildMealCard({ eatenOn: '2026-11-10', slot: 'snack', description: 'toast' });
  expect(confirmedLines(meal)).toEqual([{ trigger: 'log.logged', vars: { meal: 'a snack' } }, { trigger: 'log.estimate_note', vars: {} }]);
  const profile = buildProfileCard({ marketDays: [6] });
  expect(confirmedLines(profile)).toEqual([{ trigger: 'schedule.set', vars: { summary: profile.summary } }]);
  const pantry = buildPantryCard({ add: ['rice'], remove: ['milk'] }, graph);
  expect(confirmedLines(pantry, ['milk', 'milk']).map((l) => [l.trigger, l.vars.items])).toEqual([['pantry.added', 'rice'], ['pantry.removed', 'milk']]);
  expect(confirmedLines(buildPantryCard({ add: [], remove: ['milk'] }, graph), [])).toEqual([{ trigger: 'pantry.not_found', vars: { items: 'milk' } }]);
});

test('rejected and undone lines, trail summary', () => {
  expect(rejectedLine('rule').trigger).toBe('rule.not_quite');
  expect(rejectedLine('pantry').trigger).toBe('card.rejected');
  const r = rule('sesame', 'allergy');
  expect(undoneLine(r)).toEqual({ trigger: 'rule.voided', vars: { ingredient: 'sesame' } });
  expect(undoneLine(buildProfileCard({ marketDays: [6] })).trigger).toBe('undo');
  expect(trailSummary(r)).toBe('sesame, an allergy');
});
