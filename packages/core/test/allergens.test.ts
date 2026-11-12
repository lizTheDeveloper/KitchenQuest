import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IngredientGraph, check, parseRecipe } from '../src/index';
import type { IngredientData, Rule, Substitution } from '../src/index';
import { buildRuleCard } from '../src/mentor/cards';
import { parseRuleStatement } from '../src/mentor/parse';
import type { RuleTerm } from '../src/mentor/rule-terms';

/**
 * The EU 14 (Regulation 1169/2011 Annex II) and US 9 (FALCPA + FASTER) allergens and their
 * common members, on the real seed graph: every name resolves, and a rule on a category blocks
 * every member, so a player naming one ("cashews") gets a rule that covers it.
 */

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const data = readJson('data/ingredients.json') as IngredientData;
const subs = readJson('data/substitutions.json') as Substitution[];
const terms = readJson('data/rule-terms.json') as RuleTerm[];
const graph = IngredientGraph.fromData(data);

/** Every name and alias that must resolve, with its id. */
const NAMES: Record<string, string[]> = {
  // tree nuts
  almond: ['almond', 'almonds', 'ground almonds', 'flaked almonds', 'slivered almonds'],
  cashew: ['cashew', 'cashews', 'cashew nuts'],
  walnut: ['walnut', 'walnuts', 'english walnut'],
  pecan: ['pecan', 'pecans', 'pecan nuts'],
  hazelnut: ['hazelnut', 'hazelnuts', 'filbert', 'filberts', 'hazel nut'],
  pistachio: ['pistachio', 'pistachios', 'pistachio nuts'],
  brazil_nut: ['brazil nut', 'brazil nuts', 'brazilnut'],
  macadamia: ['macadamia nut', 'macadamia', 'macadamias', 'queensland nut'],
  pine_nut: ['pine nut', 'pine nuts', 'pine kernels', 'pignoli', 'pignolia'],
  chestnut: ['chestnut', 'chestnuts', 'sweet chestnut'],
  tree_nut: ['tree nut', 'tree nuts'],
  peanut: ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'monkey nut', 'monkey nuts', 'arachis'],
  peanut_oil: ['peanut oil', 'groundnut oil', 'arachis oil'],
  // crustaceans
  crustacean: ['crustacean', 'crustaceans', 'crustacean shellfish'],
  prawn: ['prawn', 'prawns', 'shrimp', 'shrimps'],
  crab: ['crab', 'crabs', 'crab meat', 'crabmeat'],
  lobster: ['lobster', 'lobsters', 'lobster tail'],
  crayfish: ['crayfish', 'crawfish'],
  // molluscs
  mollusc: ['mollusc', 'molluscs', 'mollusk', 'mollusks'],
  clam: ['clam', 'clams'],
  mussel: ['mussel', 'mussels', 'blue mussels'],
  oyster: ['oyster', 'oysters'],
  scallop: ['scallop', 'scallops', 'sea scallops', 'bay scallops'],
  squid: ['squid', 'calamari', 'calamares'],
  octopus: ['octopus', 'octopuses'],
  snail: ['snail', 'snails', 'escargot', 'escargots'],
  // fish
  cod: ['cod', 'atlantic cod'],
  salmon: ['salmon', 'atlantic salmon'],
  tuna: ['tuna', 'bluefin tuna'],
  anchovy: ['anchovy', 'anchovies', 'anchovy fillets'],
  sardine: ['sardine', 'sardines', 'pilchard', 'pilchards'],
  mackerel: ['mackerel', 'atlantic mackerel'],
  // celery, lupin, sulphites, mustard, sesame
  celery: ['celery'],
  celery_stalk: ['celery stalk', 'celery sticks', 'celery ribs'],
  celeriac: ['celeriac', 'celery root'],
  celery_seed: ['celery seed', 'celery seeds'],
  lupin: ['lupin', 'lupins', 'lupine'],
  lupin_bean: ['lupin bean', 'lupini', 'lupini beans', 'lupine beans'],
  lupin_flour: ['lupin flour', 'lupine flour'],
  sulphites: [
    'sulphites',
    'sulphite',
    'sulfites',
    'sulfite',
    'sulphur dioxide',
    'sulfur dioxide',
    'sodium metabisulphite',
    'e220',
  ],
  mustard: ['mustard'],
  mustard_seed: [
    'mustard seeds',
    'yellow mustard seed',
    'white mustard seed',
    'ground mustard',
    'mustard powder',
    'dry mustard',
  ],
  sesame: ['sesame'],
  sesame_seed: ['sesame seed', 'sesame seeds', 'white sesame seeds'],
  tahini: ['tahini', 'sesame paste'],
  // cereals containing gluten
  gluten: ['gluten'],
  wheat: ['wheat'],
  barley: ['barley', 'pearl barley'],
  rye: ['rye'],
  oats: ['oats', 'oat', 'rolled oats', 'porridge oats', 'oatmeal'],
  spelt: ['spelt'],
  kamut: ['kamut', 'khorasan wheat', 'khorasan'],
  // the rest of the 14 / 9, already in the graph
  milk: ['milk', 'dairy'],
  egg: ['egg', 'eggs'],
  soy: ['soy', 'soya'],
  fish: ['fish'],
  shellfish: ['shellfish'],
};

const TREE_NUTS = [
  'almond',
  'cashew',
  'walnut',
  'pecan',
  'hazelnut',
  'pistachio',
  'brazil_nut',
  'macadamia',
  'pine_nut',
  'chestnut',
];
const CRUSTACEANS = ['prawn', 'crab', 'lobster', 'crayfish'];
const MOLLUSCS = ['clam', 'mussel', 'oyster', 'scallop', 'squid', 'octopus', 'snail'];
const FISH = ['cod', 'salmon', 'tuna', 'anchovy', 'sardine', 'mackerel'];

const avoid = (ids: string[], severity: Rule['severity'] = 'anaphylactic'): Rule => ({
  id: `avoid-${ids.join('-')}`,
  target: { kind: 'category', ids },
  type: 'avoid',
  severity,
});
const dish = (body: string) =>
  parseRecipe(`---
title: Allergen Check
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

${body}
`);
/** A one-line dish using ingredient `id` by its graph name. */
const runWith = (id: string, rules: Rule[]) =>
  check(dish(`Add @${graph.get(id).name}{50%g}.`), rules, graph, subs, '2026-11-10');
const termIds = (name: string) => terms.find((t) => t.name === name)!.ids;

describe('EU 14 / US 9 allergen members', () => {
  it.each(Object.entries(NAMES).flatMap(([id, names]) => names.map((name) => [name, id])))(
    '"%s" resolves to %s',
    (name, id) => {
      expect(graph.resolve(name)).toBe(id);
    },
  );

  it('a water chestnut is not a chestnut', () => {
    expect(graph.resolve('water chestnut')).toBeNull();
  });

  it('tree nut descendants are every tree nut, and not peanut or coconut', () => {
    expect(graph.descendants('tree_nut').sort()).toEqual([...TREE_NUTS].sort());
    expect(graph.descendants('nut')).toEqual(expect.arrayContaining([...TREE_NUTS, 'tree_nut', 'peanut']));
    expect(graph.ancestors('coconut')).toEqual([]);
  });

  it('shellfish is crustaceans and molluscs', () => {
    expect(graph.descendants('crustacean').sort()).toEqual([...CRUSTACEANS].sort());
    expect(graph.descendants('mollusc').sort()).toEqual([...MOLLUSCS].sort());
    expect(graph.descendants('shellfish').sort()).toEqual(
      ['crustacean', 'mollusc', ...CRUSTACEANS, ...MOLLUSCS].sort(),
    );
    expect(graph.descendants('fish')).toEqual(expect.arrayContaining(FISH));
  });

  it.each([
    ...TREE_NUTS.flatMap((id) => [
      [id, 'tree_nut'],
      [id, 'nut'],
      [id, id],
    ]),
    ...CRUSTACEANS.flatMap((id) => [
      [id, 'crustacean'],
      [id, 'shellfish'],
    ]),
    ...MOLLUSCS.flatMap((id) => [
      [id, 'mollusc'],
      [id, 'shellfish'],
    ]),
    ...FISH.map((id) => [id, 'fish']),
    ['celery_stalk', 'celery'],
    ['celeriac', 'celery'],
    ['celery_seed', 'celery'],
    ['lupin_bean', 'lupin'],
    ['lupin_flour', 'lupin'],
    ['sesame_seed', 'sesame'],
    ['tahini', 'sesame'],
    ['mustard_seed', 'mustard'],
    ['wheat', 'gluten'],
    ['barley', 'gluten'],
    ['rye', 'gluten'],
    ['oats', 'gluten'],
    ['spelt', 'gluten'],
    ['kamut', 'gluten'],
    ['spelt', 'wheat'],
    ['kamut', 'wheat'],
  ])('a rule on %2$s blocks a dish with %1$s', (id, target) => {
    const result = runWith(id, [avoid([target])]);
    expect(result.status).toBe('blocked');
    expect(result.findings.find((f) => f.kind === 'match')).toMatchObject({ ingredientId: id, status: 'blocked' });
  });

  it('a mollusc rule does not block crustaceans, nor a crustacean rule molluscs', () => {
    for (const id of CRUSTACEANS) expect(runWith(id, [avoid(['mollusc'])]).status, id).toBe('ok');
    for (const id of MOLLUSCS) expect(runWith(id, [avoid(['crustacean'])]).status, id).toBe('ok');
  });

  it('a wheat rule covers spelt and khorasan, but not barley, rye or oats (they are not wheat)', () => {
    for (const id of ['barley', 'rye', 'oats']) expect(runWith(id, [avoid(['wheat'])]).status, id).toBe('ok');
  });

  it('a shellfish, nut or celery line is unverified for a rule on one of its members', () => {
    const line = (name: string, target: string) =>
      check(dish(`Add @${name}{50%g}.`), [avoid([target])], graph, subs, '2026-11-10').status;
    expect(line('shellfish', 'squid')).toBe('unverified');
    expect(line('tree nuts', 'cashew')).toBe('unverified');
    expect(line('celery', 'celeriac')).toBe('unverified');
  });

  it('vegetarian and vegan exclude every fish, crustacean and mollusc; pescatarian allows them', () => {
    for (const id of [...FISH, ...CRUSTACEANS, ...MOLLUSCS]) {
      for (const diet of ['vegetarian', 'vegan']) {
        expect(runWith(id, [avoid(termIds(diet), 'preference')]).status, `${diet} ${id}`).not.toBe('ok');
      }
      // Snail (escargot) is a land animal: not pescatarian (allergen review ruling).
      if (id !== 'snail') expect(runWith(id, [avoid(termIds('pescatarian'), 'preference')]).status, `pescatarian ${id}`).toBe('ok');
    }
  });

  it('coeliac blocks every gluten cereal', () => {
    for (const id of ['wheat', 'barley', 'rye', 'oats', 'spelt', 'kamut']) {
      expect(runWith(id, [avoid(termIds('coeliac'))]).status, id).toBe('blocked');
    }
  });

  it('a sulphite rule blocks what may carry sulphites unlabelled', () => {
    for (const id of ['gelatin', 'grated_coconut', 'prawn', 'crab', 'lobster', 'crayfish', 'squid', 'octopus']) {
      expect(runWith(id, [avoid(['sulphites'])]).status, id).toBe('blocked');
    }
  });

  describe('sulphites cannot be verified from an ingredient list', () => {
    const sulphites = avoid(['sulphites']);
    const canon = (readdirSync(join(ROOT, 'recipes'), { recursive: true }) as string[])
      .filter((f) => f.endsWith('.cook'))
      .map((f) => f.split(sep).join('/'))
      .sort();
    const canonRecipe = (file: string) => parseRecipe(readFileSync(join(ROOT, 'recipes', file), 'utf8'));

    it('finds the canon recipes', () => expect(canon.length).toBeGreaterThan(0));

    it.each(canon)('a sulphite rule never leaves %s ok', (file) => {
      for (const id of ['sulphites', graph.resolve('sulfites')!, graph.resolve('E220')!]) {
        const result = check(canonRecipe(file), [avoid([id])], graph, subs, '2026-11-10');
        expect(['unverified', 'blocked']).toContain(result.status);
        expect(result.findings.some((f) => f.kind === 'label' && f.status === 'unverified')).toBe(true);
      }
    });

    it('a plain line is unverified with a label reminder, no path claimed', () => {
      const result = runWith('rice', [sulphites]);
      expect(result.status).toBe('unverified');
      expect(result.findings).toEqual([
        {
          ingredient: 'short-grain white rice',
          ingredientId: 'rice',
          kind: 'label',
          status: 'unverified',
          ruleId: sulphites.id,
          severity: 'anaphylactic',
        },
      ]);
    });

    it('a line that is sulphites, or carries them, is still blocked', () => {
      expect(runWith('sulphites', [sulphites]).status).toBe('blocked');
      expect(runWith('gelatin', [sulphites]).status).toBe('blocked');
    });

    it('precedence stays blocked > unverified > swap > ok', () => {
      // A peanut match outranks the sulphite reminder.
      expect(runWith('peanut', [sulphites, avoid(['peanut'])]).status).toBe('blocked');
      // Vegetarian swaps bonito flakes, but the sulphite reminder outranks the swap.
      const vegetarian = avoid(['meat', 'fish'], 'preference');
      expect(runWith('bonito_flakes', [vegetarian]).status).toBe('swap');
      const both = runWith('bonito_flakes', [vegetarian, sulphites]);
      expect(both.status).toBe('unverified');
      expect(both.findings.find((f) => f.ruleId === vegetarian.id)).toMatchObject({ status: 'swap' });
      // Without the additive rule nothing changes.
      expect(runWith('rice', [avoid(['peanut'])]).status).toBe('ok');
    });

    it('a per-serving sulphite limit is never ok either', () => {
      const limit: Rule = { ...sulphites, type: 'limit', limit: { amount: 1000, unit: 'g', per: 'serving' } };
      expect(runWith('rice', [limit]).status).toBe('unverified');
      // 50 g of gelatine is under the limit, but its weight is not its sulphite content.
      expect(runWith('gelatin', [limit]).status).toBe('unverified');
    });

    it('a recipe with no ingredients is unverified for it', () => {
      const result = check(dish('Boil the kettle.'), [sulphites], graph, subs, '2026-11-10');
      expect(result.status).toBe('unverified');
      expect(result.findings).toEqual([
        {
          ingredient: '',
          ingredientId: null,
          kind: 'label',
          status: 'unverified',
          ruleId: sulphites.id,
          severity: 'anaphylactic',
        },
      ]);
      expect(check(dish('Boil the kettle.'), [avoid(['peanut'])], graph, subs, '2026-11-10').status).toBe('ok');
    });
  });

  it('new members with FDC ids carry a full per100g', () => {
    const ids = [
      ...TREE_NUTS,
      ...CRUSTACEANS,
      ...MOLLUSCS,
      ...FISH,
      'celery_stalk',
      'celeriac',
      'celery_seed',
      'lupin_bean',
      'sesame_seed',
      'tahini',
      'barley',
      'rye',
      'oats',
      'spelt',
      'kamut',
    ];
    for (const id of ids) {
      const node = graph.get(id);
      expect(node.fdcId, id).toEqual(expect.any(Number));
      expect(Object.keys(node.per100g ?? {}).sort(), id).toEqual([
        'carb_g',
        'energy_kcal',
        'fat_g',
        'fiber_g',
        'protein_g',
        'sodium_mg',
        'sugars_g',
      ]);
      expect(node.source, id).toContain(`FDC ${node.fdcId}`);
    }
  });

  it('nodes with no FDC record say so and carry no nutrition', () => {
    for (const id of ['crustacean', 'mollusc', 'celery', 'lupin', 'lupin_flour', 'sulphites']) {
      const node = graph.get(id);
      expect(node.fdcId, id).toBeUndefined();
      expect(node.per100g, id).toBeUndefined();
      expect(node.source, id).toMatch(/No FDC record/);
    }
  });

  it('a player naming cashews gets a cashew rule card', () => {
    for (const text of ['allergic to cashews', 'cashew allergy, it nearly killed me', 'anaphylactic to cashews']) {
      const statement = parseRuleStatement(text, graph);
      expect(statement?.terms, text).toHaveLength(1);
      const result = buildRuleCard(statement!.items[0], graph, terms);
      expect(result, text).toMatchObject({
        ok: true,
        card: { rule: { target: { kind: 'ingredient', ids: ['cashew'] } } },
      });
    }
    const tree = buildRuleCard({ term: 'tree nuts', severity: 'anaphylactic' }, graph, terms);
    expect(tree).toMatchObject({ ok: true, card: { rule: { target: { kind: 'category', ids: ['tree_nut'] } } } });
  });
});

describe('allergen review fixes', () => {
  const ruleFor = (name: string): Rule => {
    const r = graph.resolve(name);
    if (!r) throw new Error(`unresolved ${name}`);
    return { id: name, target: { kind: 'ingredient', ids: [r] }, type: 'avoid', severity: 'allergy' };
  };

  it('a "sesame seeds" rule blocks tahini and toasted sesame', () => {
    const rule = ruleFor('sesame seeds');
    expect(runWith('tahini', [rule]).status).toBe('blocked');
    expect(runWith('toasted_sesame_seeds', [rule]).status).toBe('blocked');
    expect(runWith('sesame_seed', [rule]).status).toBe('blocked');
  });

  it('a "sesame" rule still blocks every sesame form', () => {
    const rule = ruleFor('sesame');
    for (const id of ['tahini', 'toasted_sesame_seeds', 'sesame_seed']) expect(runWith(id, [rule]).status).toBe('blocked');
  });

  it('a "lupin beans" rule blocks lupin flour', () => {
    expect(runWith('lupin_flour', [ruleFor('lupin beans')]).status).toBe('blocked');
  });

  it('snail is not pescatarian', () => {
    const rule: Rule = { id: 'p', target: { kind: 'category', ids: termIds('pescatarian') }, type: 'avoid', severity: 'preference' };
    expect(runWith('snail', [rule]).status).not.toBe('ok');
  });

  it('sulphite salts and E-numbers resolve to sulphites', () => {
    for (const n of ['e221', 'e228', 'sodium sulphite', 'sodium bisulfite', 'sodium metabisulphite']) {
      expect(graph.resolve(n)).toBe('sulphites');
    }
  });

  it('a sulphite rule never offers a swap, even with a substitution for a sulphite carrier', () => {
    const extra: Substitution[] = [...subs, { from: 'gelatin', to: 'rice', note: 'test' }];
    const rule = ruleFor('sulphites');
    const res = check(dish(`Add @${graph.get('gelatin').name}{5%g}.`), [rule], graph, extra, '2026-11-10');
    expect(res.status).toBe('blocked');
  });
});

describe('consent gate keeps common allergen misspellings', () => {
  it.each(['muscles make my throat close', 'never give me muscles', 'no barely please', 'squad rings make me ill'])('%s is health text', async (text) => {
    const { mentionsHealthTerm } = await import('../src/mentor/route');
    expect(mentionsHealthTerm(text, graph, terms)).toBe(true);
  });
});

describe('M6 Step 4: the market nodes carry their allergen edges, never fewer (C16, C17)', () => {
  const status = (id: string, rules: Rule[]) => runWith(id, rules).status;
  const SOY = [avoid(['soy'], 'allergy')];
  const WHEAT = [avoid(['wheat'], 'allergy')];
  const COELIAC = [avoid(termIds('coeliac'), 'allergy')];
  const MILK = [avoid(['milk'], 'allergy')];

  it.each(['tofu', 'silken_tofu', 'soft_tofu', 'firm_tofu', 'extra_firm_tofu', 'tofu_puffs', 'yuba', 'tempeh', 'miso', 'edamame'])('%s reaches soy, so a soy rule blocks it', (id) => {
    expect(graph.pathTo(id, 'soy'), id).not.toBeNull();
    expect(status(id, SOY), id).toBe('blocked');
  });

  it('seitan contains wheat (so gluten), and is treated as unsafe for a soy rule (shop seitan is often simmered in soy sauce)', () => {
    expect(graph.pathTo('seitan', 'gluten')).toEqual(['seitan', 'wheat', 'gluten']);
    expect(status('seitan', WHEAT)).toBe('blocked');
    expect(status('seitan', COELIAC)).toBe('blocked');
    expect(status('seitan', SOY)).toBe('blocked');
  });

  it('asafoetida contains wheat and is label-dependent: ⛔ for a coeliac, ❓ (never ✅) under any other restricting rule', () => {
    expect(graph.get('asafoetida').labelDependent).toBe(true);
    expect(graph.pathTo('asafoetida', 'gluten')).toEqual(['asafoetida', 'wheat', 'gluten']);
    expect(status('asafoetida', COELIAC)).toBe('blocked');
    expect(status('asafoetida', [avoid(['peanut'])])).toBe('unverified');
  });

  it.each(['paneer', 'greek_yogurt'])('%s contains milk', (id) => {
    expect(graph.pathTo(id, 'milk'), id).not.toBeNull();
    expect(status(id, MILK), id).toBe('blocked');
    expect(status(id, [avoid(termIds('vegan'), 'preference')]), id).toBe('blocked');
  });

  it('furikake contains sesame and fish and is label-dependent; the blends are label-dependent', () => {
    expect(graph.pathTo('furikake', 'sesame')).not.toBeNull();
    expect(graph.pathTo('furikake', 'fish')).not.toBeNull();
    expect(status('furikake', [avoid(['sesame'])])).toBe('blocked');
    expect(status('furikake', [avoid(termIds('vegetarian'), 'preference')])).toBe('blocked');
    for (const id of ['furikake', 'garam_masala', 'curry_powder', 'miso', 'canned_bean', 'asafoetida']) {
      expect(graph.get(id).labelDependent, id).toBe(true);
      expect(status(id, [avoid(['celery'])]), id).toBe('unverified');
    }
  });

  it('every meat node is meat, so the vegetarian, vegan and pescatarian terms cover it', () => {
    const meats = ['beef', 'chicken', 'lamb', 'chuck', 'short_rib', 'shank', 'strip_steak', 'ribeye', 'flank_steak', 'brisket', 'ground_beef', 'chicken_thigh', 'chicken_breast', 'whole_chicken', 'pork_shoulder', 'pork_tenderloin', 'pork_chop', 'lamb_shoulder'];
    for (const id of meats) {
      expect(graph.pathTo(id, 'meat'), id).not.toBeNull();
      for (const term of ['vegetarian', 'vegan', 'pescatarian']) expect(status(id, [avoid(termIds(term), 'preference')]), `${id} ${term}`).toBe('blocked');
    }
    for (const id of ['pork_shoulder', 'pork_tenderloin', 'pork_chop']) expect(status(id, [avoid(termIds('no pork'), 'preference')]), id).toBe('blocked');
    expect(status('chuck', [avoid(termIds('no pork'), 'preference')])).toBe('ok');
  });

  it('a "beans" line is never ✅ under a soy or lupin rule: its kinds include edamame and lupini (category reach)', () => {
    expect(graph.get('bean').broad).toBe(true);
    expect(graph.descendants('bean')).toEqual(expect.arrayContaining(['black_bean', 'kidney_bean', 'chickpea', 'pea', 'edamame', 'lupin_bean', 'canned_bean']));
    expect(status('bean', SOY)).not.toBe('ok');
    expect(status('bean', [avoid(['lupin'])])).not.toBe('ok');
    // Pea carries no lupin edge: cross-reactivity is a clinical question (# REVIEW in content/README.md).
    expect(graph.pathTo('pea', 'lupin')).toBeNull();
  });

  it('leek and green onion reach the low-FODMAP target, like onion and shallot; fennel seed is filed under fennel', () => {
    const FODMAP = [avoid(['fodmap_fructan'], 'intolerance')];
    for (const id of ['leek', 'green_onion']) {
      expect(graph.pathTo(id, 'allium'), id).not.toBeNull();
      expect(graph.pathTo(id, 'fodmap_fructan'), id).not.toBeNull();
      expect(status(id, FODMAP), id).toBe('blocked');
    }
    expect(graph.pathTo('fennel_seed', 'fennel')).toEqual(['fennel_seed', 'fennel']);
    expect(status('fennel_seed', [avoid(['fennel'], 'allergy')])).toBe('blocked');
    expect(graph.resolve('fennel')).toBe('fennel');
  });

  it('a chilli rule reaches green and dried chillies and paprika; a coriander rule reaches leaf and seed, a cilantro rule only the leaf', () => {
    for (const id of ['green_chili', 'dried_red_chili', 'paprika']) expect(status(id, [avoid(['chili'], 'allergy')]), id).toBe('blocked');
    expect(status('cilantro', [avoid(['coriander'], 'allergy')])).toBe('blocked');
    expect(status('coriander_seed', [avoid(['coriander'], 'allergy')])).toBe('blocked');
    expect(status('coriander_seed', [avoid(['cilantro'], 'allergy')])).toBe('ok');
    expect(status('cumin_seed', [avoid(['cumin'], 'allergy')])).toBe('blocked');
    expect(status('mexican_oregano', [avoid(['oregano'], 'allergy')])).toBe('blocked');
    // Nutmeg is a seed, not a tree nut.
    expect(graph.pathTo('nutmeg', 'tree_nut')).toBeNull();
  });

  it('every new node with an FDC id carries the FDC record\'s values; one without says why in its source', () => {
    const M6 = ['avocado', 'apple', 'pear', 'banana', 'strawberry', 'blueberry', 'cranberry', 'carrot', 'potato', 'winter_squash', 'zucchini', 'kale', 'leek', 'green_onion', 'lemon', 'mandarin', 'parsnip', 'asparagus', 'cilantro', 'cabbage', 'brussels_sprout', 'ginger', 'fennel', 'kidney_bean', 'chickpea', 'pea', 'lentil', 'red_lentil', 'toor_dal', 'edamame', 'soft_tofu', 'firm_tofu', 'extra_firm_tofu', 'tofu_puffs', 'tempeh', 'miso', 'coriander_seed', 'cardamom', 'cinnamon', 'clove', 'black_pepper', 'paprika', 'fennel_seed', 'nutmeg', 'saffron', 'bay_leaf', 'oregano', 'curry_powder'];
    for (const id of M6) {
      const n = graph.get(id);
      expect(n.fdcId, id).toBeGreaterThan(160000);
      expect(n.source, id).toMatch(new RegExp(`^FDC ${n.fdcId} \\(`));
      expect(n.per100g?.energy_kcal, id).toBeGreaterThan(0);
    }
    const none = ['beef', 'chicken', 'lamb', 'bean', 'berry', 'tofu', 'silken_tofu', 'yuba', 'seitan', 'paneer', 'greek_yogurt', 'mushroom', 'nettle', 'chili', 'cumin', 'star_anise', 'mexican_oregano', 'asafoetida', 'garam_masala', 'furikake', 'canned_bean', 'coriander'];
    for (const id of none) {
      const n = graph.get(id);
      expect(n.fdcId, id).toBeUndefined();
      expect(n.per100g, id).toBeUndefined();
      expect(n.source, id).toMatch(/FDC/); // says why there is no FDC record, or which one was not used
    }
  });
});
