// M7 Step 1 (Ruling 4, D2): phonetic keys and the sound-alikes the heard card offers.
import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import type { RuleTerm } from '../mentor/rule-terms';
import { MAX_ALTERNATIVES } from './constants';
import { editDistance, KNOWN_CONFUSIONS, phoneticKey, soundAlikes } from './phonetic';

const graph = IngredientGraph.fromData(ingredients);
const terms = ruleTerms as RuleTerm[];
const ids = (word: string) => soundAlikes(word, graph, terms).map((a) => a.id);

describe('phoneticKey', () => {
  test('"mussels"/"muscles", "celery"/"salary", "pecans"/"pea cans" are within one edit', () => {
    const pairs: [string, string][] = [
      ['mussels', 'muscles'],
      ['celery', 'salary'],
      ['pecans', 'pea cans'],
    ];
    for (const [a, b] of pairs) expect(editDistance(phoneticKey(a), phoneticKey(b)), `${a}/${b}`).toBeLessThanOrEqual(1);
  });

  test('accents and marks drop (NFKD), case and non-letters are ignored, and unlike words stay apart', () => {
    expect(phoneticKey('Jalapeño')).toBe(phoneticKey('jalapeno'));
    expect(phoneticKey('SESAME!')).toBe(phoneticKey('sesame'));
    expect(phoneticKey('')).toBe('');
    expect(phoneticKey('123')).toBe('');
    expect(editDistance(phoneticKey('peanut'), phoneticKey('lemon'))).toBeGreaterThan(1);
    expect(editDistance(phoneticKey('shellfish'), phoneticKey('pasta'))).toBeGreaterThan(1);
  });

  test('editDistance is Levenshtein', () => {
    expect(editDistance('', '')).toBe(0);
    expect(editDistance('abc', '')).toBe(3);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('MSLS', 'MSKLS')).toBe(1);
  });
});

describe('soundAlikes', () => {
  test('offers the food a misheard word sounds like, never the word itself, at most MAX_ALTERNATIVES', () => {
    expect(ids('selfish')).toContain('shellfish');
    expect(ids('salary')).toContain('celery');
    expect(ids('rice')).toContain('rye');
    expect(ids('rice')).not.toContain('rice_grain');
    for (const w of ['rice', 'nots', 'peas', 'coming', 'leak']) expect(ids(w).length, w).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    expect(soundAlikes('rice', graph, terms, 1)).toHaveLength(1);
    expect(soundAlikes('', graph, terms)).toEqual([]);
    // names come from the graph, never from the heard word
    for (const a of soundAlikes('selfish', graph, terms)) if (graph.has(a.id)) expect(a.name).toBe(graph.get(a.id).name);
  });

  test('every KNOWN_CONFUSIONS entry names a graph id and is always offered for its heard word', () => {
    for (const c of KNOWN_CONFUSIONS) {
      expect(graph.has(c.id), c.id).toBe(true);
      expect(ids(c.heard), c.heard).toContain(c.id);
    }
  });
});
