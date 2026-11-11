import type { Catalogue, ParsedRecipe, Rule, RulesContext } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { catalogueOf } from './catalogue';

/**
 * A synthetic catalogue where a stand-in really exists (I3), for tests only: Leela's one dish (parippu) is ⛔ under a
 * severe coconut rule, and a plain shallot dal filed under Marisol practises the same technique (legumes) and passes.
 * The launch canon has no such pair yet (with any rule, the other dishes are ❓).
 */
export function standInFixture(): { cat: Catalogue; ctx: RulesContext; today: string; standIn: string } {
  const parippu = 'india/kerala/parippu';
  const standIn = 'test/shallot-dal';
  const base = content.recipes[parippu];
  const dal: ParsedRecipe = {
    ...base,
    meta: { ...base.meta, title: 'Shallot dal (test)', cook: 'marisol', skills: ['legumes'], sacred: false },
    ingredients: [{ name: 'shallot', displayName: null, quantity: 2, unit: null, note: null }],
    timers: [],
    steps: [],
  };
  const recipes = new Map<string, ParsedRecipe>([[parippu, base], [standIn, dal]]);
  const rules: Rule[] = [{ id: 'r-coconut', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }];
  const real = catalogueOf();
  const cat: Catalogue = {
    ...real,
    recipes: new Map([...recipes].map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
  };
  return { cat, ctx: { rules, graph, subs: [...content.substitutions], recipes, frames: [] }, today: '2026-11-09', standIn };
}
