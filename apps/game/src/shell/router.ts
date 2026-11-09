export type Route =
  | { name: 'kitchen' } | { name: 'map' } | { name: 'visit'; cookId: string }
  | { name: 'recipes' } | { name: 'recipe'; slug: string } | { name: 'cook'; slug: string }
  | { name: 'settings' } | { name: 'notFound'; hash: string };

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
    case 'kitchen':
    case 'map':
    case 'recipes':
    case 'settings':
      return `#/${route.name}`;
  }
}
