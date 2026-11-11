// M5 Step 4 additions to data/ingredients.json: the Pantry Frame nodes (C12) and the peanut-oil aliases the margin-note
// scan needs (Step 3 N1). On the real seed graph: each new name resolves, each new node makes no allergen claim the
// data doesn't carry, and every peanut name a player might write is covered by a peanut rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IngredientGraph, check, parseRecipe } from '../src/index';
import type { IngredientData, Rule, Substitution } from '../src/index';
import { checkWithNotes, noteMentions, type MarginNote } from '../src/index';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const data = readJson('data/ingredients.json') as IngredientData;
const subs = readJson('data/substitutions.json') as Substitution[];
const graph = IngredientGraph.fromData(data);

const avoid = (ids: string[], severity: Rule['severity'] = 'anaphylactic'): Rule => ({
  id: `avoid-${ids.join('-')}`,
  target: { kind: 'category', ids },
  type: 'avoid',
  severity,
});
const dish = (line: string) =>
  parseRecipe(`---
title: Graph Check
country: Testland
region: Test Region
credit: Tester
cook: Tester
difficulty: 1
skills: [stirring]
servings: 1
license: CC-BY-SA-4.0
status: draft
---

Add @${line}{50%g}.
`);
const statusOf = (name: string, rules: Rule[]) => check(dish(name), rules, graph, subs, '2026-11-10').status;

/** The EU 14 / US 9 allergen targets in the graph. */
const ALLERGENS = [
  'peanut', 'tree_nut', 'nut', 'milk', 'egg', 'gluten', 'wheat', 'soy', 'fish', 'shellfish', 'crustacean', 'mollusc',
  'sesame', 'mustard', 'celery', 'lupin', 'sulphites',
];

const NEW_NODES: Record<string, string[]> = {
  tomato: ['tomato', 'tomatoes', 'fresh tomato', 'ripe tomatoes'],
  herb: ['fresh herbs', 'herb', 'herbs', 'fresh herb'],
  spinach: ['spinach', 'fresh spinach'],
  lime: ['lime', 'limes', 'fresh lime'],
  cooked_rice: ['cooked rice', 'leftover rice', 'cold rice', 'day-old rice'],
};

describe('the Pantry Frame nodes (C12)', () => {
  it.each(Object.entries(NEW_NODES).flatMap(([id, names]) => names.map((n) => [n, id])))('"%s" resolves to %s', (name, id) => {
    expect(graph.resolve(name)).toBe(id);
  });

  it('carry no isA or unsafeFor edge, and only cooked rice a contains edge (to rice)', () => {
    for (const id of Object.keys(NEW_NODES)) {
      const n = graph.get(id);
      expect(n.isA, id).toBeUndefined();
      expect(n.unsafeFor, id).toBeUndefined();
      expect(n.labelDependent, id).toBeUndefined();
      expect(n.contains, id).toEqual(id === 'cooked_rice' ? ['rice'] : undefined);
      expect(graph.ancestors(id), id).toEqual([]);
    }
    // Nothing in the shipped graph is filed under the herbs category yet.
    expect(graph.descendants('herb')).toEqual([]);
  });

  it('each has an FDC record with values, or a source note saying why not', () => {
    for (const id of Object.keys(NEW_NODES)) {
      const n = graph.get(id);
      expect(typeof n.source, id).toBe('string');
      if (id === 'herb') expect(n.per100g).toBeUndefined();
      else {
        expect(n.fdcId, id).toEqual(expect.any(Number));
        expect(Object.keys(n.per100g ?? {}).sort(), id).toEqual(['carb_g', 'energy_kcal', 'fat_g', 'fiber_g', 'protein_g', 'sodium_mg', 'sugars_g']);
      }
    }
  });

  it.each(Object.keys(NEW_NODES))('no allergen rule blocks %s, and no sulphite-free claim is made (still a label reminder)', (id) => {
    for (const target of ALLERGENS.filter((t) => t !== 'sulphites')) expect(statusOf(graph.get(id).name, [avoid([target])]), `${id} / ${target}`).toBe('ok');
    expect(statusOf(graph.get(id).name, [avoid(['sulphites'])])).toBe('unverified');
  });

  it('a rule on rice covers leftover rice; a rule on cooked rice does not reach raw rice', () => {
    expect(statusOf('leftover rice', [avoid(['rice'])])).toBe('blocked');
    expect(statusOf('short-grain white rice', [avoid(['cooked_rice'])])).toBe('ok');
  });
});

describe('peanut oil and the arachis aliases (Step 3 N1)', () => {
  const PEANUT_NAMES = ['peanut oil', 'peanut oils', 'groundnut oil', 'arachis oil'];

  it('"arachis" is peanut; every peanut-oil name is peanut oil, which contains peanut', () => {
    expect(graph.resolve('arachis')).toBe('peanut');
    expect(graph.resolve('groundnut')).toBe('peanut');
    for (const name of PEANUT_NAMES) expect(graph.resolve(name), name).toBe('peanut_oil');
    expect(graph.get('peanut_oil').contains).toEqual(['peanut']);
  });

  it.each([...PEANUT_NAMES, 'arachis', 'groundnuts'])('a peanut rule, and a nut rule, block a dish with %s', (name) => {
    expect(statusOf(name, [avoid(['peanut'])])).toBe('blocked');
    expect(statusOf(name, [avoid(['nut'])])).toBe('blocked');
  });

  it('a tree-nut rule does not block peanut oil (a peanut is a legume, not a tree nut)', () => {
    expect(statusOf('peanut oil', [avoid(['tree_nut'])])).toBe('ok');
  });

  it('"PB" stays unresolved: too ambiguous to read as peanut butter', () => {
    expect(graph.resolve('PB')).toBeNull();
    expect(graph.resolve('pb')).toBeNull();
  });

  it('a margin note naming arachis or groundnut oil, read or not, makes "cook with my notes" ⛔ for a peanut rule', () => {
    const recipe = dish('short-grain white rice');
    const note = (text: string): MarginNote => ({ recipe: 'x/y/z', ops: [], text, at: '2026-11-10' });
    for (const text of ['fried it in arachis oil', 'a splash of groundnut oil at the end', 'topped with crushed arachis']) {
      expect(noteMentions([note(text)], graph).some((id) => id === 'peanut' || id === 'peanut_oil'), text).toBe(true);
      expect(checkWithNotes(recipe, [note(text)], [avoid(['peanut'])], graph, subs, '2026-11-10').status, text).toBe('blocked');
    }
  });
});
