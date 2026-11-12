import { describe, expect, it } from 'vitest';
import keeps from '../../../../data/keeps.json';
import stalls from '../../../../data/stalls.json';
import foodGroups from '../../../../data/food-groups.json';
import { validateFoodGroups, validateKeeps, validateStallMap } from './data';
import { STALL_IDS, stallFor, type StallMap } from './market-list';
import { graph } from './fixtures';

const MARKET = new Set(STALL_IDS);

describe('the shipped week data', () => {
  it('passes its checks', () => {
    expect(validateKeeps(keeps, graph)).toEqual([]);
    expect(validateStallMap(stalls, graph, MARKET)).toEqual([]);
    expect(validateFoodGroups(foodGroups, graph)).toEqual([]);
  });

  it('keeps the frame rescues and the plan says how long: herb, tomato, spinach and cooked rice, cooked rice a day', () => {
    for (const id of ['herb', 'tomato', 'spinach', 'cooked_rice']) expect(keeps, id).toHaveProperty(id);
    expect((keeps as Record<string, number>).cooked_rice).toBe(1);
  });

  it('sends produce to Wen, tortillas to Okafor-Sato, celery seed to the Spice Merchant and milk to the general stall', () => {
    expect(stallFor('onion', graph, stalls as StallMap)).toBe('wen');
    expect(stallFor('corn_tortilla', graph, stalls as StallMap)).toBe('okafor-sato');
    expect(stallFor('celery_seed', graph, stalls as StallMap)).toBe('spice');
    expect(stallFor('milk', graph, stalls as StallMap)).toBe('general');
  });
});

describe('validateKeeps, validateStallMap, validateFoodGroups', () => {
  it('name an id missing from the graph, a bad value and a non-mapping', () => {
    expect(validateKeeps({ samphire: 3 }, graph)).toEqual(['keeps: "samphire" is not an ingredient id in the graph']);
    expect(validateKeeps({ tomato: 0, spinach: 2.5, herb: '4', lime: 400 }, graph)).toEqual([
      'keeps: "tomato" must keep a whole number of days from 1 to 365',
      'keeps: "spinach" must keep a whole number of days from 1 to 365',
      'keeps: "herb" must keep a whole number of days from 1 to 365',
      'keeps: "lime" must keep a whole number of days from 1 to 365',
    ]);
    expect(validateKeeps([], graph)).toEqual(['keeps must be a mapping of ingredient id to value']);
    expect(validateStallMap({ milk: 'dairy' }, graph, MARKET)).toEqual(['stalls: "milk" names "dairy", which is not a stall (wen, bram, okafor-sato, spice, general)']);
    expect(validateStallMap({ milk: 'general' }, graph, new Set(['wen']))).toEqual(['stalls: "milk" names "general", which is not a stall (wen)']);
    expect(validateFoodGroups({ rice: 'carbs', ghost: 'grain' }, graph)).toEqual([
      'food-groups: "rice" names "carbs", which is not a food group (veg_fruit, protein, grain)',
      'food-groups: "ghost" is not an ingredient id in the graph',
    ]);
  });
});
