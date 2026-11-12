// @vitest-environment happy-dom
// M6 Ruling 16 (founder default: advisory): the drill-first hint. Shown when a prereq is below Seen and a cook's drill
// teaches it; Cook stays enabled; never in Family Table, on a sacred dish, or while the toolkit is unknown.
import { describe, expect, test } from 'vitest';
import type { ParsedRecipe, ToolkitState } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { buildRecipeCard } from './card-model';
import { renderRecipeCard } from './card-view';
import { drillFirstFor } from './drill-first';
import { drillFirstHint } from './recipe-screen';
import { writtenLine } from '../week/plan-view';

const PARIPPU = 'india/kerala/parippu';
const ONIGIRI = 'japan/osaka/onigiri';
const quests = Object.values(content.cooks).map((c) => c.quest);
const techniques = content.techniques.techniques;
const seen = (...ids: string[]): ToolkitState => ({ techniques: Object.fromEntries(ids.map((id) => [id, { tier: 'seen' as const, firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] }])) });

describe('drill-first (Ruling 16)', () => {
  test('shown when a prereq is below Seen: parippu (tempering after heat control) → Marisol\'s heat-control drill', () => {
    const hint = drillFirstFor(content.recipes[PARIPPU], seen(), techniques, quests);
    expect(hint).toEqual({ technique: 'heat-control', cook: 'marisol', questId: content.cooks.marisol.quest.id });
    // At Seen: nothing to suggest. A prereq no drill teaches (onigiri's shaping after grains): nothing either.
    expect(drillFirstFor(content.recipes[PARIPPU], seen('heat-control'), techniques, quests)).toBeNull();
    expect(drillFirstFor(content.recipes[ONIGIRI], seen(), techniques, quests)).toBeNull();
  });

  test('Cook stays enabled beside it; absent in Family Table, while the toolkit is unknown, and on sacred dishes', () => {
    const el = drillFirstHint(PARIPPU, seen(), false)!;
    expect(el.textContent).toContain(writtenLine('cook.drill_first', { technique: 'Heat control', cook: content.cooks.marisol.name }));
    expect(el.querySelector('a')!.getAttribute('href')).toBe('#/visit/marisol');
    expect(el.textContent).not.toMatch(/❗|should/);
    const card = buildRecipeCard({ slug: PARIPPU, content, graph, rules: { status: 'ready', rules: [], source: 'device' }, today: '2026-11-11', showCalories: false });
    const view = renderRecipeCard(card, { headingLevel: 1, onCook: () => undefined, drillFirst: el });
    expect(view.querySelector<HTMLButtonElement>('.cook-button')!.disabled).toBe(false);
    expect(view.querySelector('.drill-first')).not.toBeNull();
    expect(drillFirstHint(PARIPPU, seen(), true)).toBeNull();
    expect(drillFirstHint(PARIPPU, null, false)).toBeNull();
    const sacred: ParsedRecipe = { ...content.recipes[PARIPPU], meta: { ...content.recipes[PARIPPU].meta, sacred: true } };
    expect(drillFirstFor(sacred, seen(), techniques, quests)).toBeNull();
  });
});
