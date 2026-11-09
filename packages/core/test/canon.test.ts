import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IngredientGraph, check, nutritionPerServing, parseRecipe } from '../src/index';
import type { IngredientData, Rule, Substitution } from '../src/index';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const RECIPES = join(ROOT, 'recipes');

const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const data = readJson('data/ingredients.json') as IngredientData;
const subs = readJson('data/substitutions.json') as Substitution[];

/** Every .cook file under recipes/, as a path relative to recipes/ (e.g. india/kerala/parippu.cook). */
const files = (readdirSync(RECIPES, { recursive: true }) as string[])
  .filter((f) => f.endsWith('.cook'))
  .map((f) => f.split(sep).join('/'))
  .sort();
const source = (file: string) => readFileSync(join(RECIPES, file), 'utf8');

describe('canon', () => {
  it('finds the canon recipes', () => {
    expect(files).toEqual([
      'india/kerala/parippu.cook',
      'japan/osaka/onigiri.cook',
      'mexico/oaxaca/frijoles-de-olla.cook',
    ]);
  });

  it('graph data loads', () => {
    expect(() => IngredientGraph.fromData(data)).not.toThrow();
  });

  const graph = IngredientGraph.fromData(data);

  it.each(files)('every canon recipe parses: %s', (file) => {
    expect(() => parseRecipe(source(file))).not.toThrow();
  });

  it.each(files)('every canon ingredient resolves: %s', (file) => {
    const recipe = parseRecipe(source(file));
    expect(check(recipe, [], graph, subs, '2026-11-09').findings).toEqual([]);
  });

  it.each(files)('canon metadata: %s', (file) => {
    const { meta } = parseRecipe(source(file));
    expect(meta.license).toBe('CC-BY-SA-4.0');
    expect(meta.credit.trim()).not.toBe('');
    const parts = file.split('/');
    expect(parts).toHaveLength(3); // <country>/<region>/<slug>.cook
    expect(parts[0].replace(/-/g, ' ')).toBe(meta.country.toLowerCase());
  });

  it.each(files)('nutrition is complete: %s', (file) => {
    const { missing, perServing } = nutritionPerServing(parseRecipe(source(file)), graph);
    expect(missing).toEqual([]);
    expect(perServing.energy_kcal).toBeGreaterThan(0);
  });

  const avoid = (id: string, ids: string[], severity: Rule['severity']): Rule => ({
    id,
    target: { kind: 'category', ids },
    type: 'avoid',
    severity,
  });
  const run = (file: string, rules: Rule[]) => check(parseRecipe(source(file)), rules, graph, subs, '2026-11-09');
  const finding = (file: string, rules: Rule[], id: string) =>
    run(file, rules).findings.find((f) => f.ingredientId === id && f.kind === 'match');

  it('coconut allergy blocks parippu', () => {
    const result = run('india/kerala/parippu.cook', [avoid('coconut-allergy', ['coconut'], 'allergy')]);
    expect(result.status).toBe('blocked');
    const grated = result.findings.find((f) => f.ingredientId === 'grated_coconut');
    expect(grated).toMatchObject({ status: 'blocked', path: ['grated_coconut', 'coconut'] });
    expect(grated?.swap).toBeUndefined();
  });

  it('low-FODMAP swaps garlic for garlic-infused oil; a garlic allergy never does', () => {
    const frijoles = 'mexico/oaxaca/frijoles-de-olla.cook';
    const lowFodmap = avoid('low-fodmap', ['fodmap_fructan'], 'intolerance');
    expect(finding(frijoles, [lowFodmap], 'garlic')).toMatchObject({
      status: 'swap',
      swap: { toId: 'garlic_infused_oil' },
    });
    for (const target of ['garlic', 'allium']) {
      const allergy = finding(frijoles, [avoid('garlic-allergy', [target], 'anaphylactic')], 'garlic');
      expect(allergy).toMatchObject({ status: 'blocked' });
      expect(allergy?.swap).toBeUndefined();
    }
  });

  it('vegetarian onigiri swaps bonito flakes for toasted sesame, never label-dependent shio kombu', () => {
    const onigiri = 'japan/osaka/onigiri.cook';
    const vegetarian = avoid('vegetarian', ['meat', 'fish'], 'preference');
    const result = run(onigiri, [vegetarian]);
    expect(finding(onigiri, [vegetarian], 'bonito_flakes')).toMatchObject({
      status: 'swap',
      swap: { toId: 'toasted_sesame_seeds' },
    });
    // Soy sauce, nori and umeboshi are label-dependent, so the dish is still "check the label".
    expect(result.status).toBe('unverified');

    // With a sesame allergy too, no clean swap is left (shio kombu is label-dependent).
    const sesame = [vegetarian, avoid('sesame-allergy', ['sesame'], 'allergy')];
    const blocked = finding(onigiri, sesame, 'bonito_flakes');
    expect(blocked).toMatchObject({ status: 'blocked' });
    expect(blocked?.swap).toBeUndefined();
    expect(run(onigiri, sesame).status).toBe('blocked');
  });

  // The real seed graph, not a fixture: these depend on how data/ingredients.json models things.
  const dish = (body: string) =>
    parseRecipe(`---
title: Seed Check
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
  const runOn = (body: string, rules: Rule[]) => check(dish(body), rules, graph, subs, '2026-11-09');

  it('garlic-infused oil is unsafe for a garlic or allium allergy, fine for low-FODMAP', () => {
    const oil = 'Fry in @garlic-infused oil{1%tbsp}.';
    for (const target of ['garlic', 'allium']) {
      expect(runOn(oil, [avoid('garlic-allergy', [target], 'anaphylactic')]).status).toBe('blocked');
    }
    expect(runOn(oil, [avoid('low-fodmap', ['fodmap_fructan'], 'intolerance')]).status).toBe('ok');
  });

  it('a category line is unverified for a rule on one of its kinds', () => {
    expect(runOn('Add @nuts{50%g}.', [avoid('peanut', ['peanut'], 'anaphylactic')]).status).toBe('unverified');
    expect(runOn('Add @meat{200%g}.', [avoid('no-pork', ['pork'], 'preference')]).status).toBe('unverified');
    expect(runOn('Add @mustard{1%tsp}.', [avoid('seeds', ['mustard_seed'], 'allergy')]).status).toBe('unverified');
  });

  it('lard contains pork rather than being a kind of pork, so a pork line is fine for a lard rule', () => {
    expect(runOn('Add @pork{200%g}.', [avoid('no-lard', ['lard'], 'preference')]).status).toBe('ok');
    // ...while lard still reaches pork and meat.
    for (const target of ['pork', 'meat']) {
      const result = runOn('Fry in @lard{1%tbsp}.', [avoid('no-pork', [target], 'preference')]);
      expect(result.findings[0]).toMatchObject({ ingredientId: 'lard', kind: 'match', status: 'swap' });
      expect(result.findings[0].path!.at(-1)).toBe(target);
    }
  });
});
