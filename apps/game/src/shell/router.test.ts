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
    expect(parseRoute('#/plan')).toEqual({ name: 'plan' });
    expect(parseRoute('#/market')).toEqual({ name: 'market' });
    expect(parseRoute('#/frame/green-sauce')).toEqual({ name: 'frame', id: 'green-sauce' });
    expect(parseRoute('#/book')).toEqual({ name: 'book', slug: null });
    expect(parseRoute('#/book/india/kerala/parippu')).toEqual({ name: 'book', slug: 'india/kerala/parippu' });
    expect(parseRoute('#/plan/x')).toEqual({ name: 'notFound', hash: '#/plan/x' });
    expect(parseRoute('#/market/x')).toEqual({ name: 'notFound', hash: '#/market/x' });
  });
  it('the market hub and its four stalls (M6 Step 9): #/stalls and #/stall/<id> parse; an unknown stall is notFound', () => {
    expect(parseRoute('#/stalls')).toEqual({ name: 'stalls' });
    for (const id of ['wen', 'bram', 'okafor-sato', 'spice'] as const) expect(parseRoute(`#/stall/${id}`)).toEqual({ name: 'stall', id });
    for (const h of ['#/stall/fishmonger', '#/stall/general', '#/stall/', '#/stall', '#/stall/Wen', '#/stall/wen/x', '#/stalls/wen', '#/stall/__proto__', '#/stall/constructor']) {
      expect(parseRoute(h), h).toEqual({ name: 'notFound', hash: h });
    }
  });
  it('ignores query strings', () => {
    expect(parseRoute('#/map?x=1')).toEqual({ name: 'map' });
  });
  it.each(['#/visit/../x', '#/recipe/India/x', '#/cook/', '#/nowhere', '#/recipe/', '#/map/x', '#/visit/a/b', '#/frame/', '#/frame/a/b', '#/frame/Green', '#/recipe/a//b', '#/book/', '#/book/India', 'map'])(
    '%j is notFound', (h) => {
      expect(parseRoute(h)).toEqual({ name: 'notFound', hash: h });
    });
});

describe('routeHref', () => {
  const routes: Exclude<Route, { name: 'notFound' }>[] = [
    { name: 'kitchen' }, { name: 'map' }, { name: 'visit', cookId: 'leela' }, { name: 'recipes' },
    { name: 'recipe', slug: 'india/kerala/parippu' }, { name: 'cook', slug: 'india/kerala/parippu' }, { name: 'settings' }, { name: 'rules' },
    { name: 'plan' }, { name: 'market' }, { name: 'frame', id: 'green-sauce' },
    { name: 'book', slug: null }, { name: 'book', slug: 'india/kerala/parippu' },
    { name: 'stalls' }, { name: 'stall', id: 'wen' }, { name: 'stall', id: 'okafor-sato' },
  ];
  it.each(routes)('round-trips %j', (r) => {
    expect(parseRoute(routeHref(r))).toEqual(r);
  });
  it('builds the documented href', () => {
    expect(routeHref({ name: 'recipe', slug: 'india/kerala/parippu' })).toBe('#/recipe/india/kerala/parippu');
    expect(routeHref({ name: 'rules' })).toBe('#/rules');
  });
});
