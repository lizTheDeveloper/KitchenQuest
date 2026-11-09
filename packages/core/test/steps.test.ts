import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseRecipe, stepPlainText } from '../src/index';

const RECIPES = join(fileURLToPath(new URL('../../../', import.meta.url)), 'recipes');
const CANON = ['india/kerala/parippu', 'japan/osaka/onigiri', 'mexico/oaxaca/frijoles-de-olla'];
const parse = (slug: string) => parseRecipe(readFileSync(join(RECIPES, `${slug}.cook`), 'utf8'));

describe('recipe steps', () => {
  test('parippu has 7 steps, onigiri 8', () => {
    expect(parse('india/kerala/parippu').steps).toHaveLength(7);
    expect(parse('japan/osaka/onigiri').steps).toHaveLength(8);
  });

  test('step items point at the flat lists', () => {
    const r = parse('india/kerala/parippu');
    const ing = r.steps[0].items.find((i) => i.type === 'ingredient')!;
    expect(r.ingredients[(ing as { index: number }).index].name).toBe('split moong dal');
    const tim = r.steps[1].items.find((i) => i.type === 'timer')!;
    expect((tim as { index: number }).index).toBe(0);
  });

  test('stepPlainText renders a step', () => {
    const r = parse('india/kerala/parippu');
    expect(stepPlainText(r, r.steps[1])).toBe(
      'Put the dal in a pot with water, turmeric and green chillies, slit lengthways. Simmer, part-covered, until soft enough to crush against the side with a spoon. Add a splash more water if it gets thick. (20 minutes)',
    );
  });

  test.each(CANON)('every ingredient and timer in %s is referenced by exactly one step item', (slug) => {
    const r = parse(slug);
    const count = (type: 'ingredient' | 'timer', n: number) =>
      r.steps.flatMap((s) => s.items).filter((i) => i.type === type && i.index === n).length;
    r.ingredients.forEach((_, n) => expect(count('ingredient', n)).toBe(1));
    r.timers.forEach((_, n) => expect(count('timer', n)).toBe(1));
  });

  test('inline quantities become text, cookware is named, text blocks are dropped', () => {
    const r = parseRecipe(`---
title: T
country: C
region: R
credit: X
cook: Y
difficulty: 1
skills: [a]
servings: 1
license: CC-BY-SA-4.0
status: draft
---
= Part one

Heat a #big pot{} with @water{1%l} for ~boil{10%minutes}.

> A note, not a step.

Add $2%tsp of salt.
`);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].section).toBe('Part one');
    expect(r.steps[0].items.some((i) => i.type === 'cookware' && i.name === 'big pot')).toBe(true);
    expect(stepPlainText(r, r.steps[0])).toBe('Heat a big pot with water for (boil: 10 minutes).');
    expect(r.steps[1].items.some((i) => i.type === 'text' && i.value.includes('tsp'))).toBe(true);
  });
});
