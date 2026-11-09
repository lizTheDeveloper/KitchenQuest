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

  it('coconut allergy blocks parippu', () => {
    const coconut: Rule = {
      id: 'coconut-allergy',
      target: { kind: 'category', ids: ['coconut'] },
      type: 'avoid',
      severity: 'allergy',
    };
    const result = check(parseRecipe(source('india/kerala/parippu.cook')), [coconut], graph, subs, '2026-11-09');
    expect(result.status).toBe('blocked');
    const grated = result.findings.find((f) => f.ingredientId === 'grated_coconut');
    expect(grated).toMatchObject({ status: 'blocked', path: ['grated_coconut', 'coconut'] });
    expect(grated?.swap).toBeUndefined();
  });
});
