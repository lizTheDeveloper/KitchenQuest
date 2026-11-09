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
    expect(parts[0]!.replace(/-/g, ' ')).toBe(meta.country.toLowerCase());
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

  it('vegetarian onigiri swaps bonito flakes for shio kombu', () => {
    const onigiri = 'japan/osaka/onigiri.cook';
    const vegetarian = avoid('vegetarian', ['meat', 'fish'], 'preference');
    const result = run(onigiri, [vegetarian]);
    expect(result.status).not.toBe('blocked');
    expect(finding(onigiri, [vegetarian], 'bonito_flakes')).toMatchObject({
      status: 'swap',
      swap: { toId: 'shio_kombu' },
    });
    // Soy sauce is label-dependent, so the dish as a whole is still "check the label".
    expect(result.status).toBe('unverified');
    // Shio kombu is simmered in soy sauce, so wheat or soy rules still reject it.
    for (const target of ['wheat', 'soy']) {
      const rules = [vegetarian, avoid(`no-${target}`, [target], 'allergy')];
      expect(finding(onigiri, rules, 'bonito_flakes')).toMatchObject({ status: 'blocked' });
    }
  });
});
