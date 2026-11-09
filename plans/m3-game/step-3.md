# Step 3 — App shell: router, design system, player store, Bureau form, e2e harness

The HTML shell every later task mounts into. It also sets up the Playwright harness every later task's e2e test uses. Screens here are placeholders (an `<h1>` only) until their own task replaces them.

**Files:**
- Modify: `apps/game/package.json`, `apps/game/index.html`, `apps/game/vite.config.ts`, `apps/game/tsconfig.json`, `apps/game/src/main.ts`, root `package.json` (script `"test:e2e": "npm run test:e2e -w @kitchenquest/game"`)
- Create: `apps/game/tsconfig.node.json` (covers `build/`, `e2e/` and the configs, with node types), `apps/game/vitest.config.ts` (includes `src/**/*.test.ts` and `build/**/*.test.ts`), `apps/game/vitest.e2e.config.ts`
- Create: `apps/game/src/shell/router.ts` (+ `router.test.ts`), `apps/game/src/shell/app.ts`, `apps/game/src/shell/motion.ts` (+ `motion.test.ts`), `apps/game/src/shell/screens.ts` (placeholder screens), `apps/game/src/settings/settings-screen.ts`
- Create: `apps/game/src/state/store.ts` (+ `store.test.ts`)
- Create: `apps/game/src/styles/tokens.css`, `apps/game/src/styles/components.css`, `apps/game/src/ui/bureau-form.ts`, `apps/game/src/ui/chips.ts`, `apps/game/src/ui/dom.ts` (`h(tag, attrs, ...children)` with text-only children, so no `innerHTML` with content; `contentText(tag, text)` builds an element carrying `data-content`. Every element whose text comes from compiled content (dialogue, cook lines, footnotes, form copy) uses it, and Step 12's scan relies on that)
- Create: `apps/game/e2e/setup.ts`, `apps/game/e2e/helpers.ts`, `apps/game/e2e/shell.e2e.test.ts`

**Dependencies:**
- Add `@kitchenquest/core: "*"`, `@fontsource/atkinson-hyperlegible`, `@fontsource/pixelify-sans`, `@fontsource/vt323`.
- Add dev dependencies `yaml`, `zod@^4`, `playwright@1.63.0` (exact: it must match the pre-installed browsers), `@axe-core/playwright`, `@types/node@^22`.
- Scripts: `"test:e2e": "vitest run -c vitest.e2e.config.ts"`, `"typecheck": "tsc --noEmit && tsc --noEmit -p tsconfig.node.json"`.
- Vite: `base: '/'` (was `'./'`, because nested pages and the service worker need root-relative URLs). Keep the `phaser` manual chunk.

**Interfaces:**
- Produces:
```ts
// shell/router.ts
export type Route =
  | { name: 'kitchen' } | { name: 'map' } | { name: 'visit'; cookId: string }
  | { name: 'recipes' } | { name: 'recipe'; slug: string } | { name: 'cook'; slug: string }
  | { name: 'settings' } | { name: 'notFound'; hash: string };
export function parseRoute(hash: string): Route;
export function routeHref(route: Exclude<Route, { name: 'notFound' }>): string;   // '#/recipe/india/kerala/parippu'
// shell/app.ts
export interface AppContext { store: PlayerStore; navigate(route: Route): void; now: () => Date }
export interface Screen { title: string; mount(el: HTMLElement, route: Route, ctx: AppContext): void | Promise<void>; unmount?(): void }
export function registerScreen(name: Route['name'], make: () => Screen): void;   // later tasks replace placeholders
export function mountApp(doc: Document, ctx: Omit<AppContext, 'navigate'>): void;
// shell/motion.ts
export function reducedMotion(setting: 'system' | 'on' | 'off', mql: { matches: boolean }): boolean;
// state/store.ts
export interface PlayerSettings { showCalories: boolean; reducedMotion: 'system' | 'on' | 'off'; familyTable: boolean; iosNoteDismissed: boolean }
export interface PlayerState {
  v: 1; firstOpenedAt: string | null; lastOpenedAt: string | null;      // ISO datetimes
  localRules: Rule[]; accountRules: Rule[] | null; account: { email: string } | null;
  toolkit: ToolkitState; cookProgress: { slug: string; step: number } | null;
  dialogueHistory: Record<string, number[]>; settings: PlayerSettings;
}
export const STORE_KEY = 'kq.player.v1';
export interface PlayerStore { get(): PlayerState; update(fn: (s: PlayerState) => PlayerState): PlayerState; subscribe(fn: (s: PlayerState) => void): () => void; readonly notice: 'corrupt' | null }
export function createStore(storage: Storage | null): PlayerStore;
// ui/bureau-form.ts
export function showBureauForm(root: HTMLElement, opts: { form: BureauForm; values: Record<string, string>; footnote?: string; reducedMotion: boolean }): Promise<'confirm' | 'decline'>;
// ui/chips.ts
export function statusChip(status: CheckStatus): HTMLElement;   // text label + emoji, never colour alone
```
(`BureauForm` is defined in Step 4's `src/content/types.ts`. Define that interface here first and Step 4 adds the rest of the file.)
- Route rules: `''`, `'#'`, `'#/'` and `'#/kitchen'` → kitchen. A slug must match `^[a-z0-9-]+(/[a-z0-9-]+)*$` and a cookId must match `^[a-z0-9-]+$`. Anything else → `notFound`. Query strings are ignored.
- On every route change: unmount the old screen, mount the new one, set `document.title` to `"<title> · Kitchen Quest"`, and move focus to the screen's `<h1>` (`tabindex="-1"`).
- Layout in `index.html`: `<html lang="en">`; a skip link; `<header id="hud">` (title, `#pan-button` placeholder, settings link); `<main id="screen">` holding `<div id="stage" aria-hidden="true">` (the canvas host) and `<div id="view">` (the HTML screen); `<div id="overlay-root">`; `<div id="announcer" aria-live="assertive" class="visually-hidden">`.
- Styles: copy the `:root` tokens from `prototype/BRIEF.md` verbatim into `tokens.css`. Import the three `@fontsource` CSS files. Add pixel border, buttons (ember primary, iron secondary, 2px press), status chips, parchment dialogue box and Bureau form slip as in BRIEF "Components". Use rem-based sizes. `@media (prefers-reduced-motion: reduce)` and `[data-motion="reduced"]` on `<html>` both disable transitions and animations.
- Bureau form: a modal `role="dialog"` with `aria-labelledby`, showing "PANTRY BUREAU · FORM {number}", the title and a `<dl>` of field label → value with hints. Buttons use the form's own `buttons.confirm` / `buttons.decline` labels; when `decline` is absent, show only confirm. Confirm plays the stamp animation (the red rotated `stamps[form.stamp]` text in `--mono`), which is skipped when motion is reduced. Escape → `'decline'`. Focus is trapped while open and returned to the opener on close.
- Store: a fresh state uses empty rules, `EMPTY_TOOLKIT` and `settings { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false }`. Every storage access sits in try/catch. A null or throwing storage → in-memory only. Unparsable JSON or an unknown `v` → copy the raw string to `kq.player.v1.corrupt`, start fresh, and set `notice = 'corrupt'` (the shell shows a plain banner). Never silently discard earned toolkit data. A partial object is merged over defaults key by key. The store has no `reset`.
- Settings screen (`#/settings`): an h1 "Settings", a "Show calories" checkbox, and a "Reduce motion" select (System / On / Off), saved to the store. Later tasks add Install (Step 10) and Account (Step 11) sections.

**E2E harness:**
- `e2e/setup.ts` (Vitest `globalSetup`): runs `vite build` once through the programmatic `build()`, then `preview({ preview: { port: 4173, strictPort: true } })`. It calls `provide('baseUrl', 'http://localhost:4173')` and closes the server on teardown.
- `e2e/helpers.ts`:
```ts
export async function openApp(path: string, opts?: { seed?: Partial<PlayerState>; reducedMotion?: boolean; width?: number; serviceWorkers?: 'allow' | 'block' }):
  Promise<{ page: Page; context: BrowserContext; consoleErrors: string[]; requests: string[]; close(): Promise<void> }>;
// chromium.launch(); viewport width default 1280 (height 800); serviceWorkers default 'block';
// seed is written to localStorage[STORE_KEY] via addInitScript before any page script runs.
export async function expectNoA11yViolations(page: Page, label: string): Promise<void>;   // AxeBuilder, fail on impact serious|critical, message lists rule ids
export async function expectNoHorizontalScroll(page: Page): Promise<void>;               // scrollWidth <= clientWidth
export function offOrigin(requests: string[], base: string): string[];                    // requests not starting with base
```

- [ ] **3.1 Tests:**
  - `router.test.ts`: the table in "Route rules" (`'#/visit/../x'`, `'#/recipe/India/x'` and `'#/cook/'` → notFound); `parseRoute(routeHref(r))` deep-equals `r` for one route of every kind; `'#/map?x=1'` → map.
  - `motion.test.ts`: `'on'` → true and `'off'` → false whatever the media query says; `'system'` follows `mql.matches`.
  - `store.test.ts`: `createStore(null)` works in memory; a storage whose `getItem` throws → defaults, no throw; corrupt JSON → defaults, raw copied to `kq.player.v1.corrupt`, `notice === 'corrupt'`; `{ v: 2 }` handled like corrupt; a partial `{ settings: { showCalories: true } }` merges to full defaults with `showCalories: true`; `update` persists and notifies subscribers; unsubscribe stops notifications.
  - `shell.e2e.test.ts`: `/` shows the h1 "Kitchen" and `document.title` is `"Kitchen · Kitchen Quest"`; no console errors; `#/nowhere` shows a not-found h1 with a link home; following the link focuses the kitchen h1; at width 400, `expectNoHorizontalScroll` passes on `/`, `#/settings` and `#/nowhere`; `offOrigin(requests)` is empty (fonts are self-hosted); `document.fonts.check('16px "Atkinson Hyperlegible"')` is true after load; the settings toggle persists across reload; `expectNoA11yViolations` passes on `/` and `#/settings`.
- [ ] **3.2 Run** `npm test -w @kitchenquest/game` → FAIL; `npm run test:e2e -w @kitchenquest/game` → FAIL.
- [ ] **3.3 Implement** everything above. Replace `main.ts` with `mountApp(document, { store: createStore(safeLocalStorage()), now: () => new Date() })`. Delete `KitchenScene` and `BootScene` usage from `main.ts` for now (Step 8 brings the canvas back). Keep `util/movement.ts`.
- [ ] **3.4 Run** both commands and `npm run typecheck -w @kitchenquest/game` → PASS.
- [ ] **3.5 Commit** `feat(game): HTML app shell, router, player store, design tokens, e2e harness`
