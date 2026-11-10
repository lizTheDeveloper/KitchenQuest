/**
 * Kitchen Quest's service worker, hand-written. The build (build/sw-plugin.ts) replaces
 * `self.__KQ_PRECACHE__` with the precache list and `__KQ_VERSION__` with its version.
 *
 * - install: precache the app shell, compiled content and art. No skipWaiting, so an open cook session keeps
 *   its worker until every tab closes.
 * - activate: delete older Kitchen Quest caches, then take control.
 * - fetch: only ever reads the precache; it never writes a response it fetched at runtime, and never touches
 *   /api/* or /auth/*.
 */
import { cacheName, routeFor, staleCaches } from './sw-routes';

declare const self: ServiceWorkerGlobalScope & { __KQ_PRECACHE__: string[] };
declare const __KQ_VERSION__: string;

const PRECACHE: string[] = self.__KQ_PRECACHE__;
const CACHE = cacheName(__KQ_VERSION__);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const stale = staleCaches(await caches.keys(), CACHE);
    await Promise.all(stale.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function fromCache(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  // Precached files are static, so a server's `Vary: Origin` (module scripts send Origin; addAll did not)
  // must not turn a cached file into a miss.
  return (await cache.match(req, { ignoreVary: true })) ?? fetch(req);
}

async function shell(req: Request): Promise<Response> {
  try {
    return await fetch(req);
  } catch (err) {
    const cached = await (await caches.open(CACHE)).match('/index.html', { ignoreVary: true });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  switch (routeFor(req, self.location.origin)) {
    case 'precache': event.respondWith(fromCache(req)); return;
    case 'shell': event.respondWith(shell(req)); return;
    case 'network-only': // the browser fetches it; nothing here sees or stores the response
    case 'passthrough': return;
  }
});
