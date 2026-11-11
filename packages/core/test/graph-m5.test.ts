// M5 Step 4 additions to data/ingredients.json: the Pantry Frame nodes (C12) and the peanut-oil aliases the margin-note
// scan needs (Step 3 N1). On the real seed graph: each new name resolves, each new node makes no allergen claim the
// data doesn't carry, and every peanut name a player might write is covered by a peanut rule.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IngredientGraph, check, parseRecipe } from '../src/index';
import type { IngredientData, Rule, Substitution } from '../src/index';
import { broadKindsAsked, buildRuleCard, checkWithNotes, noteMentions, type MarginNote, type RuleTerm } from '../src/index';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const data = readJson('data/ingredients.json') as IngredientData;
const subs = readJson('data/substitutions.json') as Substitution[];
const graph = IngredientGraph.fromData(data);
const terms = readJson('data/rule-terms.json') as RuleTerm[];

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

  it('carry no isA or unsafeFor edge, and only cooked rice a contains edge (to rice); herbs is label-dependent (fix round 1, C1)', () => {
    for (const id of Object.keys(NEW_NODES)) {
      const n = graph.get(id);
      expect(n.isA, id).toBeUndefined();
      expect(n.unsafeFor, id).toBeUndefined();
      expect(n.labelDependent, id).toBe(id === 'herb' ? true : undefined);
      expect(n.contains, id).toEqual(id === 'cooked_rice' ? ['rice'] : undefined);
      expect(graph.ancestors(id), id).toEqual([]);
    }
    // The graph's own herbs are filed under the category (C1 ruling).
    expect(graph.descendants('herb').sort()).toEqual(['curry_leaf', 'curry_leaf_sprig', 'epazote']);
    expect(graph.get('herb').broad).toBe(true);
  });

  it('each has an FDC record with values, or a source note saying why not', () => {
    for (const id of Object.keys(NEW_NODES)) {
      const n = graph.get(id);
      expect(typeof n.source, id).toBe('string');
      if (id === 'herb') expect(n.per100g).toBeUndefined();
      else {
        expect(n.fdcId, id).toEqual(expect.any(Number));
        // The data check (fix round 1): FDC 168932 declares no fibre or sugars, so none is claimed.
        const declared = id === 'cooked_rice' ? ['carb_g', 'energy_kcal', 'fat_g', 'protein_g', 'sodium_mg'] : ['carb_g', 'energy_kcal', 'fat_g', 'fiber_g', 'protein_g', 'sodium_mg', 'sugars_g'];
        expect(Object.keys(n.per100g ?? {}).sort(), id).toEqual(declared);
      }
    }
    expect(graph.get('cooked_rice').source).toMatch(/^FDC 168932 \(Rice, white, short-grain, cooked, unenriched\)/);
    expect(graph.get('peanut_oil').fdcId).toBe(171410);
  });

  it.each(Object.keys(NEW_NODES).filter((id) => id !== 'herb'))('no allergen rule blocks %s, and no sulphite-free claim is made (still a label reminder)', (id) => {
    for (const target of ALLERGENS.filter((t) => t !== 'sulphites')) expect(statusOf(graph.get(id).name, [avoid([target])]), `${id} / ${target}`).toBe('ok');
    expect(statusOf(graph.get(id).name, [avoid(['sulphites'])])).toBe('unverified');
  });

  it.each(['herbs', 'fresh herbs', 'herb'])('"%s" is ❓, never ✅, under any restricting rule: a herb could be celery leaf, chives, anything (C1)', (name) => {
    for (const target of ['celery', 'allium', 'mustard', ...ALLERGENS]) expect(statusOf(name, [avoid([target])]), `${name} / ${target}`).toBe('unverified');
    expect(statusOf(name, [])).toBe('ok');
    // Under a curry-leaf rule a "herbs" line could be curry leaves: never ✅ either.
    expect(statusOf(name, [avoid(['curry_leaf'])])).toBe('unverified');
  });

  it('"allergic to herbs" files no rule: the Pan asks which herb, naming examples (C1)', () => {
    for (const term of ['herbs', 'herb', 'fresh herbs']) {
      const r = buildRuleCard({ term, severity: 'anaphylactic' }, graph, terms);
      expect(r.ok, term).toBe(false);
      if (r.ok) continue;
      expect(r.reason).toBe('ambiguous');
      expect(r.line).toEqual({ trigger: 'rule.which_kind', vars: { term, examples: 'curry leaf, curry leaf sprig or epazote' } });
      if (r.reason === 'ambiguous') expect(r.options.map((o) => o.id)).toEqual(['curry_leaf', 'curry_leaf_sprig', 'epazote']);
    }
    // A which-kind ask accounts for its category, so no second ask follows; a plain card on a herb does not.
    expect(broadKindsAsked(['curry_leaf', 'epazote'], graph)).toEqual(['herb']);
    expect(broadKindsAsked(['peanut', 'barley'], graph)).toEqual([]);
    // A herb by name is still a rule target, and a rule on it reaches its own lines.
    const epazote = buildRuleCard({ term: 'epazote', severity: 'allergy' }, graph, terms);
    expect(epazote.ok && epazote.card.rule.target.ids).toEqual(['epazote']);
  });

  it('a rule on rice covers leftover rice; a rule on cooked rice does not reach raw rice', () => {
    expect(statusOf('leftover rice', [avoid(['rice'])])).toBe('blocked');
    expect(statusOf('short-grain white rice', [avoid(['cooked_rice'])])).toBe('ok');
  });
});

describe('peanut oil and the arachis aliases (Step 3 N1)', () => {
  const PEANUT_NAMES = ['peanut oil', 'peanut oils', 'groundnut oil', 'arachis oil', 'refined peanut oil', 'roasted peanut oil', 'cold-pressed peanut oil'];

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
