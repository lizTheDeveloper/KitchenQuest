# Step 10 — PWA: manifest, service worker, offline, install notes

The game installs and runs offline: the app shell, all compiled content (recipes, dialogue, data) and all art are precached (§9). The service worker is hand-written, with a precache list injected at build time. It never caches `/api/*` or `/auth/*`.

**Files:**
- Create: `apps/game/public/manifest.webmanifest`, `apps/game/public/icons/icon-192.png`, `icon-512.png`, `maskable-512.png`, `apple-touch-icon.png` (180×180), `apps/game/scripts/make-icons.mjs`
- Create: `apps/game/src/pwa/sw.ts`, `apps/game/src/pwa/sw-routes.ts` (+ `sw-routes.test.ts`), `apps/game/src/pwa/register.ts`, `apps/game/src/pwa/install.ts` (+ `install.test.ts`), `apps/game/src/settings/install-section.ts`, `apps/game/build/sw-plugin.ts` (+ `sw-plugin.test.ts`)
- Modify: `apps/game/index.html` (`<link rel="manifest">`, `<meta name="theme-color" content="#1e1b1d">`, `<link rel="apple-touch-icon">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, `<meta name="mobile-web-app-capable" content="yes">`), `apps/game/vite.config.ts`, `apps/game/src/main.ts`, `apps/game/src/kitchen/kitchen-screen.ts`, `apps/game/src/settings/settings-screen.ts`
- Test: `apps/game/e2e/pwa.e2e.test.ts`

**Interfaces:**
- Produces:
```ts
// pwa/sw-routes.ts (pure; imported by sw.ts and tested in Node)
export type SwRoute = 'precache' | 'shell' | 'network-only' | 'passthrough';
export function routeFor(req: { url: string; method: string; mode: string }, origin: string): SwRoute;
export function cacheName(version: string): string;            // `kq-shell-${version}`
export function staleCaches(keys: string[], current: string): string[];   // every 'kq-shell-*' key except current
// build/sw-plugin.ts
export function precacheList(bundleFileNames: string[], publicFiles: string[]): string[];   // '/'-prefixed, sorted; excludes sw.js, *.map, dotfiles, and anything under /api or /auth (e.g. auth/verify/index.html)
export function kqServiceWorker(): Plugin;   // in generateBundle: replaces self.__KQ_PRECACHE__ and __KQ_VERSION__ in the 'sw' chunk
// pwa/register.ts
export function registerServiceWorker(nav: Navigator, prod: boolean): Promise<ServiceWorkerRegistration | null>;   // '/sw.js', scope '/'; null when !prod or unsupported
// pwa/install.ts
export function isIos(ua: string, maxTouchPoints: number): boolean;   // iPhone|iPad|iPod, or 'Macintosh' with maxTouchPoints > 1 (iPadOS)
export function isStandalone(win: { matchMedia(q: string): { matches: boolean }; navigator: { standalone?: boolean } }): boolean;
export function iosNoteVisible(settings: PlayerSettings, env: { ios: boolean; standalone: boolean }): boolean;   // ios && !standalone && !iosNoteDismissed
```
- `routeFor` rules, in order:
  1. Not GET → `passthrough`.
  2. Another origin → `passthrough` (none should exist).
  3. Path starts with `/api/` or `/auth/` → `network-only`.
  4. `mode === 'navigate'` → `shell`: network first, falling back to the cached `/index.html`.
  5. Else → `precache`: cache first, then network.
- Build: add `sw: 'src/pwa/sw.ts'` to `build.rollupOptions.input`, and set `entryFileNames: (c) => c.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'`. `sw.ts` imports only `sw-routes.ts`. The version is the first 12 hex of sha256 over the sorted precache list plus `content.version`.
- Worker lifecycle:
  - `install` → `cache.addAll(precache)`. No `skipWaiting`, so an open cook session keeps its worker until every tab closes.
  - `activate` → delete `staleCaches`, then `clients.claim()`.
  - When `registration.waiting` exists, the app shows a dismissible note: "A new edition of the Bureau's handbook is ready. It'll be used next time you open Kitchen Quest."
- Manifest: name and short_name "Kitchen Quest"; `start_url: "/#/kitchen"`; `scope: "/"`; `display: "standalone"`; `background_color` and `theme_color` `#1e1b1d`; the three icons (the maskable one has `purpose: "maskable"`).
- Icons: `make-icons.mjs` uses `playwright` (`chromium.launch()`) to draw `prototype/art/pan.png` (or `art/characters/pan.png` if present) centred on an `--iron` square, scaled by an integer factor with `imageSmoothingEnabled = false`. It writes the four PNGs. Run it once and commit the PNGs.
- Install notes:
  - iOS, when `iosNoteVisible`: a Bureau-styled note in the kitchen and in Settings → Install, with a Pan line from `intake.ios_home_screen` and a "Got it" button that sets `iosNoteDismissed`.
  - Other browsers: capture `beforeinstallprompt` (`preventDefault`). Settings → Install shows an "Install Kitchen Quest" button only when that event was captured; clicking calls `prompt()`. Never prompt automatically.
  - Already standalone: Settings shows "Installed."

- [ ] **10.1 Tests:**
```ts
// sw-routes.test.ts (origin 'https://kq.test')
test.each([
  ['POST', 'https://kq.test/api/auth/verify', 'cors', 'passthrough'],
  ['GET', 'https://fonts.example/x.css', 'no-cors', 'passthrough'],
  ['GET', 'https://kq.test/api/me', 'cors', 'network-only'],
  ['GET', 'https://kq.test/auth/verify?token=abc', 'navigate', 'network-only'],
  ['GET', 'https://kq.test/auth/verify/', 'navigate', 'network-only'],
  ['GET', 'https://kq.test/', 'navigate', 'shell'],
  ['GET', 'https://kq.test/assets/index-abc.js', 'cors', 'precache'],
])('%s %s → %s', (method, url, mode, want) => expect(routeFor({ method, url, mode }, 'https://kq.test')).toBe(want));
test('staleCaches keeps only current kq caches', () =>
  expect(staleCaches(['kq-shell-a', 'kq-shell-b', 'other'], 'kq-shell-b')).toEqual(['kq-shell-a']));
// sw-plugin.test.ts
test('precacheList', () => expect(precacheList(['sw.js', 'index.html', 'assets/a.js', 'assets/a.js.map', 'auth/verify/index.html'], ['manifest.webmanifest', 'icons/icon-192.png']))
  .toEqual(['/assets/a.js', '/icons/icon-192.png', '/index.html', '/manifest.webmanifest']));
// install.test.ts
test('isIos', ...);   // iPhone Safari UA → true; iPad desktop-mode UA 'Macintosh' + maxTouchPoints 5 → true; Mac UA + 0 → false; Android Chrome → false
test('iosNoteVisible', ...);   // all 8 combinations of ios/standalone/dismissed: only (true, false, false) → true
```
`pwa.e2e.test.ts` (`serviceWorkers: 'allow'`):
  - `GET /manifest.webmanifest` → JSON with `display: 'standalone'` and 3 icons, each icon URL responding 200 `image/png`.
  - Load `/`, wait for `navigator.serviceWorker.ready`, reload until `navigator.serviceWorker.controller` is set.
  - `context.setOffline(true)` and reload → h1 "Your kitchen". `#/recipe/india/kerala/parippu` → the card title. `#/cook/india/kerala/parippu` → "Step 1 of 7". `#/map` → 3 pins. Fonts still pass `document.fonts.check`.
  - In the page: `await caches.keys()` gives exactly one `kq-shell-*`. No cached request URL contains `/api/` or `/auth/`.
  - Offline, the app shows no uncaught console errors.
  - Update path: in the page, `caches.open('kq-shell-old')`, then unregister and re-register the worker and reload twice → `caches.keys()` no longer contains `kq-shell-old`. The unit test on `staleCaches` covers the selection logic.
  - iOS: a context with an iPhone user agent and `navigator.standalone = false` (init script) → the iOS note is visible with an `intake.ios_home_screen` line. "Got it" → gone after reload.
- [ ] **10.2 Run** `npm test -w @kitchenquest/game -- pwa build/sw` and `npm run test:e2e -w @kitchenquest/game -- e2e/pwa.e2e.test.ts` → FAIL.
- [ ] **10.3 Implement.** `main.ts` calls `registerServiceWorker(navigator, import.meta.env.PROD)`.
- [ ] **10.4 Run** both → PASS. Lighthouse is not required.
- [ ] **10.5 Commit** `feat(game): installable PWA with offline precache and install notes`
