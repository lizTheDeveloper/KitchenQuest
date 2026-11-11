import { describe, expect, test } from 'vitest';
import { deriveProgress, standInCooks, type Rule } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { catalogueOf, rulesContextOf } from '../progress/catalogue';
import { cookedEvent } from './finish';
import { standInFixture } from '../progress/stand-in.fixture';

const slug = 'india/kerala/parippu';
const cat = catalogueOf();

describe('cookedEvent', () => {
  test('a cooked event for this recipe and day, planned as given, with no claim when no cook is blocked', () => {
    const ctx = rulesContextOf([], [], '2026-11-09');
    expect(cookedEvent(slug, '2026-11-09', false, 'e1', cat, ctx)).toEqual({ id: 'e1', kind: 'cooked', at: '2026-11-09', recipe: slug, planned: false });
  });
  test('folding it marks every technique the recipe teaches tried', () => {
    const e = cookedEvent(slug, '2026-11-09', true, 'e1', cat, undefined);
    const v = deriveProgress({ events: [e], grants: [], base: null }, cat);
    for (const t of content.recipes[slug].meta.skills) expect(v.toolkit.techniques[t].tier).toBe('tried');
  });
  test('standsInFor is exactly core standInCooks for the player\'s rules (here none: with a rule the other dishes are ❓)', () => {
    const rules: Rule[] = [{ id: 'r', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' }];
    const ctx = rulesContextOf(rules, [], '2026-11-09', graph);
    const frijoles = 'mexico/oaxaca/frijoles-de-olla';
    expect(cookedEvent(frijoles, '2026-11-09', false, 'e2', cat, ctx).standsInFor ?? []).toEqual(standInCooks({ kind: 'recipe', slug: frijoles }, '2026-11-09', cat, ctx));
    expect(cookedEvent(frijoles, '2026-11-09', false, 'e2', cat, undefined)).not.toHaveProperty('standsInFor');
  });
  test('standsInFor is filled when a stand-in exists: the shallot dal stands in for Leela when coconut blocks parippu', () => {
    const fx = standInFixture();
    expect(cookedEvent(fx.standIn, fx.today, false, 'e3', fx.cat, fx.ctx).standsInFor).toEqual(['leela']);
  });
});
