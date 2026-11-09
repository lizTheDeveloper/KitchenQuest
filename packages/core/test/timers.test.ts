import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parseRecipe, timerSeconds } from '../src/index';

const RECIPES = join(fileURLToPath(new URL('../../../', import.meta.url)), 'recipes');
const t = (quantity: number | null, unit: string | null) => ({ name: null, quantity, unit });

describe('timerSeconds', () => {
  test('converts units', () => {
    expect(timerSeconds(t(30, 'seconds'))).toBe(30);
    expect(timerSeconds(t(20, 'minutes'))).toBe(1200);
    expect(timerSeconds(t(2, 'hours'))).toBe(7200);
    expect(timerSeconds(t(1, 'Min'))).toBe(60);
    expect(timerSeconds(t(1, 'HRS'))).toBe(3600);
    expect(timerSeconds(t(5, 's'))).toBe(5);
  });

  test('throws on a timer it cannot use, naming the timer', () => {
    expect(() => timerSeconds(t(5, null))).toThrow(/timer/);
    expect(() => timerSeconds(t(3, 'fortnight'))).toThrow(/timer/);
    expect(() => timerSeconds(t(null, 'minutes'))).toThrow(/timer/);
    expect(() => timerSeconds(t(0, 'minutes'))).toThrow(/timer/);
    expect(() => timerSeconds(t(-2, 'minutes'))).toThrow(/timer/);
    expect(() => timerSeconds({ name: 'boil', quantity: 3, unit: 'x' })).toThrow(/boil/);
  });

  test.each(['india/kerala/parippu', 'japan/osaka/onigiri', 'mexico/oaxaca/frijoles-de-olla'])(
    'every timer in %s converts',
    (slug) => {
      const r = parseRecipe(readFileSync(join(RECIPES, `${slug}.cook`), 'utf8'));
      for (const timer of r.timers) expect(timerSeconds(timer)).toBeGreaterThan(0);
    },
  );
});
