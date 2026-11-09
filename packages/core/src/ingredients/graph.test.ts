import { describe, expect, it } from 'vitest';
import { IngredientGraph } from './graph';
import type { IngredientNode } from './types';

const fixture: IngredientNode[] = [
  { id: 'green_onion', name: 'green onion', aliases: ['scallion', 'spring onion'] },
  { id: 'tomato', name: 'tomato' },
  { id: 'olive', name: 'olive' },
  { id: 'cashew', name: 'cashew', isA: ['tree_nut'] },
  { id: 'tree_nut', name: 'tree nut', isA: ['nut'] },
  { id: 'nut', name: 'nut' },
  { id: 'wheat', name: 'wheat' },
  { id: 'soy', name: 'soy' },
  { id: 'soy_sauce', name: 'soy sauce', contains: ['wheat', 'soy'], labelDependent: true },
  { id: 'worcestershire', name: 'worcestershire sauce', contains: ['anchovy'] },
  { id: 'anchovy', name: 'anchovy', isA: ['fish'] },
  { id: 'fish', name: 'fish' },
];

const graph = IngredientGraph.fromData({ ingredients: fixture });

describe('IngredientGraph', () => {
  it('resolves names people actually write', () => {
    expect(graph.resolve('Spring Onions ')).toBe('green_onion');
    expect(graph.resolve('SCALLION')).toBe('green_onion');
    expect(graph.resolve('green onions')).toBe('green_onion');
    expect(graph.resolve('  Soy   Sauce ')).toBe('soy_sauce');
    expect(graph.resolve('tomatoes')).toBe('tomato');
    expect(graph.resolve('olives')).toBe('olive');
    expect(graph.resolve('dragon fruit')).toBeNull();
    expect(graph.resolve('')).toBeNull();
  });

  it('gets and checks ids', () => {
    expect(graph.has('cashew')).toBe(true);
    expect(graph.has('nope')).toBe(false);
    expect(graph.get('cashew').name).toBe('cashew');
    expect(() => graph.get('nope')).toThrow(/nope/);
  });

  it('finds paths through isA and contains', () => {
    expect(graph.pathTo('cashew', 'nut')).toEqual(['cashew', 'tree_nut', 'nut']);
    expect(graph.pathTo('worcestershire', 'fish')).toEqual(['worcestershire', 'anchovy', 'fish']);
    expect(graph.pathTo('cashew', 'fish')).toBeNull();
    expect(graph.pathTo('soy_sauce', 'soy_sauce')).toEqual(['soy_sauce']);
    expect(graph.pathTo('soy_sauce', 'soy')).toEqual(['soy_sauce', 'soy']);
  });

  it('fails loudly on bad data', () => {
    const build = (ingredients: IngredientNode[]) => () => IngredientGraph.fromData({ ingredients });
    expect(
      build([
        { id: 'a', name: 'a', isA: ['b'] },
        { id: 'b', name: 'b', isA: ['a'] },
      ]),
    ).toThrow(/cycle.*\ba\b/);
    expect(build([{ id: 'a', name: 'a', contains: ['a'] }])).toThrow(/cycle/);
    expect(build([{ id: 'a', name: 'a', isA: ['ghost'] }])).toThrow(/ghost/);
    expect(build([{ id: 'a', name: 'a', contains: ['ghost'] }])).toThrow(/ghost/);
    expect(
      build([
        { id: 'a', name: 'a', aliases: ['shared'] },
        { id: 'b', name: 'b', aliases: ['Shared '] },
      ]),
    ).toThrow(/shared/);
    expect(
      build([
        { id: 'a', name: 'a' },
        { id: 'a', name: 'other' },
      ]),
    ).toThrow(/duplicate.*\ba\b/);
  });
});
