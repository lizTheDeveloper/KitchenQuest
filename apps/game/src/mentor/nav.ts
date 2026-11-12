import type { NavTarget } from '@kitchenquest/core/engine';
import { content } from '../content';
import { parseRoute, type Route } from '../shell/router';

/**
 * Where a navigation chip goes (Ruling 15): the closed set of targets, checked again here against the content, so
 * a chip from the server can only ever open a real screen. Null for anything else (the chip is dropped). `book` is
 * the Recipe Book (Step 11).
 */
export function navRoute(t: unknown): Exclude<Route, { name: 'notFound' }> | null {
  if (typeof t !== 'object' || t === null) return null;
  const target = t as Partial<NavTarget> & { cook?: unknown; slug?: unknown };
  switch (target.to) {
    case 'kitchen': return { name: 'kitchen' };
    case 'map': return { name: 'map' };
    case 'plan': return { name: 'plan' };
    case 'market': return { name: 'market' };
    case 'book': return { name: 'book', slug: null };
    case 'visit': return typeof target.cook === 'string' && Object.hasOwn(content.cooks, target.cook) ? { name: 'visit', cookId: target.cook } : null;
    case 'recipe': return typeof target.slug === 'string' && Object.hasOwn(content.recipes, target.slug) ? { name: 'recipe', slug: target.slug } : null;
    // M6 Step 9: the market hub and one keeper's stall (the id checked against the closed set again, as the router does).
    case 'stalls': return { name: 'stalls' };
    case 'stall': {
      const stall = (target as { stall?: unknown }).stall;
      if (typeof stall !== 'string') return null;
      const r = parseRoute(`#/stall/${stall}`);
      return r.name === 'stall' ? r : null;
    }
    case undefined:
    default: return null;
  }
}
