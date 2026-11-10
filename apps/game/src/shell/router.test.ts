import { describe, expect, it } from 'vitest';
import { parseRoute, routeHref, type Route } from './router';

describe('parseRoute', () => {
  it.each(['', '#', '#/', '#/kitchen'])('%j is the kitchen', (h) => {
    expect(parseRoute(h)).toEqual({ name: 'kitchen' });
  });
  it('parses each route', () => {
    expect(parseRoute('#/map')).toEqual({ name: 'map' });
    expect(parseRoute('#/visit/leela')).toEqual({ name: 'visit', cookId: 'leela' });
    expect(parseRoute('#/recipes')).toEqual({ name: 'recipes' });
    expect(parseRoute('#/recipe/india/kerala/parippu')).toEqual({ name: 'recipe', slug: 'india/kerala/parippu' });
    expect(parseRoute('#/cook/india/kerala/parippu')).toEqual({ name: 'cook', slug: 'india/kerala/parippu' });
    expect(parseRoute('#/settings')).toEqual({ name: 'settings' });
    expect(parseRoute('#/rules')).toEqual({ name: 'rules' });
    expect(parseRoute('#/rules/x')).toEqual({ name: 'notFound', hash: '#/rules/x' });
  });
  it('ignores query strings', () => {
    expect(parseRoute('#/map?x=1')).toEqual({ name: 'map' });
  });
  it.each(['#/visit/../x', '#/recipe/India/x', '#/cook/', '#/nowhere', '#/recipe/', '#/map/x', '#/visit/a/b', '#/recipe/a//b', 'map'])(
    '%j is notFound', (h) => {
      expect(parseRoute(h)).toEqual({ name: 'notFound', hash: h });
    });
});

describe('routeHref', () => {
  const routes: Exclude<Route, { name: 'notFound' }>[] = [
    { name: 'kitchen' }, { name: 'map' }, { name: 'visit', cookId: 'leela' }, { name: 'recipes' },
    { name: 'recipe', slug: 'india/kerala/parippu' }, { name: 'cook', slug: 'india/kerala/parippu' }, { name: 'settings' }, { name: 'rules' },
  ];
  it.each(routes)('round-trips %j', (r) => {
    expect(parseRoute(routeHref(r))).toEqual(r);
  });
  it('builds the documented href', () => {
    expect(routeHref({ name: 'recipe', slug: 'india/kerala/parippu' })).toBe('#/recipe/india/kerala/parippu');
    expect(routeHref({ name: 'rules' })).toBe('#/rules');
  });
});
