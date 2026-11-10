import { expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import committed from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import { validateRuleTerms, type RuleTerm } from './rule-terms';

const graph = IngredientGraph.fromData(ingredients);
const [veg, vegan] = committed as RuleTerm[];

test.each([
  ['an id not in the graph', [{ ...veg, ids: ['tofu_skin'] }], /tofu_skin/],
  ['a phrase in two terms', [veg, { ...vegan, phrases: ['Veggie'] }], /veggie/],
  ['a bad form', [{ ...veg, form: 'rule_x' }], /form/],
  ['a bad severity', [{ ...veg, severity: 'mild' }], /severity/],
  ['a missing name', [{ ...veg, name: '' }], /name/],
  ['empty phrases', [{ ...veg, phrases: [] }], /phrases/],
  ['empty ids', [{ ...veg, ids: [] }], /ids/],
  ['a non-object entry', [veg, 7], /2/],
])('validateRuleTerms rejects %s', (_n, data, re) => expect(validateRuleTerms(data, graph).join('\n')).toMatch(re));

test('validateRuleTerms rejects a non-array', () => {
  expect(validateRuleTerms({ terms: [] }, graph)).toEqual([expect.stringMatching(/array/)]);
});

test('problems name the term', () => {
  expect(validateRuleTerms([{ ...veg, ids: ['tofu_skin'] }], graph)).toEqual([expect.stringMatching(/vegetarian/)]);
});

test('the committed data/rule-terms.json is valid', () => expect(validateRuleTerms(committed, graph)).toEqual([]));

test('diet terms are never narrower than the word (§2.2)', () => {
  const byName = new Map((committed as RuleTerm[]).map((t) => [t.name, t]));
  expect(byName.get('vegan')!.ids).toEqual(expect.arrayContaining(['meat', 'fish', 'shellfish', 'milk', 'egg', 'honey', 'gelatin']));
  expect(byName.get('vegetarian')!.ids).toEqual(expect.arrayContaining(['meat', 'fish', 'shellfish', 'gelatin']));
  expect(byName.get('pescatarian')!.ids).toEqual(expect.arrayContaining(['meat', 'gelatin']));
  // Whey and casein are milk, so a milk target catches them; gelatine counts as meat, pork and fish.
  for (const id of ['whey', 'casein']) expect(graph.pathTo(id, 'milk'), id).not.toBeNull();
  expect(graph.get('gelatin').unsafeFor).toEqual(expect.arrayContaining(['meat', 'pork', 'fish']));
  for (const word of ['halal', 'kosher', 'jain']) {
    expect([...byName.values()].some((t) => t.phrases.includes(word)), word).toBe(false);
  }
});
