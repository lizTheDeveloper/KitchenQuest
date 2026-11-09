import { describe, expect, it } from 'vitest';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientNode } from '../ingredients/types';
import { parseRecipe } from '../recipe/parse';
import type { ParsedRecipe } from '../recipe/types';
import { check, DISCLAIMER, validateSubstitutions } from './check';
import type { Substitution } from './check';
import { SEVERE } from './types';
import type { Rule } from './types';

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
  { id: 'tamari', name: 'tamari', contains: ['soy'] },
  { id: 'coconut', name: 'coconut' },
  { id: 'coconut_milk', name: 'coconut milk', isA: ['coconut'] },
  { id: 'coconut_aminos', name: 'coconut aminos' },
  { id: 'curry_paste', name: 'curry paste', labelDependent: true },
  { id: 'salt', name: 'salt' },
  { id: 'table_salt', name: 'table salt', isA: ['salt'] },
  { id: 'salty_sauce', name: 'salty sauce', contains: ['salt'] },
  { id: 'peanut', name: 'peanut', isA: ['nut'] },
  { id: 'meat', name: 'meat' },
  { id: 'pork', name: 'pork', isA: ['meat'] },
  { id: 'lard', name: 'lard', contains: ['pork'] },
];

const graph = IngredientGraph.fromData({ ingredients: fixture });

const SUBS: Substitution[] = [
  { from: 'soy_sauce', to: 'tamari' },
  { from: 'soy_sauce', to: 'coconut_aminos', note: 'a little sweeter' },
];

const DATE = '2026-11-09';

function recipe(body: string, servings = 2): ParsedRecipe {
  return parseRecipe(`---
title: Test Dish
country: Testland
region: Test Region
credit: Tester
cook: Tester
difficulty: 1
skills: [stirring]
servings: ${servings}
license: CC-BY-SA-4.0
status: draft
---

${body}
`);
}

function avoid(id: string, ids: string[], severity: Rule['severity'] = 'allergy'): Rule {
  return { id, target: { kind: 'ingredient', ids }, type: 'avoid', severity };
}

describe('check', () => {
  it('ok with no rules', () => {
    const result = check(recipe('Chop @tomato{2} and @spring onions{1}.'), [], graph, SUBS, DATE);
    expect(result).toEqual({ status: 'ok', findings: [], severe: false, disclaimer: null });
  });

  it('blocks through hidden ingredients', () => {
    const result = check(
      recipe('Add @worcestershire sauce{1%tsp}.'),
      [avoid('no-fish', ['fish'], 'anaphylactic')],
      graph,
      SUBS,
      DATE,
    );
    expect(result.status).toBe('blocked');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ingredient: 'worcestershire sauce',
      ingredientId: 'worcestershire',
      kind: 'match',
      status: 'blocked',
      ruleId: 'no-fish',
      severity: 'anaphylactic',
      path: ['worcestershire', 'anchovy', 'fish'],
    });
    expect(result.findings[0].swap).toBeUndefined();
    expect(result.severe).toBe(true);
    expect(result.disclaimer).toBe(DISCLAIMER);
  });

  it('offers a passing swap', () => {
    const result = check(
      recipe('Add @soy sauce{2%tbsp}.'),
      [avoid('no-wheat', ['wheat'], 'intolerance')],
      graph,
      SUBS,
      DATE,
    );
    expect(result.status).toBe('swap');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      ingredientId: 'soy_sauce',
      kind: 'match',
      status: 'swap',
      path: ['soy_sauce', 'wheat'],
      swap: { toId: 'tamari', toName: 'tamari' },
    });
    expect(result.severe).toBe(false);
    expect(result.disclaimer).toBeNull();
  });

  it('never offers a swap that breaks another rule', () => {
    const rules = [avoid('no-wheat', ['wheat']), avoid('no-soy', ['soy'])];
    const r = recipe('Add @soy sauce{2%tbsp}.');

    const result = check(r, rules, graph, SUBS, DATE);
    expect(result.status).toBe('swap');
    expect(result.findings.length).toBeGreaterThan(0);
    for (const f of result.findings) {
      expect(f.status).toBe('swap');
      expect(f.swap).toEqual({ toId: 'coconut_aminos', toName: 'coconut aminos', note: 'a little sweeter' });
    }
    expect(result.findings.map((f) => f.ruleId).sort()).toEqual(['no-soy', 'no-wheat']);

    const withoutAminos = SUBS.filter((s) => s.to !== 'coconut_aminos');
    const blocked = check(r, rules, graph, withoutAminos, DATE);
    expect(blocked.status).toBe('blocked');
    expect(blocked.findings.length).toBeGreaterThan(0);
    for (const f of blocked.findings) {
      expect(f.status).toBe('blocked');
      expect(f.swap).toBeUndefined();
    }
  });

  it('never offers a label-dependent swap while rules are active', () => {
    const subs: Substitution[] = [{ from: 'soy_sauce', to: 'curry_paste' }];
    const result = check(recipe('Add @soy sauce{1%tbsp}.'), [avoid('no-wheat', ['wheat'])], graph, subs, DATE);
    expect(result.status).toBe('blocked');
  });

  it('unknown ingredient is never ok', () => {
    const result = check(recipe('Slice @dragon fruit{1}.'), [], graph, SUBS, DATE);
    expect(result.status).toBe('unverified');
    expect(result.findings).toEqual([
      { ingredient: 'dragon fruit', ingredientId: null, kind: 'unresolved', status: 'unverified' },
    ]);
  });

  it('label-dependent only matters under rules', () => {
    const r = recipe('Fry @curry paste{2%tbsp}.');
    expect(check(r, [], graph, SUBS, DATE).status).toBe('ok');

    const result = check(r, [avoid('no-fish', ['fish'])], graph, SUBS, DATE);
    expect(result.status).toBe('unverified');
    expect(result.findings).toEqual([
      { ingredient: 'curry paste', ingredientId: 'curry_paste', kind: 'label', status: 'unverified' },
    ]);
  });

  it('a prefer rule alone does not make label-dependent ingredients unverified', () => {
    const prefer: Rule = { ...avoid('likes-fish', ['fish']), type: 'prefer', severity: 'preference' };
    const result = check(recipe('Fry @curry paste{2%tbsp} with @anchovy{2}.'), [prefer], graph, SUBS, DATE);
    expect(result.status).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('a matched label-dependent ingredient gets no extra label finding', () => {
    const result = check(recipe('Add @soy sauce{1%tbsp}.'), [avoid('no-soy', ['soy'])], graph, [], DATE);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('match');
  });

  it('inactive phase is ignored', () => {
    const rule: Rule = {
      ...avoid('no-fish', ['fish'], 'anaphylactic'),
      phase: { start: '2026-10-01', end: '2026-11-08' },
    };
    const result = check(recipe('Add @worcestershire sauce{1%tsp}.'), [rule], graph, SUBS, DATE);
    expect(result).toEqual({ status: 'ok', findings: [], severe: false, disclaimer: null });
  });

  it('precedence', () => {
    const fishRule = [avoid('no-fish', ['fish'])];
    const blocked = check(
      recipe('Add @worcestershire sauce{1%tsp} and @dragon fruit{1}.'),
      fishRule,
      graph,
      SUBS,
      DATE,
    );
    expect(blocked.status).toBe('blocked');

    const unverified = check(
      recipe('Add @soy sauce{1%tbsp} and @dragon fruit{1}.'),
      [avoid('no-wheat', ['wheat'])],
      graph,
      SUBS,
      DATE,
    );
    expect(unverified.findings.map((f) => f.status).sort()).toEqual(['swap', 'unverified']);
    expect(unverified.status).toBe('unverified');
  });

  it('limit per serving', () => {
    const rule: Rule = {
      id: 'low-salt',
      target: { kind: 'ingredient', ids: ['salt'] },
      type: 'limit',
      severity: 'intolerance',
      limit: { amount: 5, unit: 'g', per: 'serving' },
    };
    const under = check(recipe('Add @salt{8%g}.', 2), [rule], graph, SUBS, DATE);
    expect(under.status).toBe('ok');
    expect(under.findings).toEqual([]);

    const over = check(recipe('Add @salt{12%g}.', 2), [rule], graph, SUBS, DATE);
    expect(over.status).toBe('blocked');
    expect(over.findings[0]).toMatchObject({ kind: 'match', status: 'blocked', ruleId: 'low-salt' });

    const mismatch = check(recipe('Add @salt{1%tsp}.', 2), [rule], graph, SUBS, DATE);
    expect(mismatch.status).toBe('unverified');
    expect(mismatch.findings[0]).toMatchObject({ kind: 'label', status: 'unverified', ruleId: 'low-salt' });

    const noQuantity = check(recipe('Add @salt{}.', 2), [rule], graph, SUBS, DATE);
    expect(noQuantity.status).toBe('unverified');
    expect(noQuantity.findings[0]).toMatchObject({ kind: 'label', status: 'unverified' });
  });

  it('sets severe and the disclaimer for any active severe rule, even when ok', () => {
    const result = check(recipe('Chop @tomato{1}.'), [avoid('no-nuts', ['nut'], 'allergy')], graph, SUBS, DATE);
    expect(result.status).toBe('ok');
    expect(result.severe).toBe(true);
    expect(result.disclaimer).toBe(DISCLAIMER);
  });

  it('throws on rules that target ids missing from the graph', () => {
    expect(() =>
      check(recipe('Chop @tomato{1}.'), [avoid('bad-rule', ['unicorn'])], graph, SUBS, DATE),
    ).toThrow(/bad-rule.*unicorn/);
  });

  it('validates every substitution up front, whatever the recipe', () => {
    const r = recipe('Chop @tomato{1}.');
    expect(() => check(r, [], graph, [{ from: 'soy_sauce', to: 'mystery_sauce' }], DATE)).toThrow(
      /mystery_sauce/,
    );
    expect(() => check(r, [], graph, [{ from: 'ghost_sauce', to: 'tamari' }], DATE)).toThrow(/ghost_sauce/);
  });

  it('throws on an invalid date', () => {
    const r = recipe('Chop @tomato{1}.');
    expect(() => check(r, [], graph, SUBS, '2026-11-09T12:00:00Z')).toThrow(/2026-11-09T12:00:00Z/);
    expect(() => check(r, [], graph, SUBS, '6/1/2026')).toThrow(/6\/1\/2026/);
  });

  it('ignores per-day limits in M1', () => {
    const rule: Rule = {
      id: 'daily-salt',
      target: { kind: 'ingredient', ids: ['salt'] },
      type: 'limit',
      severity: 'intolerance',
      limit: { amount: 5, unit: 'g', per: 'day' },
    };
    const result = check(recipe('Add @salt{12%g}.', 2), [rule], graph, SUBS, DATE);
    expect(result.status).toBe('ok');
    expect(result.findings).toEqual([]);
  });

  it('swap re-check rejects a candidate reaching a per-serving limit target, whatever the amount', () => {
    const rules: Rule[] = [
      avoid('no-wheat', ['wheat']),
      {
        id: 'low-salt',
        target: { kind: 'ingredient', ids: ['salt'] },
        type: 'limit',
        severity: 'intolerance',
        limit: { amount: 5, unit: 'g', per: 'serving' },
      },
    ];
    const r = recipe('Add @soy sauce{1%tbsp}.');
    const only: Substitution[] = [{ from: 'soy_sauce', to: 'salty_sauce' }];
    expect(check(r, rules, graph, only, DATE).status).toBe('blocked');

    const withFallback: Substitution[] = [...only, { from: 'soy_sauce', to: 'tamari' }];
    const result = check(r, rules, graph, withFallback, DATE);
    expect(result.status).toBe('swap');
    expect(result.findings[0].swap?.toId).toBe('tamari');
  });

  describe('unsafeFor', () => {
    const g = IngredientGraph.fromData({
      ingredients: [
        { id: 'allium', name: 'allium' },
        { id: 'fodmap_fructan', name: 'fructan' },
        { id: 'garlic', name: 'garlic', isA: ['allium', 'fodmap_fructan'] },
        { id: 'garlic_infused_oil', name: 'garlic-infused oil' },
        { id: 'asafoetida', name: 'asafoetida' },
      ],
    });
    const infused: Substitution = {
      from: 'garlic',
      to: 'garlic_infused_oil',
      unsafeFor: ['garlic', 'allium'],
    };
    const r = recipe('Add @garlic{2}.');

    it('still offers the swap for a rule whose targets are not listed', () => {
      const lowFodmap = avoid('low-fodmap', ['fodmap_fructan'], 'intolerance');
      const result = check(r, [lowFodmap], g, [infused], DATE);
      expect(result.status).toBe('swap');
      expect(result.findings[0].swap?.toId).toBe('garlic_infused_oil');
    });

    it('never offers the swap when a matching rule targets a listed id', () => {
      for (const rule of [avoid('garlic', ['garlic'], 'anaphylactic'), avoid('alliums', ['allium'])]) {
        const result = check(r, [rule], g, [infused], DATE);
        expect(result.status).toBe('blocked');
        expect(result.findings[0].swap).toBeUndefined();
      }
      // ...nor when a low-FODMAP rule is active alongside the allergy
      const both = [avoid('low-fodmap', ['fodmap_fructan'], 'intolerance'), avoid('garlic', ['garlic'])];
      expect(check(r, both, g, [infused], DATE).status).toBe('blocked');
    });

    it('falls through to the next passing substitution', () => {
      const subs = [infused, { from: 'garlic', to: 'asafoetida' }];
      const result = check(r, [avoid('garlic', ['garlic'])], g, subs, DATE);
      expect(result.status).toBe('swap');
      expect(result.findings[0].swap?.toId).toBe('asafoetida');
    });

    it('rejects unknown ids in unsafeFor', () => {
      const bad: Substitution = { ...infused, unsafeFor: ['ghost'] };
      expect(() => check(r, [], g, [bad], DATE)).toThrow(/ghost/);
    });
  });
});

describe('check: aliased ingredients', () => {
  it('checks the ingredient itself, not its display alias', () => {
    const g = IngredientGraph.fromData({
      ingredients: [
        { id: 'nut', name: 'nut' },
        { id: 'peanut', name: 'peanut', isA: ['nut'] },
      ],
    });
    const result = check(recipe('Add @peanut|nuts{10%g}.'), [avoid('no-peanut', ['peanut'])], g, [], DATE);
    expect(result.status).toBe('blocked');
    expect(result.findings[0]).toMatchObject({ ingredient: 'peanut', ingredientId: 'peanut', kind: 'match' });
  });
});

describe('check: category ingredients', () => {
  it('a category line is unverified for a rule on any kind of it', () => {
    for (const target of ['peanut', 'tree_nut', 'cashew']) {
      const result = check(recipe('Add @nuts{50%g}.'), [avoid('no-x', [target])], graph, SUBS, DATE);
      expect(result.status).toBe('unverified');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        ingredient: 'nuts',
        ingredientId: 'nut',
        kind: 'label',
        status: 'unverified',
        ruleId: 'no-x',
      });
      expect(result.findings[0].path![0]).toBe('nut');
      expect(result.findings[0].path!.at(-1)).toBe(target);
    }
    const nuts = check(recipe('Add @nuts{50%g}.'), [avoid('no-peanut', ['peanut'])], graph, SUBS, DATE);
    expect(nuts.findings[0].path).toEqual(['nut', 'peanut']);
  });

  it('meat is unverified for a pork rule', () => {
    const result = check(recipe('Add @meat{200%g}.'), [avoid('no-pork', ['pork'], 'preference')], graph, SUBS, DATE);
    expect(result.status).toBe('unverified');
    expect(result.findings[0]).toMatchObject({ ingredientId: 'meat', kind: 'label', path: ['meat', 'pork'] });
  });

  it('follows isA only: pork is not flagged for a lard rule (lard contains pork)', () => {
    const result = check(recipe('Add @pork{200%g}.'), [avoid('no-lard', ['lard'])], graph, SUBS, DATE);
    expect(result).toMatchObject({ status: 'ok', findings: [] });
  });

  it('a direct match on a category is a match, with no extra label finding', () => {
    const result = check(recipe('Add @nuts{50%g}.'), [avoid('no-nuts', ['nut'])], graph, SUBS, DATE);
    expect(result.status).toBe('blocked');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].kind).toBe('match');
  });

  it('a category with no kind reaching the target stays ok', () => {
    expect(check(recipe('Add @nuts{50%g}.'), [avoid('no-fish', ['fish'])], graph, SUBS, DATE).status).toBe('ok');
  });

  it('applies to per-serving limits too', () => {
    const rule: Rule = {
      id: 'low-table-salt',
      target: { kind: 'ingredient', ids: ['table_salt'] },
      type: 'limit',
      severity: 'intolerance',
      limit: { amount: 100, unit: 'g', per: 'serving' },
    };
    const result = check(recipe('Add @salt{1%g}.', 1), [rule], graph, SUBS, DATE);
    expect(result.status).toBe('unverified');
    expect(result.findings[0]).toMatchObject({ ingredientId: 'salt', kind: 'label', ruleId: 'low-table-salt' });
  });
});

describe('check: ingredient unsafeFor', () => {
  const g = IngredientGraph.fromData({
    ingredients: [
      { id: 'allium', name: 'allium' },
      { id: 'fodmap_fructan', name: 'fructan' },
      { id: 'garlic', name: 'garlic', isA: ['allium', 'fodmap_fructan'] },
      { id: 'garlic_infused_oil', name: 'garlic-infused oil', unsafeFor: ['garlic', 'allium'] },
      { id: 'neutral_oil', name: 'neutral oil' },
    ],
  });
  const r = recipe('Fry in @garlic-infused oil{1%tbsp}.');

  it('blocks like a match for a rule targeting a listed id', () => {
    for (const target of ['garlic', 'allium']) {
      const result = check(r, [avoid('garlic-allergy', [target], 'anaphylactic')], g, [], DATE);
      expect(result.status).toBe('blocked');
      expect(result.findings).toEqual([
        {
          ingredient: 'garlic-infused oil',
          ingredientId: 'garlic_infused_oil',
          kind: 'match',
          status: 'blocked',
          ruleId: 'garlic-allergy',
          severity: 'anaphylactic',
          path: ['garlic_infused_oil', target],
        },
      ]);
    }
  });

  it('swaps like any match', () => {
    const subs: Substitution[] = [{ from: 'garlic_infused_oil', to: 'neutral_oil' }];
    const result = check(r, [avoid('garlic-allergy', ['garlic'])], g, subs, DATE);
    expect(result.status).toBe('swap');
    expect(result.findings[0].swap?.toId).toBe('neutral_oil');
  });

  it('matches exact rule target ids only: fine for low-FODMAP although garlic is a fructan', () => {
    expect(check(r, [avoid('low-fodmap', ['fodmap_fructan'], 'intolerance')], g, [], DATE).status).toBe('ok');
  });

  it('is never offered as a swap for a rule targeting a listed id', () => {
    const subs: Substitution[] = [{ from: 'garlic', to: 'garlic_infused_oil' }];
    const result = check(recipe('Add @garlic{2}.'), [avoid('alliums', ['allium'])], g, subs, DATE);
    expect(result.status).toBe('blocked');
    expect(result.findings[0].swap).toBeUndefined();
  });
});

describe('check: substitution unsafeFor matches exact rule target ids', () => {
  // garlic is in unsafeFor and garlic isA fodmap_fructan. If unsafeFor were matched by ancestry
  // (does a listed id reach the rule's target?), the low-FODMAP rule would suppress the very swap
  // the substitution exists for. It is matched against the rule's exact target ids instead.
  const g = IngredientGraph.fromData({
    ingredients: [
      { id: 'allium', name: 'allium' },
      { id: 'fodmap_fructan', name: 'fructan' },
      { id: 'garlic', name: 'garlic', isA: ['allium', 'fodmap_fructan'] },
      { id: 'garlic_infused_oil', name: 'garlic-infused oil' },
    ],
  });
  const sub: Substitution = { from: 'garlic', to: 'garlic_infused_oil', unsafeFor: ['garlic'] };

  it('offers the swap for a rule on an ancestor of a listed id', () => {
    expect(g.pathTo('garlic', 'fodmap_fructan')).not.toBeNull();
    const result = check(recipe('Add @garlic{2}.'), [avoid('low-fodmap', ['fodmap_fructan'])], g, [sub], DATE);
    expect(result.status).toBe('swap');
  });

  it('withholds it for a rule on the listed id itself', () => {
    expect(check(recipe('Add @garlic{2}.'), [avoid('garlic', ['garlic'])], g, [sub], DATE).status).toBe('blocked');
  });
});

describe('check: per-serving limits add up across lines', () => {
  const salt8: Rule = {
    id: 'low-salt',
    target: { kind: 'ingredient', ids: ['salt'] },
    type: 'limit',
    severity: 'intolerance',
    limit: { amount: 8, unit: 'g', per: 'serving' },
  };

  it('sums every line reaching the target', () => {
    const result = check(recipe('Add @salt{5%g} and @table salt{5%g}.', 1), [salt8], graph, [], DATE);
    expect(result.status).toBe('blocked');
    expect(result.findings.map((f) => [f.ingredientId, f.kind, f.ruleId])).toEqual([
      ['salt', 'match', 'low-salt'],
      ['table_salt', 'match', 'low-salt'],
    ]);
    expect(check(recipe('Add @salt{4%g} and @table salt{4%g}.', 1), [salt8], graph, [], DATE).status).toBe('ok');
  });

  it('gives one unverified finding when any line has no quantity or another unit', () => {
    for (const other of ['@table salt{}', '@table salt{1%tsp}']) {
      const result = check(recipe(`Add @salt{1%g} and ${other}.`, 1), [salt8], graph, [], DATE);
      expect(result.status).toBe('unverified');
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({ kind: 'label', status: 'unverified', ruleId: 'low-salt' });
    }
  });

  it('compares units case-insensitively', () => {
    expect(check(recipe('Add @salt{9%G}.', 1), [salt8], graph, [], DATE).status).toBe('blocked');
    expect(check(recipe('Add @salt{7%G}.', 1), [salt8], graph, [], DATE).status).toBe('ok');
  });

  it('keeps a known violation blocked when another line is unmeasurable', () => {
    const result = check(recipe('Add @salt{50%g} and @table salt{}.', 1), [salt8], graph, [], DATE);
    expect(result.status).toBe('blocked');
    expect(result.findings.map((f) => [f.ingredientId, f.kind, f.status])).toEqual([
      ['salt', 'match', 'blocked'],
      ['table_salt', 'label', 'unverified'],
    ]);
  });

  it('folds only whitelisted units, case-insensitively', () => {
    const tbsp: Rule = { ...salt8, limit: { amount: 2, unit: 'tbsp', per: 'serving' } };
    expect(check(recipe('Add @salt{3%TBSP}.', 1), [tbsp], graph, [], DATE).status).toBe('blocked');
    const dotted: Rule = { ...salt8, limit: { amount: 2, unit: 't.', per: 'serving' } };
    for (const u of ['T.', 'Ts', 'ts']) {
      expect(check(recipe(`Add @salt{1%${u}}.`, 1), [dotted], graph, [], DATE).status).toBe('unverified');
    }
  });

  it('never folds T (tablespoon) into t (teaspoon)', () => {
    const tsp: Rule = { ...salt8, limit: { amount: 2, unit: 't', per: 'serving' } };
    expect(check(recipe('Add @salt{1%T}.', 1), [tsp], graph, [], DATE).status).toBe('unverified');
    expect(check(recipe('Add @salt{1%t}.', 1), [tsp], graph, [], DATE).status).toBe('ok');
  });
});

describe('SEVERE', () => {
  it('is exactly anaphylactic and allergy', () => {
    expect([...SEVERE].sort()).toEqual(['allergy', 'anaphylactic']);
  });
});

describe('validateSubstitutions', () => {
  it('returns [] for known ids and names every unknown one', () => {
    expect(validateSubstitutions(SUBS, graph)).toEqual([]);
    const problems = validateSubstitutions(
      [
        { from: 'ghost', to: 'tamari' },
        { from: 'soy_sauce', to: 'phantom', unsafeFor: ['spectre'] },
      ],
      graph,
    );
    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toMatch(/ghost[\s\S]*phantom[\s\S]*spectre/);
  });
});
