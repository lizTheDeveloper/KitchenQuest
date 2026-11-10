/**
 * How the service worker treats each request. Pure, so it is tested in Node; `sw.ts` imports only this.
 * `/api/*` and `/auth/*` are network-only: the worker never caches player data or sign-in tokens.
 */
export type SwRoute = 'precache' | 'shell' | 'network-only' | 'passthrough';

const NEVER_CACHED = ['/api', '/auth'];

export function routeFor(req: { url: string; method: string; mode: string }, origin: string): SwRoute {
  if (req.method !== 'GET') return 'passthrough';
  const url = new URL(req.url);
  if (url.origin !== origin) return 'passthrough';
  if (NEVER_CACHED.some((p) => url.pathname === p || url.pathname.startsWith(`${p}/`))) return 'network-only';
  if (req.mode === 'navigate') return 'shell';
  return 'precache';
}

const PREFIX = 'kq-shell-';

export function cacheName(version: string): string {
  return `${PREFIX}${version}`;
}

/** Every Kitchen Quest cache except the current one. Other caches are not ours to delete. */
export function staleCaches(keys: string[], current: string): string[] {
  return keys.filter((k) => k.startsWith(PREFIX) && k !== current);
}
