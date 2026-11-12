import { describe, expect, test } from 'vitest';
import type { PantryItem } from '../mentor/cards';
import type { Rule } from '../rules/types';
import { avoid, canon, dish, graph, KEEPS, MONDAY, PEANUT, subs } from './fixtures';
import type { Plan } from './plan';
import { rescueCandidate } from './use-it-up';

const TODAY = '2026-11-11'; // Wednesday, day 2 of the Monday week
type Row = PantryItem & { id: string };
const bought = (id: string, name: string, addedOn: string): Row => ({ id, name, ingredientId: graph.resolve(name), source: 'market', addedOn });
const recipes = new Map([...canon, ['test/saag', dish('leela', ['spinach', 'split moong dal'])]]);
const uses = { recipes, graph, rules: [] as Rule[], subs };
const planWith = (day: number): Plan => ({ weekStart: MONDAY, items: [{ day, kind: 'dish', slug: 'test/saag', servings: 2 }], hard: false, slot: 'unanswered' });

describe('rescueCandidate', () => {
  test('rescueCandidate: market spinach 3 days old, keeps 4 → candidate; told spinach → none; unknown keeps → none; nudgedToday → none', () => {
    const spinach = bought('p1', 'spinach', '2026-11-08');
    expect(rescueCandidate([spinach], null, TODAY, KEEPS, false, uses)).toEqual({ item: spinach, daysLeft: 1 });
    const toldSpinach: Row = { id: 'p2', name: 'spinach', ingredientId: 'spinach' };
    expect(rescueCandidate([toldSpinach], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([{ ...toldSpinach, source: 'told', addedOn: '2026-11-08' }], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([bought('p3', 'lime', '2026-11-01')], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([spinach], null, TODAY, KEEPS, true, uses)).toBeNull();
  });

  test('a stored M4 pantry row (no addedOn, no source) still parses and is never rescued', () => {
    const m4 = JSON.parse('{"id":"m4","name":"spinach","ingredientId":"spinach"}') as Row;
    expect(rescueCandidate([m4], null, TODAY, KEEPS, false, uses)).toBeNull();
  });

  test('only 0–2 days left counts: fresh items wait; past the keep time it is no longer suggested; unresolved, bad or future dates never count', () => {
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-10')], null, TODAY, KEEPS, false, uses)).toBeNull(); // 3 left
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-09')], null, TODAY, KEEPS, false, uses)).toMatchObject({ daysLeft: 2 });
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-07')], null, TODAY, KEEPS, false, uses)).toMatchObject({ daysLeft: 0 });
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-06')], null, TODAY, KEEPS, false, uses)).toBeNull(); // −1
    expect(rescueCandidate([{ ...bought('a', 'spinach', '2026-11-08'), ingredientId: null }], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-12')], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([bought('a', 'spinach', 'last week')], null, TODAY, KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-08')], null, 'today', KEEPS, false, uses)).toBeNull();
    expect(rescueCandidate([bought('a', 'spinach', '2026-11-08')], null, TODAY, { spinach: Number.NaN }, false, uses)).toBeNull();
  });

  test('at most one: the closest to its keep time, then the oldest purchase, then id', () => {
    const herb = bought('h', 'cilantro', '2026-11-08'); // cilantro has no entry of its own: no guess from "herb"
    const rice = bought('r', 'cooked rice', '2026-11-11'); // keeps 1 → 1 left
    const spinach = bought('s', 'spinach', '2026-11-07'); // 0 left
    const tomato = bought('t', 'tomato', '2026-11-08'); // 2 left
    expect(rescueCandidate([herb, rice, tomato, spinach], null, TODAY, KEEPS, false, uses)).toEqual({ item: spinach, daysLeft: 0 });
    expect(rescueCandidate([herb, tomato, rice], null, TODAY, KEEPS, false, uses)).toEqual({ item: rice, daysLeft: 1 });
    const t2 = bought('a', 'tomato', '2026-11-08');
    expect(rescueCandidate([tomato, t2], null, TODAY, KEEPS, false, uses)?.item.id).toBe('a');
  });

  test('rescueCandidate ignores an item a planned dish later this week will use', () => {
    const spinach = bought('p1', 'spinach', '2026-11-08');
    const baby = bought('p2', 'baby spinach', '2026-11-08');
    // Saag is planned for Friday (day 4): the spinach is spoken for, and so is baby spinach (a kind of spinach).
    expect(rescueCandidate([spinach, baby], planWith(4), TODAY, { ...KEEPS, baby_spinach: 4 }, false, uses)).toBeNull();
    // Planned for today: still to come.
    expect(rescueCandidate([spinach], planWith(2), TODAY, KEEPS, false, uses)).toBeNull();
    // Planned for Monday, already past: the spinach is free to rescue.
    expect(rescueCandidate([spinach], planWith(0), TODAY, KEEPS, false, uses)).toEqual({ item: spinach, daysLeft: 1 });
  });
});

describe('fix round 1, I2: rescue never names food the rules block or can\'t verify', () => {
  const keeps = { ...KEEPS, peanut_butter: 3, ghee: 30, nori: 30 };
  test('peanut butter on a peanut rule; spinach after an avoid-spinach rule; ❓ and swap-only items → none', () => {
    const pb = bought('pb', 'peanut butter', '2026-11-09');
    expect(rescueCandidate([pb], null, TODAY, keeps, false, uses)).toEqual({ item: pb, daysLeft: 1 });
    expect(rescueCandidate([pb], null, TODAY, keeps, false, { ...uses, rules: [PEANUT] })).toBeNull();
    const spinach = bought('s', 'spinach', '2026-11-08');
    expect(rescueCandidate([spinach], null, TODAY, keeps, false, { ...uses, rules: [avoid('spinach')] })).toBeNull();
    // A rule that starts after today doesn't block it today.
    expect(rescueCandidate([spinach], null, TODAY, keeps, false, { ...uses, rules: [avoid('spinach', { phase: { start: '2026-11-20' } })] })).toMatchObject({ item: spinach });
    // Nori is label-dependent: ❓ under any rule.
    const nori = bought('n', 'nori', '2026-10-13');
    expect(rescueCandidate([nori], null, TODAY, keeps, false, uses)).toMatchObject({ item: nori });
    expect(rescueCandidate([nori], null, TODAY, keeps, false, { ...uses, rules: [PEANUT] })).toBeNull();
    // Ghee under a ghee rule has a curated swap, but the item itself is still under the rule.
    const ghee = bought('g', 'ghee', '2026-10-13');
    expect(rescueCandidate([ghee], null, TODAY, keeps, false, { ...uses, rules: [avoid('ghee')] })).toBeNull();
    // The blocked one is skipped and the next one is offered.
    expect(rescueCandidate([pb, spinach], null, TODAY, keeps, false, { ...uses, rules: [PEANUT] })).toMatchObject({ item: spinach });
  });
});
