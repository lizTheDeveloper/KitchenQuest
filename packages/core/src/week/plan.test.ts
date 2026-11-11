import { describe, expect, test } from 'vitest';
import { planWeekStart } from '../progress/week';
import type { ParsedRecipe } from '../recipe/types';
import { ALLIUM, avoid, canon, dish, MONDAY, planCtx, SATURDAY } from './fixtures';
import { checkPlan, MAX_PLAN_ITEMS, PLAN_DISH_SACRED_TRIGGER, planFlags, resolvePlanRequest, suggestPlan, validatePlan, type Plan, type PlanItem } from './plan';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const plan = (items: PlanItem[], weekStart = MONDAY): Plan => ({ weekStart, items, hard: false, slot: 'unanswered' });
const req = (days: [string, string][] | null, pick: number | null = null, after: string | null = null) => ({
  days: days?.map(([dish, weekday]) => ({ weekday, dish })) ?? null,
  pick,
  hard: null,
  after,
});

/** Three small dishes, one per cook, plus a ❓ one: allium blocks two of the three. */
const SMALL: ReadonlyMap<string, ParsedRecipe> = new Map([
  ['test/plain-dal', dish('leela', ['split moong dal', 'salt'])],
  ['test/bean-pot', dish('marisol', ['dried black bean', 'onion', 'salt'])],
  ['test/shallot-rice', dish('haruka', ['short-grain white rice', 'shallot'])],
  ['test/mystery', dish('haruka', ['jasmine-ish paste'])],
]);

describe('resolvePlanRequest', () => {
  test('T07 shape: "parippu Sunday, onigiri Monday, eggs Wednesday" → two items, Sunday parippu and Monday onigiri, on the right day offsets; unknown ["eggs"]', () => {
    const r = resolvePlanRequest(req([['parippu', 'Sunday'], ['onigiri', 'Monday'], ['eggs', 'Wednesday']]), planCtx());
    // The week starts Monday 2026-11-09: Monday is day 0, Sunday day 6.
    expect(r.items).toEqual([
      { day: 6, kind: 'dish', slug: PARIPPU, servings: 3 },
      { day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 },
    ]);
    expect(r.unknown).toEqual(['eggs']);
    expect(r.dropped).toEqual([]);
  });

  test('day offsets follow the plan week: a Saturday-start week puts Saturday on day 0 and Friday on day 6', () => {
    const r = resolvePlanRequest(req([['parippu', 'sat'], ['onigiri', 'Fridays']]), planCtx({ weekStart: SATURDAY }));
    expect(r.items.map((i) => i.day)).toEqual([0, 6]);
  });

  test('no alias: "dal Sunday" → no item, unknown ["dal"]; "frijoles" alone → unknown; "frijoles de olla" → frijoles-de-olla (C1)', () => {
    expect(resolvePlanRequest(req([['dal', 'Sunday']]), planCtx())).toMatchObject({ items: [], unknown: ['dal'] });
    expect(resolvePlanRequest(req([['frijoles', 'Tuesday']]), planCtx())).toMatchObject({ items: [], unknown: ['frijoles'] });
    expect(resolvePlanRequest(req([['frijoles de olla', 'Tuesday']]), planCtx()).items).toEqual([{ day: 1, kind: 'dish', slug: FRIJOLES, servings: 6 }]);
  });

  test('C19: unknown keeps the player\'s words, trimmed, with one leading "the", "a" or "an" dropped and nothing else changed', () => {
    const r = resolvePlanRequest(
      req([['  the dal ', 'Sunday'], ['your eggs', 'Wednesday'], ['An Omelette', 'Monday'], ['the the soup', 'Friday'], ['   ', 'Friday']]),
      planCtx(),
    );
    expect(r.unknown).toEqual(['dal', 'your eggs', 'Omelette', 'the soup']);
  });

  test('a dish whose weekday names no single day is not placed and is reported in noDay', () => {
    const r = resolvePlanRequest(req([['parippu', 'weekend'], ['onigiri', 'tonight']]), planCtx());
    expect(r.items).toEqual([]);
    expect(r.noDay).toEqual(['parippu', 'onigiri']);
  });

  test('T08 shape: pick 3, after Saturday, market day Saturday → three items on days after the market day', () => {
    const weekStart = planWeekStart('2026-11-11', [6]);
    expect(weekStart).toBe(SATURDAY);
    const r = resolvePlanRequest(req(null, 3, 'Saturday'), planCtx({ weekStart }));
    expect(r.items).toHaveLength(3);
    for (const i of r.items) expect(i.day).toBeGreaterThan(0);
    // Variety by cook: one dish from each of the three cooks.
    expect(new Set(r.items.map((i) => canon.get(i.slug)!.meta.cook))).toEqual(new Set(['leela', 'marisol', 'haruka']));
  });

  test('pick fills around the named dishes: never the same day, never the same dish', () => {
    const r = resolvePlanRequest(req([['parippu', 'Monday']], 2), planCtx());
    expect(r.items[0]).toMatchObject({ day: 0, slug: PARIPPU });
    expect(r.items.slice(1).map((i) => i.day)).toEqual([1, 2]);
    expect(new Set(r.items.map((i) => i.slug)).size).toBe(3);
  });

  test('a blocked dish named by the player is dropped and reported, never placed', () => {
    const r = resolvePlanRequest(req([['frijoles de olla', 'Tuesday'], ['parippu', 'Wednesday'], ['onigiri', 'Thursday']]), planCtx({ rules: [ALLIUM] }));
    expect(r.dropped).toEqual([
      { slug: FRIJOLES, status: 'blocked' },
      { slug: PARIPPU, status: 'blocked' },
    ]);
    // Onigiri is ❓ under any rule (label-dependent lines): the player chose it, so it is placed, and shows as ❓.
    expect(r.items).toEqual([{ day: 3, kind: 'dish', slug: ONIGIRI, servings: 6 }]);
    expect(checkPlan(plan(r.items), planCtx({ rules: [ALLIUM] }))[0].status).toBe('unverified');
  });

  test('a named dish is checked on its own day: a rule that starts Thursday drops only the Thursday entry', () => {
    const r = resolvePlanRequest(req([['parippu', 'Wednesday'], ['parippu', 'Thursday']]), planCtx({ rules: [avoid('shallot', { phase: { start: '2026-11-12' } })] }));
    expect(r.items.map((i) => i.day)).toEqual([2]);
    expect(r.dropped).toEqual([{ slug: PARIPPU, status: 'blocked' }]);
  });

  test('a sacred dish is never planned', () => {
    const sacred = new Map([...canon, ['test/sacred', dish('leela', ['salt'], { title: 'Festival Payasam', sacred: true })]]);
    const r = resolvePlanRequest(req([['festival payasam', 'Monday']], 7), planCtx({ recipes: sacred }));
    expect(r.items.some((i) => i.slug === 'test/sacred')).toBe(false);
    expect(r.unknown).toEqual([]);
    expect(r.sacred).toEqual(['test/sacred']);
  });
});

describe('suggestPlan', () => {
  test('suggestPlan: rules block 2 of 3 dishes → returns 1, never pads with ⛔ or ❓; a ❓ dish is never picked', () => {
    const ctx = planCtx({ recipes: SMALL, rules: [ALLIUM] });
    const picked = suggestPlan(3, ctx);
    expect(picked).toEqual([{ day: 0, kind: 'dish', slug: 'test/plain-dal', servings: 2 }]);
    for (const c of checkPlan(plan(picked), ctx)) expect(['ok', 'swap']).toContain(c.status);
    // With no rules the ❓ mystery dish is still never picked.
    const free = suggestPlan(7, planCtx({ recipes: SMALL }));
    expect(free.map((i) => i.slug).sort()).toEqual(['test/bean-pot', 'test/plain-dal', 'test/shallot-rice']);
  });

  test('canon under any rule: every dish is ⛔ or ❓, so nothing is picked', () => {
    expect(suggestPlan(3, planCtx({ rules: [avoid('peanut')] }))).toEqual([]);
  });

  test('a dish is picked only on a day it passes: a rule from Thursday moves it nowhere past Wednesday', () => {
    const one = new Map([['test/bean-pot', SMALL.get('test/bean-pot')!]]);
    const ctx = planCtx({ recipes: one, rules: [avoid('onion', { phase: { start: '2026-11-09', end: '2026-11-10' } })] });
    expect(suggestPlan(1, ctx)).toEqual([{ day: 2, kind: 'dish', slug: 'test/bean-pot', servings: 2 }]);
  });

  test('variety by cook, avoid days, existing days and dishes; deterministic; n is clamped', () => {
    const ctx = planCtx({ existing: [{ day: 0, kind: 'dish', slug: PARIPPU, servings: 3 }] });
    const picked = suggestPlan(2, ctx, [1]);
    expect(picked).toEqual([
      { day: 2, kind: 'dish', slug: ONIGIRI, servings: 6 },
      { day: 3, kind: 'dish', slug: FRIJOLES, servings: 6 },
    ]);
    expect(suggestPlan(2, ctx, [1])).toEqual(picked);
    expect(suggestPlan(-1, ctx)).toEqual([]);
    expect(suggestPlan(Number.NaN, ctx)).toEqual([]);
    expect(suggestPlan(100, ctx)).toHaveLength(2); // only two unplanned canon dishes remain
  });
});

describe('checkPlan and planFlags', () => {
  test('checkPlan checks each item on its own date (a phased rule active from Thursday blocks only Thursday)', () => {
    const rule = avoid('shallot', { phase: { start: '2026-11-12' } });
    const checks = checkPlan(plan([{ day: 2, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 3, kind: 'dish', slug: PARIPPU, servings: 3 }]), planCtx({ rules: [rule] }));
    expect(checks.map((c) => c.status)).toEqual(['ok', 'blocked']);
    expect(checks[1].findings).toContainEqual(expect.objectContaining({ ingredientId: 'shallot', status: 'blocked', ruleId: 'r-shallot' }));
  });

  test('checkPlan: an unknown slug is ❓, never ✅; a lesson item is checked like its dish', () => {
    const checks = checkPlan(plan([{ day: 0, kind: 'dish', slug: 'not/a-dish', servings: 1 }, { day: 1, kind: 'lesson', slug: PARIPPU }]), planCtx({ rules: [ALLIUM] }));
    expect(checks.map((c) => c.status)).toEqual(['unverified', 'blocked']);
  });

  test('planFlags: unknown ids never yield balanced; no veg_fruit → gap_green', () => {
    // Onigiri: rice (grain) and bonito flakes (fish → protein), nothing green.
    expect(planFlags(plan([{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }]), planCtx())).toBe('gap_green');
    // Onigiri + parippu: dal (protein), shallot and garlic (allium → veg_fruit), rice (grain).
    expect(planFlags(plan([{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }, { day: 1, kind: 'dish', slug: PARIPPU, servings: 3 }]), planCtx())).toBe('balanced');
    // Unresolved names that sound like every group, plus a food-groups id the graph doesn't hold: never balanced.
    const vague = new Map([['test/vague', dish('leela', ['mixed greens', 'kale', 'grain bowl', 'split moong dal'])]]);
    expect(planFlags(plan([{ day: 0, kind: 'dish', slug: 'test/vague', servings: 2 }]), planCtx({ recipes: vague }))).toBe('gap_green');
  });

  test('planFlags: no protein → gap_protein; only grain missing → null; empty → null; a ⛔ item counts for nothing', () => {
    const greensRice = new Map([...canon, ['test/greens', dish('haruka', ['spinach', 'cooked rice'])], ['test/greens-only', dish('haruka', ['spinach', 'split moong dal'])]]);
    const ctx = planCtx({ recipes: greensRice });
    expect(planFlags(plan([{ day: 0, kind: 'dish', slug: 'test/greens', servings: 2 }]), ctx)).toBe('gap_protein');
    expect(planFlags(plan([{ day: 0, kind: 'dish', slug: 'test/greens-only', servings: 2 }]), ctx)).toBeNull();
    expect(planFlags(plan([]), ctx)).toBeNull();
    expect(planFlags(plan([{ day: 0, kind: 'lesson', slug: PARIPPU }]), ctx)).toBeNull();
    // Parippu is ⛔ under allium, so with onigiri the plan is not balanced: its greens don't count.
    const both = plan([{ day: 0, kind: 'dish', slug: ONIGIRI, servings: 6 }, { day: 1, kind: 'dish', slug: PARIPPU, servings: 3 }]);
    expect(planFlags(both, planCtx({ rules: [ALLIUM] }))).toBe('gap_green');
  });
});

describe('validatePlan', () => {
  const ok = plan([{ day: 0, kind: 'dish', slug: PARIPPU, servings: 3 }, { day: 6, kind: 'lesson', slug: ONIGIRI }]);
  test('accepts a well-formed plan', () => {
    expect(validatePlan(ok, planCtx())).toEqual([]);
  });

  test('day 0–6, ≤ MAX_PLAN_ITEMS, known slug, servings 0.5–10, no sacred, no extra fields; never throws', () => {
    const sacred = new Map([...canon, ['test/sacred', dish('leela', ['salt'], { sacred: true })]]);
    const ctx = planCtx({ recipes: sacred });
    const bad = (items: unknown[]) => validatePlan({ ...ok, items }, ctx);
    expect(bad([{ day: 7, kind: 'dish', slug: PARIPPU, servings: 3 }])).toEqual(['plan: item 0: day is not 0–6']);
    expect(bad([{ day: 1.5, kind: 'lesson', slug: PARIPPU }])).toEqual(['plan: item 0: day is not 0–6']);
    expect(bad([{ day: 0, kind: 'dish', slug: 'nope', servings: 3 }])).toEqual(['plan: item 0: unknown recipe']);
    expect(bad([{ day: 0, kind: 'dish', slug: 'test/sacred', servings: 3 }])).toEqual(['plan: item 0: sacred recipes are not planned']);
    expect(bad([{ day: 0, kind: 'dish', slug: PARIPPU, servings: 0.25 }])).toEqual(['plan: item 0: servings is not 0.5–10']);
    expect(bad([{ day: 0, kind: 'dish', slug: PARIPPU, servings: 11 }])).toEqual(['plan: item 0: servings is not 0.5–10']);
    expect(bad([{ day: 0, kind: 'dish', slug: PARIPPU, servings: 3, note: 'for Sam' }])).toEqual(['plan: item 0: unknown field "note"']);
    expect(bad([{ day: 0, kind: 'meal', slug: PARIPPU }])).toEqual(['plan: item 0: kind is not dish or lesson']);
    expect(bad(Array.from({ length: MAX_PLAN_ITEMS + 1 }, () => ({ day: 0, kind: 'lesson', slug: PARIPPU })))).toEqual([`plan: more than ${MAX_PLAN_ITEMS} items`]);
    expect(bad(Array.from({ length: MAX_PLAN_ITEMS }, () => ({ day: 0, kind: 'lesson', slug: PARIPPU })))).toEqual([]);
    expect(validatePlan({ ...ok, weekStart: '2026-13-01', hard: 'no', slot: 'maybe', extra: 1 }, ctx)).toHaveLength(4);
    for (const junk of [null, 1, 'plan', [], { items: 'x' }, { items: [null, 3] }]) expect(() => validatePlan(junk, ctx)).not.toThrow();
  });
});

describe('fix round 1', () => {
  const xmas = new Map([...canon, ['test/christmas-parippu', dish('leela', ['split moong dal', 'salt'], { title: 'Christmas Parippu', sacred: true })]]);
  test('I3: "christmas parippu" → sacred, nothing placed, never the shorter ordinary parippu', () => {
    const r = resolvePlanRequest(req([['christmas parippu', 'Sunday']]), planCtx({ recipes: xmas }));
    expect(r.items).toEqual([]);
    expect(r.sacred).toEqual(['test/christmas-parippu']);
    expect(r.unknown).toEqual([]);
    // Plain "parippu" is still the ordinary dish.
    expect(resolvePlanRequest(req([['parippu', 'Sunday']]), planCtx({ recipes: xmas })).items).toEqual([{ day: 6, kind: 'dish', slug: PARIPPU, servings: 3 }]);
    // Pick never places a sacred dish.
    expect(suggestPlan(7, planCtx({ recipes: xmas })).some((i) => i.slug === 'test/christmas-parippu')).toBe(false);
    expect(PLAN_DISH_SACRED_TRIGGER).toBe('plan.dish_sacred');
  });

  test('M3: an `after` that names no single day is reported for an ask, and nothing is picked', () => {
    const r = resolvePlanRequest(req(null, 3, 'the weekend'), planCtx());
    expect(r.items).toEqual([]);
    expect(r.afterNoDay).toBe('the weekend');
    expect(resolvePlanRequest(req(null, 3, 'Saturday'), planCtx()).afterNoDay).toBeNull();
    expect(resolvePlanRequest(req(null, 3), planCtx()).afterNoDay).toBeNull();
  });
});
