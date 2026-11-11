import { describe, expect, it } from 'vitest';
import { graph, recipes, subs, techniqueNodes } from '../quests/fixtures';
import type { ParsedRecipe } from '../recipe/types';
import type { Rule } from '../rules/types';
import { ONE_MORE_PER_WEEK, weeklySlot, type WeeklySlotInput } from './one-more';
import type { Tier, ToolkitState } from './types';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const WEEK = '2026-11-09';

const tk = (entries: Record<string, [Tier, string?]>): ToolkitState => ({
  techniques: Object.fromEntries(
    Object.entries(entries).map(([id, [tier, lastUsedAt = WEEK]]) => [id, { tier, firstAt: '2025-01-01', lastUsedAt, recipes: [] }]),
  ),
});

/** After cooking frijoles de olla: legumes, heat-control and patience at Tried. */
const AFTER_FRIJOLES = tk({ legumes: ['tried'], 'heat-control': ['tried'], patience: ['tried'] });

const input = (over: Partial<WeeklySlotInput> = {}): WeeklySlotInput => ({
  toolkit: AFTER_FRIJOLES,
  techniques: techniqueNodes,
  recipes,
  taught: new Set(recipes.keys()),
  planned: [],
  rules: [],
  graph,
  subs,
  weekStart: WEEK,
  today: WEEK,
  thresholds: { warmAfterDays: 42, rustyAfterDays: 120 },
  week: { hard: false, slot: 'unanswered' },
  ...over,
});

const avoid = (kind: Rule['target']['kind'], id: string, phase?: Rule['phase']): Rule => ({
  id: `r-${id}`,
  target: { kind, ids: [id] },
  type: 'avoid',
  severity: 'allergy',
  ...(phase ? { phase } : {}),
});

const withRecipe = (slug: string, r: ParsedRecipe): ReadonlyMap<string, ParsedRecipe> => new Map([...recipes, [slug, r]]);

describe('weeklySlot', () => {
  it('is one a week', () => {
    expect(ONE_MORE_PER_WEEK).toBe(1);
  });

  it('weeklySlot: one new adjacent technique with an ok dish; prereq missing → none; hard week → null', () => {
    // heat-control and legumes both list tempering; its prereq heat-control is held; parippu teaches it and is ✅.
    // stir-fry (needs grains) and emulsion (needs knife) miss a prereq; quick-sauce has no dish.
    expect(weeklySlot(input())).toEqual({ kind: 'new', technique: 'tempering', from: 'heat-control', recipe: PARIPPU, status: 'ok' });
    // Legumes alone at Tried: tempering's prereq heat-control is missing, so nothing.
    expect(weeklySlot(input({ toolkit: tk({ legumes: ['tried'] }) }))).toBeNull();
    // A Seen heat-control is enough as a prereq; Seen legumes lists nothing (only Tried or Yours suggest).
    expect(weeklySlot(input({ toolkit: tk({ legumes: ['tried'], 'heat-control': ['seen'] }) }))).toMatchObject({ technique: 'tempering', from: 'legumes' });
    expect(weeklySlot(input({ toolkit: tk({ legumes: ['seen'], 'heat-control': ['seen'] }) }))).toBeNull();
    expect(weeklySlot(input({ week: { hard: true, slot: 'unanswered' } }))).toBeNull();
  });

  it('never suggests a technique the player already has, and only from a dish the player is taught', () => {
    expect(weeklySlot(input({ toolkit: tk({ legumes: ['tried'], 'heat-control': ['tried'], tempering: ['seen'] }) }))).toBeNull();
    expect(weeklySlot(input({ taught: new Set([ONIGIRI, FRIJOLES]) }))).toBeNull();
  });

  it('weeklySlot never offers a ❓ or ⛔ dish: a player whose rules block the only tempering dish gets null', () => {
    expect(weeklySlot(input({ rules: [avoid('category', 'allium')] }))).toBeNull();
    expect(weeklySlot(input({ rules: [avoid('ingredient', 'coconut')] }))).toBeNull();
    // ❓: the only tempering dish holds a line the engine can't resolve.
    const unknown: ParsedRecipe = { ...recipes.get(PARIPPU)!, ingredients: [...recipes.get(PARIPPU)!.ingredients, { name: 'jasmine-ish paste', displayName: null, quantity: null, unit: null, note: null }] };
    expect(weeklySlot(input({ recipes: withRecipe(PARIPPU, unknown) }))).toBeNull();
    // Shop-bought pappadam is label-dependent, so under any rule at all the shipped parippu is ❓ and never offered.
    expect(weeklySlot(input({ rules: [avoid('ingredient', 'ghee')] }))).toBeNull();
    // Without it, a labelled swap is offered as 'swap' (ghee → neutral oil).
    const p = recipes.get(PARIPPU)!;
    const noPappadam: ParsedRecipe = { ...p, ingredients: p.ingredients.filter((i) => i.name !== 'pappadam') };
    expect(weeklySlot(input({ recipes: withRecipe(PARIPPU, noPappadam), rules: [avoid('ingredient', 'ghee')] }))).toEqual({
      kind: 'new',
      technique: 'tempering',
      from: 'heat-control',
      recipe: PARIPPU,
      status: 'swap',
    });
  });

  it('checks the dish on the plan week start: a rule starting that day blocks it, one ending before does not', () => {
    expect(weeklySlot(input({ rules: [avoid('category', 'allium', { start: WEEK })] }))).toBeNull();
    expect(weeklySlot(input({ rules: [avoid('category', 'allium', { start: '2026-10-01', end: '2026-11-01' })] }))).toMatchObject({ technique: 'tempering' });
  });

  it('I1: a dish is offered only if it passes on every day of the plan week (the reviewer\'s mid-week allium repro)', () => {
    // Week starts Mon 2026-11-09; on Wed 2026-11-11 an allium allergy rule starts.
    const midWeek = avoid('category', 'allium', { start: '2026-11-11' });
    expect(weeklySlot(input({ today: '2026-11-11', rules: [midWeek] }))).toBeNull();
    // Also when it starts on the week's last day, and when today is still the week start.
    expect(weeklySlot(input({ rules: [avoid('category', 'allium', { start: '2026-11-15' })] }))).toBeNull();
    // A rule that ends before the week, or starts the day after it ends, does not block it.
    expect(weeklySlot(input({ rules: [avoid('category', 'allium', { start: '2026-11-16' })] }))).toMatchObject({ technique: 'tempering', status: 'ok' });
    // A swap on any day makes the offer a swap.
    const p = recipes.get(PARIPPU)!;
    const noPappadam: ParsedRecipe = { ...p, ingredients: p.ingredients.filter((i) => i.name !== 'pappadam') };
    expect(weeklySlot(input({ recipes: withRecipe(PARIPPU, noPappadam), rules: [avoid('ingredient', 'ghee', { start: '2026-11-13' })] }))).toMatchObject({ technique: 'tempering', status: 'swap' });
  });

  it('never offers a sacred dish', () => {
    const p = recipes.get(PARIPPU)!;
    expect(weeklySlot(input({ recipes: withRecipe(PARIPPU, { ...p, meta: { ...p.meta, sacred: true } }) }))).toBeNull();
  });

  it('prefers a dish already planned this week over technique order', () => {
    // A second dish teaching quick-sauce (sorted before tempering) is first, until parippu is in the plan.
    const p = recipes.get(PARIPPU)!;
    const sauce: ParsedRecipe = { ...p, meta: { ...p.meta, skills: ['quick-sauce'] } };
    const rs = withRecipe('test/sauce', sauce);
    const taught = new Set(rs.keys());
    expect(weeklySlot(input({ recipes: rs, taught }))).toEqual({ kind: 'new', technique: 'quick-sauce', from: 'heat-control', recipe: 'test/sauce', status: 'ok' });
    expect(weeklySlot(input({ recipes: rs, taught, planned: [ONIGIRI, PARIPPU] }))).toEqual({ kind: 'new', technique: 'tempering', from: 'heat-control', recipe: PARIPPU, status: 'ok' });
  });

  it('weeklySlot falls back to the oldest Rusty refresher only when no new offer exists; declined this week → null', () => {
    // Everything adjacent is held or blocked by prereqs; legumes is the oldest Rusty one.
    const rusty = tk({
      legumes: ['tried', '2025-03-01'],
      'heat-control': ['yours', '2025-05-01'],
      tempering: ['tried', '2025-04-01'],
      patience: ['seen', '2024-01-01'], // Seen has nothing to fade
      'quick-sauce': ['seen'],
    });
    expect(weeklySlot(input({ toolkit: rusty }))).toEqual({ kind: 'refresh', technique: 'legumes', recipe: PARIPPU, status: 'ok' });
    // A planned dish is preferred for the refresher too (frijoles sorts after parippu otherwise).
    expect(weeklySlot(input({ toolkit: rusty, planned: [FRIJOLES] }))).toEqual({ kind: 'refresh', technique: 'legumes', recipe: FRIJOLES, status: 'ok' });
    // The oldest Rusty technique whose every dish is blocked is skipped for the next one.
    // Under these rules parippu and frijoles are ⛔ and onigiri ❓ (label-dependent lines); a plain heat-control dish is ✅.
    const p = recipes.get(PARIPPU)!;
    const plain: ParsedRecipe = { ...p, meta: { ...p.meta, skills: ['heat-control'] }, ingredients: [{ name: 'water', displayName: null, quantity: 1, unit: 'l', note: null }] };
    const rs = withRecipe('test/plain', plain);
    expect(weeklySlot(input({ toolkit: rusty, recipes: rs, taught: new Set(rs.keys()), rules: [avoid('ingredient', 'black_bean'), avoid('ingredient', 'coconut')] }))).toEqual({
      kind: 'refresh',
      technique: 'heat-control',
      recipe: 'test/plain',
      status: 'ok',
    });
    // A new offer always wins over a refresher.
    const noTempering: ToolkitState = { techniques: Object.fromEntries(Object.entries(rusty.techniques).filter(([id]) => id !== 'tempering')) };
    expect(weeklySlot(input({ toolkit: noTempering }))).toEqual({ kind: 'new', technique: 'tempering', from: 'heat-control', recipe: PARIPPU, status: 'ok' });
    for (const slot of ['declined', 'accepted', 'offered'] as const) {
      expect(weeklySlot(input({ toolkit: rusty, week: { hard: false, slot } }))).toBeNull();
      expect(weeklySlot(input({ week: { hard: false, slot } }))).toBeNull();
    }
    expect(weeklySlot(input({ toolkit: rusty, week: { hard: true, slot: 'unanswered' } }))).toBeNull();
  });

  it('weeklySlot is deterministic: same input → same offer', () => {
    const shuffled = input({ techniques: [...techniqueNodes].reverse(), recipes: new Map([...recipes].reverse()) });
    const first = weeklySlot(input());
    for (let i = 0; i < 5; i++) expect(weeklySlot(input())).toEqual(first);
    expect(weeklySlot(shuffled)).toEqual(first);
  });
});
