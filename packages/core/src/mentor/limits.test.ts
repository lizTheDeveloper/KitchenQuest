import { expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import type { RuleTerm } from './rule-terms';
import * as M from './index';

// Every exported text function caps its input at MAX_TEXT and stays linear, so a hostile
// 40k-character message can't stall the server or the client (fix round 2, R2).
const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const N = 40_000;
const fill = (unit: string, tail = '') => unit.repeat(Math.ceil(N / unit.length)).slice(0, N - tail.length) + tail;

const INPUTS: Record<string, string> = {
  spaces: fill(' '),
  a: fill('a'),
  aspace: fill('a '),
  brackets: '['.repeat(N / 2) + ']'.repeat(N / 2),
  openbr: fill('[('),
  tapped: fill('[player tapped '),
  allergic: fill('allergic to peanuts, '),
  allergicTo: fill('allergic to '),
  allergicX: fill('allergic to x, '),
  vegan: fill('vegan '),
  peanutAllergy: fill('peanut allergy '),
  allergyand: fill('peanut and '),
  commas: fill('x,'),
  ranout: fill('ran out of milk, '),
  ranoutA: 'ran out of ' + fill('a, '),
  ranoutAnd: 'ran out of ' + fill('a and '),
  nolef: 'no more ' + fill('a '),
  had: 'had ' + fill('x '),
  bought: 'bought ' + fill('a and '),
  digits: fill('1'),
  clock: fill('1:1'),
  half: fill('half '),
  player: fill('player '),
  lines: fill('a\n'),
  sys: fill('<system '),
  nested: '['.repeat(N / 2 - 3) + 'tap' + ']'.repeat(N / 2 - 3),
  manyEvents: fill('[tapped]x'),
  interleave: '<sy'.repeat(N / 16) + '</user>'.repeat(N / 16),
  words: fill('peanuts '),
  dash: fill('-'),
  apos: fill("'"),
  notall: fill('not an '),
  dots: fill('e.g. '),
  unicode: fill('ｐｅａｎｕｔ '),
  tapsent: fill('player tapped ', 'x'),
  weekdays: fill('sat x '),
  letters: fill('p '),
};

const FUNCTIONS: [string, (s: string) => unknown][] = [
  ['normalizeTurn', M.normalizeTurn],
  ['classifyTurn', M.classifyTurn],
  ['stripPageEvents', M.stripPageEvents],
  ['parseRuleStatement', M.parseRuleStatement],
  ['severityFromText', M.severityFromText],
  ['parseClock', M.parseClock],
  ['parseWeekdays', M.parseWeekdays],
  ['parseCount', M.parseCount],
  ['parsePantryRemovals', M.parsePantryRemovals],
  ['parsePantryAdds', M.parsePantryAdds],
  ['parseMealStatement', M.parseMealStatement],
  ['ruleTermsInPlayerWords', M.ruleTermsInPlayerWords],
  ['mentionsHealthTerm', (s) => M.mentionsHealthTerm(s, graph, terms)],
  ['matchDish', (s) => M.matchDish(s, [{ slug: 'a/b/c', title: 'Onigiri (rice balls)' }])],
  ['spell', M.spell],
  ['buildRuleCard', (s) => M.buildRuleCard({ term: s, severity: null }, graph, terms)],
];

test.each(FUNCTIONS)('%s finishes each 40k-character input in under 50 ms', (_name, fn) => {
  for (const [input, text] of Object.entries(INPUTS)) {
    const t0 = performance.now();
    fn(text);
    expect(performance.now() - t0, input).toBeLessThan(50);
  }
});

test('text is capped at MAX_TEXT', () => {
  expect(M.MAX_TEXT).toBe(500);
  expect(M.normalizeTurn('a'.repeat(N))).toHaveLength(M.MAX_TEXT);
  expect(M.stripPageEvents('a'.repeat(N)).text).toHaveLength(M.MAX_TEXT);
  expect(M.parseRuleStatement('x '.repeat(400) + 'allergic to peanuts')).toBeNull(); // past the cap
});
