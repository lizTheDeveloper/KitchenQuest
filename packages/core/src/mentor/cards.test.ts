import { describe, expect, test } from 'vitest';
import ingredients from '../../../../data/ingredients.json';
import ruleTerms from '../../../../data/rule-terms.json';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientData } from '../ingredients/types';
import { validateRules } from '../rules/active';
import {
  buildMealCard,
  buildPantryCard,
  buildProfileCard,
  buildRuleCard,
  isSevereCard,
  MEAL_DESCRIPTION_MAX,
  SEVERITY_WORDS,
  withSeverity,
  type RuleCard,
} from './cards';
import type { RuleTerm } from './rule-terms';

const data = ingredients as IngredientData;
const graph = IngredientGraph.fromData(data);
const terms = ruleTerms as RuleTerm[];

const card = (term: string, severity: RuleCard['rule']['severity'] | null = null): RuleCard => {
  const r = buildRuleCard({ term, severity }, graph, terms);
  if (!r.ok) throw new Error(`${term}: ${r.reason}`);
  return r.card;
};

describe('buildRuleCard', () => {
  test('severe peanut card spells, covers, and reads back from code', () => {
    const r = buildRuleCard({ term: 'peanuts', severity: 'anaphylactic' }, graph, terms);
    expect(r.ok && r.card).toMatchObject({
      severe: true,
      severityUnclear: false,
      form: 'rule_allergen',
      display: { ingredient: 'peanut', spelled: 'P-E-A-N-U-T', severity: 'a severe allergy', covers: 'peanut' },
      rule: { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' },
    });
    expect(r.ok && r.card.readback).toEqual([
      {
        trigger: 'rule.readback',
        vars: { ingredient: 'peanut', spelled: 'P-E-A-N-U-T', severity: 'a severe allergy', covers: 'peanut' },
      },
    ]);
  });

  test('no severity said → anaphylactic and unclear, asked first', () => {
    const c = card('Sesame');
    expect(c).toMatchObject({ severe: true, severityUnclear: true, rule: { severity: 'anaphylactic' } });
    expect(c.readback.map((l) => l.trigger)).toEqual(['rule.severity_unclear', 'rule.readback']);
  });

  test('"nuts" is the nut category and covers peanut and tree nut', () => {
    const c = card('nuts', 'allergy');
    expect(c.rule.target).toEqual({ kind: 'category', ids: ['nut'] });
    expect(c.display.covers).toBe('nut, peanut and tree nut');
    expect(c.display.severity).toBe('an allergy');
  });

  test('"kiwi" is unknown: nothing to save', () => {
    expect(buildRuleCard({ term: 'kiwi', severity: 'allergy' }, graph, terms)).toEqual({
      ok: false,
      reason: 'unknown_term',
      line: { trigger: 'rule.unknown_term', vars: { term: 'kiwi' } },
    });
  });

  test('a partial match is ambiguous and never auto-picked', () => {
    const r = buildRuleCard({ term: 'pea', severity: null }, graph, terms);
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous', line: { trigger: 'rule.which_one', vars: { term: 'pea' } } });
    expect(!r.ok && r.reason === 'ambiguous' && r.options.map((o) => o.id)).toContain('peanut');
    expect(!r.ok && r.reason === 'ambiguous' && r.options.length).toBeLessThanOrEqual(5);
  });

  test.each(['pecan', 'peanutt', 'halal', 'kosher', 'jain'])('"%s" is unknown, never a narrower rule', (term) => {
    // S04, C5
    expect(buildRuleCard({ term, severity: null }, graph, terms)).toMatchObject({ ok: false, reason: 'unknown_term' });
  });

  test('"no pork" is the pork diet rule', () => {
    const c = card('No  Pork');
    expect(c).toMatchObject({ form: 'rule_diet', severe: false, severityUnclear: false, rule: { target: { ids: ['pork'] }, severity: 'preference' } });
    expect(c.display).toMatchObject({ ingredient: 'no pork', severity: 'a diet rule' });
  });

  test('vegetarian uses the diet form and no spelling', () => {
    const c = card('veggie');
    expect(c).toMatchObject({ form: 'rule_diet', display: { ingredient: 'vegetarian', severity: 'a diet rule' } });
    expect(c.rule.target.kind).toBe('category');
    expect(c.readback.map((l) => l.trigger)).toEqual(['rule.readback.no_spelling']);
    expect(c.readback[0].vars).not.toHaveProperty('spelled');
  });

  test('vegan covers honey, gelatine and milk; the list is capped at 8', () => {
    const c = card('plant based');
    expect(c.rule.target.ids).toEqual(expect.arrayContaining(['honey', 'gelatin', 'milk', 'egg']));
    // The term's own targets come first, so shellfish is never hidden behind its kinds (M1).
    expect(c.display.covers).toBe('egg, fish, gelatine, honey, meat, milk, shellfish, bonito flakes and 2 more');
  });

  test('shrimp and prawns are shellfish (M7)', () => {
    for (const t of ['shrimp', 'prawns', 'Shrimps', 'king prawn']) {
      expect(card(t, 'allergy').rule.target.ids, t).toEqual(['prawn']);
      expect(graph.pathTo('prawn', 'shellfish')).toEqual(['prawn', 'shellfish']);
    }
    expect(card('shellfish', 'allergy').display.covers).toBe('shellfish and prawn');
  });

  test('coeliac asks for a severity and uses the allergen form', () => {
    const c = card('gluten-free');
    expect(c).toMatchObject({ form: 'rule_allergen', severityUnclear: true, rule: { severity: 'anaphylactic', target: { ids: ['gluten'] } } });
  });

  test('a non-term mild rule uses the intolerance form', () => {
    const c = card('garlic', 'intolerance');
    expect(c).toMatchObject({ form: 'rule_intolerance', severe: false, display: { ingredient: 'garlic', severity: 'an intolerance' } });
    expect(c.readback).toEqual([
      { trigger: 'rule.readback.no_spelling', vars: { ingredient: 'garlic', severity: 'an intolerance', covers: 'garlic' } },
    ]);
  });

  test('withSeverity rebuilds the card', () => {
    const c = card('peanut');
    const mild = withSeverity(c, 'intolerance', graph, terms);
    expect(mild).toMatchObject({ severe: false, severityUnclear: false, form: 'rule_intolerance', rule: { severity: 'intolerance' } });
    expect(mild.readback.map((l) => l.trigger)).toEqual(['rule.readback.no_spelling']);
    const veg = withSeverity(card('vegetarian'), 'allergy', graph, terms);
    expect(veg).toMatchObject({ form: 'rule_diet', severe: true, rule: { severity: 'allergy', target: { ids: ['meat', 'fish', 'shellfish', 'gelatin'] } } });
    expect(veg.display.severity).toBe('a diet rule');
  });

  test('every built rule passes validateRules', () => {
    const labels = [
      ...data.ingredients.flatMap((n) => [n.name, ...(n.aliases ?? [])]),
      ...terms.flatMap((t) => t.phrases),
    ];
    let built = 0;
    for (const label of labels) {
      for (const severity of [null, ...Object.keys(SEVERITY_WORDS)] as (RuleCard['rule']['severity'] | null)[]) {
        const r = buildRuleCard({ term: label, severity }, graph, terms);
        expect(r.ok, label).toBe(true);
        if (!r.ok) continue;
        built++;
        expect(validateRules([{ ...r.card.rule, id: 'r1' }], graph), label).toEqual([]);
        expect(isSevereCard(r.card)).toBe(r.card.severe);
      }
    }
    expect(built).toBe(labels.length * 5);
  });
});

describe('other cards', () => {
  test('meal and pantry summaries', () => {
    const m = buildMealCard({ eatenOn: '2026-11-10', slot: 'breakfast', description: '  toast ' });
    expect(m).toEqual({
      kind: 'meal',
      meal: { eatenOn: '2026-11-10', slot: 'breakfast', item: { kind: 'free', description: 'toast' } },
      summary: 'toast, breakfast',
      estimate: true,
      readback: [{ trigger: 'log.confirm_readback', vars: { summary: 'toast, breakfast' } }],
    });
    const dish = (servings: number) =>
      buildMealCard({ eatenOn: '2026-11-10', slot: 'dinner', dish: { slug: 'india/kerala/parippu', title: 'Parippu', servings } });
    expect(dish(1)).toMatchObject({ estimate: false, summary: 'Parippu, one serving, dinner', meal: { item: { kind: 'dish', slug: 'india/kerala/parippu', servings: 1 } } });
    expect([0.5, 2, 3, 1.5].map((s) => dish(s).summary)).toEqual([
      'Parippu, half a serving, dinner',
      'Parippu, two servings, dinner',
      'Parippu, 3 servings, dinner',
      'Parippu, 1.5 servings, dinner',
    ]);
    const long = buildMealCard({ eatenOn: '2026-11-10', slot: 'lunch', description: 'x'.repeat(300) });
    expect(long.meal.item).toEqual({ kind: 'free', description: 'x'.repeat(MEAL_DESCRIPTION_MAX) });
    expect(() => buildMealCard({ eatenOn: '2026-11-10', slot: 'lunch', description: '  ' })).toThrow();

    const p = buildPantryCard({ add: ['chickpeas', 'Spinach', 'dragon fruit', 'y'.repeat(100)], remove: ['milk'] }, graph);
    expect(p.add).toEqual([
      { name: 'chickpeas', ingredientId: null },
      { name: 'Spinach', ingredientId: null },
      { name: 'dragon fruit', ingredientId: null },
      { name: 'y'.repeat(80), ingredientId: null },
    ]);
    expect(buildPantryCard({ add: ['onions', 'honey'], remove: [] }, graph).add).toEqual([
      { name: 'onions', ingredientId: 'onion' },
      { name: 'honey', ingredientId: 'honey' },
    ]);
    expect(buildPantryCard({ add: ['chickpeas', 'spinach'], remove: ['milk'] }, graph)).toMatchObject({
      kind: 'pantry',
      remove: ['milk'],
      summary: 'add chickpeas and spinach; remove milk',
      readback: [{ trigger: 'pantry.readback', vars: { summary: 'add chickpeas and spinach; remove milk' } }],
    });
    expect(buildPantryCard({ add: [], remove: ['eggs'] }, graph).summary).toBe('remove eggs');
    expect(() => buildPantryCard({ add: [' '], remove: [] }, graph)).toThrow();
  });

  test('a profile window without an end gets start + 60', () => {
    expect(buildProfileCard({ mealWindows: [{ name: 'lunch', start: '12:30' }] }).patch.mealWindows![0].end).toBe('13:30');
    expect(buildProfileCard({ mealWindows: [{ name: 'snack', start: '23:30' }] }).patch.mealWindows![0].end).toBe('23:59');
    expect(buildProfileCard({ mealWindows: [{ name: 'dinner', start: '18:00', end: '20:00' }] }).patch.mealWindows![0].end).toBe('20:00');
  });

  test('profile summary is plain text', () => {
    const c = buildProfileCard({ marketDays: [6], mealsPerWeek: 5, country: 'USA', region: 'Pacific Northwest', mealWindows: [{ name: 'lunch', start: '12:30' }] });
    expect(c.summary).toBe('market day Saturday; 5 meals a week; Pacific Northwest, USA; lunch 12:30');
    expect(c.readback).toEqual([{ trigger: 'profile.readback', vars: { summary: c.summary } }]);
    expect(buildProfileCard({ marketDays: [5, 6] }).summary).toBe('market days Friday and Saturday');
    expect(buildProfileCard({ mealsPerWeek: 1 }).summary).toBe('1 meal a week');
    expect(() => buildProfileCard({})).toThrow();
  });

  test('isSevereCard is only a severe rule card', () => {
    expect(isSevereCard(card('peanut', 'allergy'))).toBe(true);
    expect(isSevereCard(card('peanut', 'preference'))).toBe(false);
    expect(isSevereCard(buildProfileCard({ mealsPerWeek: 3 }))).toBe(false);
  });
});
