import type { KeeperStallId } from '@kitchenquest/core/engine';

/** A market stall with a keeper (M6 Step 9): every stall but the General Counter, which has no file and no screen. */
export type KeeperStall = KeeperStallId;
/** The closed set, written here so the router (first paint) imports no code; a test pins it to core's STALL_IDS. */
export const KEEPER_STALLS: readonly KeeperStall[] = ['wen', 'bram', 'okafor-sato', 'spice'];
const isKeeperStall = (id: string): id is KeeperStall => (KEEPER_STALLS as readonly string[]).includes(id);

export type Route =
  | { name: 'kitchen' } | { name: 'map' } | { name: 'visit'; cookId: string }
  | { name: 'recipes' } | { name: 'recipe'; slug: string } | { name: 'cook'; slug: string }
  | { name: 'settings' } | { name: 'rules' } | { name: 'plan' } | { name: 'market' } | { name: 'frame'; id: string }
  /** The Recipe Book (M5 Step 11): the book (`slug: null`) or one dish's page. */
  | { name: 'book'; slug: string | null }
  /** The market hub (M6 Step 9, Ruling 15) and one stall, its id checked against the closed stall set. */
  | { name: 'stalls' } | { name: 'stall'; id: KeeperStall }
  | { name: 'notFound'; hash: string };

const SLUG = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;
const ID = /^[a-z0-9-]+$/;

export function parseRoute(hash: string): Route {
  const notFound: Route = { name: 'notFound', hash };
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  const q = path.indexOf('?');
  if (q >= 0) path = path.slice(0, q);
  if (path === '' || path === '/') return { name: 'kitchen' };
  if (!path.startsWith('/')) return notFound;
  const rest = path.slice(1);
  const slash = rest.indexOf('/');
  const head = slash < 0 ? rest : rest.slice(0, slash);
  const arg = slash < 0 ? null : rest.slice(slash + 1);
  switch (head) {
    case 'kitchen': return arg === null ? { name: 'kitchen' } : notFound;
    case 'map': return arg === null ? { name: 'map' } : notFound;
    case 'recipes': return arg === null ? { name: 'recipes' } : notFound;
    case 'settings': return arg === null ? { name: 'settings' } : notFound;
    case 'rules': return arg === null ? { name: 'rules' } : notFound;
    case 'plan': return arg === null ? { name: 'plan' } : notFound;
    case 'market': return arg === null ? { name: 'market' } : notFound;
    case 'stalls': return arg === null ? { name: 'stalls' } : notFound;
    case 'stall': return arg !== null && isKeeperStall(arg) ? { name: 'stall', id: arg } : notFound;
    case 'frame': return arg !== null && ID.test(arg) ? { name: 'frame', id: arg } : notFound;
    case 'book': return arg === null ? { name: 'book', slug: null } : SLUG.test(arg) ? { name: 'book', slug: arg } : notFound;
    case 'visit': return arg !== null && ID.test(arg) ? { name: 'visit', cookId: arg } : notFound;
    case 'recipe': return arg !== null && SLUG.test(arg) ? { name: 'recipe', slug: arg } : notFound;
    case 'cook': return arg !== null && SLUG.test(arg) ? { name: 'cook', slug: arg } : notFound;
    default: return notFound;
  }
}

export function routeHref(route: Exclude<Route, { name: 'notFound' }>): string {
  switch (route.name) {
    case 'visit': return `#/visit/${route.cookId}`;
    case 'recipe': return `#/recipe/${route.slug}`;
    case 'cook': return `#/cook/${route.slug}`;
    case 'frame': return `#/frame/${route.id}`;
    case 'stall': return `#/stall/${route.id}`;
    case 'book': return route.slug === null ? '#/book' : `#/book/${route.slug}`;
    case 'kitchen':
    case 'map':
    case 'recipes':
    case 'settings':
    case 'rules':
    case 'plan':
    case 'market':
    case 'stalls':
      return `#/${route.name}`;
  }
}
