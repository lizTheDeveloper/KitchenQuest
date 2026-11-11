import { describe, expect, test } from 'vitest';
import { validateTechniques, type TechniqueNode } from './techniques';

const node = (id: string, adjacent: string[] = [], prereqs: string[] = []): TechniqueNode => ({ id, name: id, adjacent, prereqs });

describe('validateTechniques', () => {
  test('validateTechniques: unknown id in adjacent or prereqs, a self-reference, a prereqs cycle → problems; the shipped file → none', () => {
    // The shipped data/techniques.yaml is checked in packages/core/test/progress-data.test.ts (it needs the file system).
    expect(validateTechniques([node('a', ['b']), node('b', [], ['a'])])).toEqual([]);
    expect(validateTechniques([node('a', ['zz'])])).toEqual(['technique "a": adjacent names unknown technique "zz"']);
    expect(validateTechniques([node('a', [], ['zz'])])).toEqual(['technique "a": prereqs names unknown technique "zz"']);
    expect(validateTechniques([node('a', ['a'])])).toEqual(['technique "a": adjacent names itself']);
    expect(validateTechniques([node('a', [], ['a'])])).toEqual(['technique "a": prereqs names itself']);
    expect(validateTechniques([node('a', [], ['b']), node('b', [], ['c']), node('c', [], ['a'])])).toEqual(['prereqs cycle: a → b → c → a']);
    // Adjacency may loop (it is a suggestion graph, not an order).
    expect(validateTechniques([node('a', ['b']), node('b', ['a'])])).toEqual([]);
  });

  test('shape problems and duplicates', () => {
    expect(validateTechniques('nope')).toEqual(['techniques must be a list']);
    expect(validateTechniques([{ name: 'x', adjacent: [], prereqs: [] }])).toEqual(['technique 0: needs an id']);
    expect(validateTechniques([node('a'), node('a')])).toEqual(['technique "a": duplicate id']);
    expect(validateTechniques([{ id: 'a', name: 'A' }])).toEqual(['technique "a": adjacent must be a list of technique ids', 'technique "a": prereqs must be a list of technique ids']);
    expect(validateTechniques([{ id: 'a', name: '', adjacent: [3], prereqs: [] }])).toEqual(['technique "a": needs a name', 'technique "a": adjacent must be a list of technique ids']);
  });
});
