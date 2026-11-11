import { describe, expect, test } from 'vitest';
import { DISCLAIMER, type Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import type { ClientContent } from '../content/types';
import { buildRecipeCard } from './card-model';
import { findingText, LABEL_RULE_TEXT, LABEL_STORE_BOUGHT_TEXT } from './card-view';
import { ACCOUNT_NOT_LOADED_MESSAGE, RULES_INVALID_MESSAGE, type RulesState } from './rules';

const today = '2026-11-09';
const SLUG = 'india/kerala/parippu';
const ready = (rules: Rule[]): RulesState => ({ status: 'ready', rules, source: 'device' });
const card = (rules: RulesState, opts: { showCalories?: boolean; content?: ClientContent; slug?: string } = {}) =>
  buildRecipeCard({ slug: opts.slug ?? SLUG, content: opts.content ?? content, graph, rules, today, showCalories: opts.showCalories ?? false });

const coconutSevere: Rule = { id: 'r1', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
const gheeIntolerance: Rule = { id: 'r2', target: { kind: 'ingredient', ids: ['ghee'] }, type: 'avoid', severity: 'intolerance', note: 'ghee upsets me' };

describe('buildRecipeCard', () => {
  test('no rules: parippu ok and cookable', () => {
    const c = card(ready([]));
    expect(c).toMatchObject({
      slug: SLUG, status: 'ok', rulesChecked: 0, rulesError: null, disclaimer: null, severe: false,
      cookable: true, notCookableReason: null, draft: true, sacred: false, findings: [],
    });
    expect(c.title).toBe(content.recipes[SLUG].meta.title);
    expect(c.cook).toEqual({ id: 'leela', name: content.cooks.leela.name });
    expect(c.skills.map((s) => s.id)).toEqual(content.recipes[SLUG].meta.skills);
    expect(c.skills.every((s) => s.name !== '')).toBe(true);
    expect(c.license).toBe('CC-BY-SA-4.0');
  });

  test('severe coconut: parippu blocked', () => {
    const c = card(ready([coconutSevere]));
    expect(c).toMatchObject({ status: 'blocked', cookable: false, notCookableReason: 'blocked', severe: true, rulesChecked: 1 });
    expect(c.disclaimer).toBe(DISCLAIMER);
  });

  test('ghee intolerance: parippu swap', () => {
    // Brief deviation: the plan expected status 'swap', but parippu's pappadam is store-bought
    // (labelDependent), so under any restricting rule core reports it ❓ and unverified outranks swap.
    // Can't verify is never safe (§2.2): the card follows core. The ghee line is still a swap.
    const c = card(ready([gheeIntolerance]));
    expect(c.status).toBe('unverified');
    expect(c.findings.find((x) => x.ingredient === 'pappadam')).toMatchObject({ kind: 'label', status: 'unverified' });
    expect(c.cookable).toBe(true);
    expect(c.severe).toBe(false);
    expect(c.disclaimer).toBeNull();
    const f = c.findings.find((x) => x.swapLabel !== null);
    expect(f?.swapLabel).toBe(`swapped: ${graph.get('neutral_oil').name} for ghee`);
    expect(f?.ruleNote).toBe('ghee upsets me');
    expect(f?.status).toBe('swap');
  });

  test('ghee intolerance without the store-bought pappadam: the card is a swap', () => {
    const recipe = structuredClone(content.recipes[SLUG]);
    recipe.ingredients = recipe.ingredients.filter((i) => i.name !== 'pappadam');
    const noPappadam: ClientContent = { ...content, recipes: { ...content.recipes, [SLUG]: recipe } };
    const c = card(ready([gheeIntolerance]), { content: noPappadam });
    expect(c.status).toBe('swap');
    expect(c.cookable).toBe(true);
    expect(c.findings.map((x) => x.swapLabel)).toContain(`swapped: ${graph.get('neutral_oil').name} for ghee`);
  });

  test('rules error: unverified, not blocked, not ok', () => {
    const c = card({ status: 'error', reason: 'invalid', message: RULES_INVALID_MESSAGE, problems: ['Rule "r1": target id "not_an_id" is not in the ingredient graph'] });
    expect(c.status).toBe('unverified');
    // The player's message and a way to fix it; core's problem text never reaches a card.
    expect(c.rulesError).toBe(RULES_INVALID_MESSAGE);
    expect(c.rulesLink).toBe(true);
    expect(JSON.stringify(c)).not.toContain('not_an_id');
    expect(c.findings).toEqual([]);
    expect(c.cookable).toBe(true);
    expect(c.notCookableReason).toBeNull();
    // Signed in with the account rules not loaded: no rules screen fixes that, so no link.
    expect(card({ status: 'error', reason: 'account_not_loaded', message: ACCOUNT_NOT_LOADED_MESSAGE, problems: [] }).rulesLink).toBe(false);
    // We can't know whether a severe rule is among them, so the allergy disclaimer shows.
    expect(c.severe).toBe(true);
    expect(c.disclaimer).toBe(DISCLAIMER);
  });

  test('calories hidden by default', () => {
    expect(card(ready([])).nutrition.rows.map((r) => r.nutrient)).not.toContain('energy_kcal');
    expect(card(ready([])).nutrition.rows.map((r) => r.nutrient))
      .toEqual(['protein_g', 'fat_g', 'carb_g', 'fiber_g', 'sugars_g', 'sodium_mg']);
    const on = card(ready([]), { showCalories: true }).nutrition.rows;
    expect(on[0].nutrient).toBe('energy_kcal');
    expect(on[0].value).toMatch(/^\d+ kcal$/);
  });

  test('nutrition values are whole numbers with units', () => {
    const rows = card(ready([]), { showCalories: true }).nutrition.rows;
    const unit: Record<string, string> = { energy_kcal: 'kcal', sodium_mg: 'mg' };
    for (const r of rows) expect(r.value).toMatch(new RegExp(`^\\d+ ${unit[r.nutrient] ?? 'g'}$`));
    expect(rows.map((r) => r.label)).toEqual(['Energy', 'Protein', 'Fat', 'Carbohydrate', 'Fiber', 'Sugars', 'Sodium']);
  });

  test('sacred dish is never cookable', () => {
    const recipe = structuredClone(content.recipes[SLUG]);
    recipe.meta.sacred = true;
    const sacred: ClientContent = { ...content, recipes: { ...content.recipes, [SLUG]: recipe } };
    for (const rules of [ready([]), ready([coconutSevere]), { status: 'error', message: 'x' } as RulesState]) {
      const c = card(rules, { content: sacred });
      expect(c.sacred).toBe(true);
      expect(c.cookable).toBe(false);
      expect(c.notCookableReason).toBe('sacred');
    }
  });

  test('finding path uses names', () => {
    const c = card(ready([coconutSevere]));
    const f = c.findings.find((x) => x.ingredient === 'grated coconut');
    expect(f).toBeDefined();
    expect(f!.status).toBe('blocked');
    expect(f!.path).toContain(' → ');
    expect(f!.path).toBe(['grated_coconut', 'coconut'].map((id) => graph.get(id).name).join(' → '));
    expect(f!.ruleNote).toBeNull();
  });

  test('every recipe builds a card with no rules', () => {
    for (const slug of Object.keys(content.recipes)) expect(card(ready([]), { slug }).slug).toBe(slug);
  });

  test('an unknown slug throws naming it', () => {
    expect(() => card(ready([]), { slug: 'nope/nope' })).toThrow(/nope\/nope/);
  });
});

describe('label findings and their wording', () => {
  const limitG: Rule = { id: 'r3', target: { kind: 'ingredient', ids: ['turmeric'] }, type: 'limit', severity: 'preference', limit: { amount: 1, unit: 'g', per: 'serving' } };

  test('a store-bought flag has no rule behind it; an unmeasured limit does', () => {
    const store = card(ready([gheeIntolerance])).findings.find((f) => f.ingredient === 'pappadam')!;
    expect(store).toMatchObject({ kind: 'label', fromRule: false });
    const limited = card(ready([limitG])).findings.find((f) => f.ingredient === 'turmeric')!;
    expect(limited).toMatchObject({ kind: 'label', fromRule: true });
  });

  test('wording follows the cause: brand wording only for store-bought', () => {
    const store = card(ready([gheeIntolerance])).findings.find((f) => f.ingredient === 'pappadam')!;
    const limited = card(ready([limitG])).findings.find((f) => f.ingredient === 'turmeric')!;
    expect(findingText(store)).toBe(LABEL_STORE_BOUGHT_TEXT);
    expect(findingText(limited)).toBe(LABEL_RULE_TEXT);
    expect(findingText(limited)).not.toMatch(/store-bought|brand/);
  });
});
