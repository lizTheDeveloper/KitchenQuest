# Step 8 — Asset manifest, lazy Phaser, the player's kitchen and the Toolkit display

This step brings the canvas back as decoration behind the HTML. An asset manifest picks up sprites from the art agent's root `art/` folder and falls back to `prototype/art/`. The home kitchen (`#/kitchen`) becomes real: the Pan's greeting, the knife-roll Toolkit, and doors to the shelf and the map.

**Files:**
- Create: `apps/game/build/assets/manifest.ts` (+ `manifest.test.ts`), `apps/game/build/assets-plugin.ts`
- Create: `apps/game/src/scenes/phaser-host.ts`, `apps/game/src/scenes/bridge.ts`; rewrite `apps/game/src/scenes/BootScene.ts` and `apps/game/src/scenes/KitchenScene.ts`
- Create: `apps/game/src/kitchen/kitchen-screen.ts`, `apps/game/src/kitchen/toolkit-view.ts` (+ `toolkit-view.test.ts`), `apps/game/src/world/greeting.ts` (+ `greeting.test.ts`), `apps/game/src/ui/action-bar.ts`, `apps/game/src/scenes/no-canvas-text.test.ts`
- Modify: `apps/game/vite.config.ts` (add `kqAssets`), `apps/game/src/virtual.d.ts`
- Test: `apps/game/e2e/kitchen.e2e.test.ts`

**Interfaces:**
- Consumes: `toolkitRows` (Step 2); `content`, `techniqueName` (Step 4); `getMentor`, `showDialogue`, `createDialogue` (Step 5); `PlayerStore` (Step 3).
- Produces:
```ts
// build/assets/manifest.ts
export interface AssetEntry { key: string; file: string /* repo-relative */; source: 'art' | 'prototype' }
export const ART_DIRS: Readonly<Record<string, string>>;   // { characters: 'char', items: 'item', scenes: 'scene', ui: 'ui' }
export const PROTOTYPE_ALIASES: Readonly<Record<string, string>>;
  // pan→char.pan, player→char.player, cook_in→char.leela, cook_mx→char.marisol, cook_jp→char.haruka,
  // butcher→char.bram, grocer→char.wen, tofu→char.okafor-sato, bg_kitchen→scene.kitchen, bg_map→scene.map,
  // bg_market→scene.market; every i_<x> → item.<x>
export const REQUIRED_ASSETS: readonly string[];   // char.pan, char.player, char.leela, char.marisol, char.haruka, scene.kitchen, scene.map
export class AssetError extends Error { problems: string[] }
export function buildAssetManifest(files: string[]): { entries: Record<string, AssetEntry>; warnings: string[] };
// build/assets-plugin.ts: virtual:kq-assets → `export default { [key]: url }`, one `import x from '/abs/file.png?url'` per entry, so Vite hashes and serves them
export function kqAssets(opts: { repoRoot: string }): Plugin;
// scenes/phaser-host.ts
export type SceneKey = 'Kitchen' | 'Map' | 'CookKitchen';
export function showScene(stage: HTMLElement, key: SceneKey, data?: Record<string, unknown>): Promise<boolean>;   // false if Phaser failed to load
export function hideStage(stage: HTMLElement): void;
// also sets window.__kqTweens = () => number   (count of running tweens across scenes; used by Step 12's reduced-motion test)
// scenes/bridge.ts
export function emitAction(id: string): void;              // window CustomEvent 'kq:action' { id }
export function onAction(fn: (id: string) => void): () => void;
// ui/action-bar.ts
export interface SceneAction { id: string; label: string; run(): void }
export function renderActionBar(el: HTMLElement, actions: SceneAction[]): void;   // <nav aria-label="Actions"> of buttons; listens to onAction for canvas hotspots
// world/greeting.ts
export function greetingTrigger(now: Date, firstOpenedAt: string | null, lastOpenedAt: string | null): string;
// kitchen/toolkit-view.ts
export function renderToolkit(rows: ToolkitRow[], opts: { name(id: string): string; rustyLine(technique: string): string }): HTMLElement;
```
- Manifest rules:
  - `art/<dir>/<name>.png` with `dir` in `ART_DIRS` → key `${ART_DIRS[dir]}.${norm(name)}`. `norm` lowercases, strips a leading `bg_` or `i_`, and turns `_` and spaces into `-`.
  - `prototype/art/<name>.png` → `PROTOTYPE_ALIASES` key.
  - `art/` wins over `prototype/` for the same key.
  - An unknown `art/` subdirectory or non-PNG file → warning. Two `art/` files with the same key → `AssetError`. A missing required key → `AssetError` listing every missing key.
  - The plugin globs both folders at build start and on file changes in dev (`addWatchFile` on the folders).
  - A cook's kitchen backdrop key is `scene.kitchen-<cookId>` when the art agent provides one, otherwise `scene.kitchen`.
- Phaser host: `import('phaser')` the first time it's needed. If that fails, return `false`; the screens already work without it. BootScene loads every manifest entry as an image. The canvas lives in `#stage` (`aria-hidden="true"`, the canvas has `tabindex="-1"`). Phaser keyboard capture is off. Scenes draw **no text** and send hotspot clicks through `emitAction`. With reduced motion, scenes create no tweens.
- KitchenScene: `scene.kitchen` scaled by integer factors, `char.player` (arrow/WASD movement through the existing `clampToBounds`, ignored while focus is in a form field or an overlay is open), `char.pan`, and hotspots for door → `map`, pegboard → `toolkit` and shelf → `recipes`.
- Kitchen screen (`#/kitchen`):
  - h1 "Your kitchen"
  - a backdrop `<img>` fallback (pixelated) when Phaser is unavailable
  - action bar: "Talk to the Pan" (opens the panel), "Knife roll" (Toolkit), "Recipe shelf" → `#/recipes`, "Go out to the world map" → `#/map`
  - on the first kitchen mount per page load: say `greetingTrigger(now, firstOpenedAt, lastOpenedAt)` in a dialogue box and in the panel, then set `firstOpenedAt` (if null) and `lastOpenedAt = now`
- Greeting: `firstOpenedAt === null` → `greet.first_ever`. `now - lastOpenedAt ≥ 3 days` → `greet.return_after_gap`. Otherwise by local hour: [5, 11) → `greet.morning`, [11, 17) → `greet.afternoon`, [17, 22) → `greet.evening`, else `greet.late_night`.
- Toolkit display (knife roll, a modal `role="dialog"`, h2 "Your knife roll"):
  - one row per technique **the player has**: name, three tier pips (Seen · Tried · Yours) with the current tier in text, and freshness in words (Sharp / Warm / Rusty)
  - Rusty rows add `rustyLine(name)` (the Pan's `toolkit.rusty_invite`), styled with `--saffron` text on parchment, **never `--chili`**, with no warning icon
  - no totals, percentages, counts of techniques not yet learned, or locked rows (Octalysis M-1 guardrail)
  - empty state: a footnote from `bureau.footnotes` with tag `empty`
  - rows come from `toolkitRows(store.get().toolkit, localDate(now), content.techniques.freshness)`

- [ ] **8.1 Tests:**
  - `manifest.test.ts`: the real prototype list only → `char.leela.file === 'prototype/art/cook_in.png'` and `source === 'prototype'`; adding `art/characters/pan.png` → `char.pan` comes from `art`; `art/items/i_rice.png` → `item.rice`; `art/sfx/x.png` → one warning; `art/characters/Pan.png` + `art/characters/pan.png` → `AssetError`; removing `prototype/art/bg_map.png` (and no art/ map) → `AssetError` mentioning `scene.map`; the real repo (`art/` + `prototype/art/`) builds with no missing keys.
  - `greeting.test.ts`: local hours 4:59 → late_night, 5:00 → morning, 10:59 → morning, 11:00 → afternoon, 16:59 → afternoon, 17:00 → evening, 21:59 → evening, 22:00 → late_night; a gap of 2 days 23 h → time of day; exactly 3 days → `greet.return_after_gap`; `firstOpenedAt` null → `greet.first_ever` (even with a gap).
  - `toolkit-view.test.ts` (`// @vitest-environment happy-dom`; add `happy-dom` as a dev dependency): a rusty "yours" row shows the text "Yours" and the rusty line; nothing in the row uses the class `chip-blocked` or the `--chili` variable; zero rows → the empty footnote, and no "0" or "%" anywhere.
  - `kitchen.e2e.test.ts`:
    - `/` shows h1 "Your kitchen" and a Pan dialogue whose text is one of `greet.first_ever`'s lines.
    - Reload → a time-of-day greeting (not `first_ever`).
    - Seed `toolkit` with tempering `yours`, last used 200 days ago → the knife roll shows "Tempering", "Yours", "Rusty" and a `toolkit.rusty_invite` line.
    - "Recipe shelf" → `#/recipes`; "Go out to the world map" → `#/map`.
    - Block `**/assets/phaser-*.js` → the kitchen still renders the h1, the backdrop `<img>` and every action button.
    - With Phaser loaded: a `canvas` exists inside `#stage[aria-hidden="true"]`.
  - `scenes/no-canvas-text.test.ts`: no file under `src/scenes/` matches `/\.(add|make)\.(text|bitmapText)\(/`. This pins "the canvas never draws text".
    - Reduced motion: the greeting text is complete within 100 ms of appearing.
    - `expectNoA11yViolations` on the kitchen and on the open knife roll.
- [ ] **8.2 Run** `npm test -w @kitchenquest/game -- build/assets world kitchen` and `npm run test:e2e -w @kitchenquest/game -- e2e/kitchen.e2e.test.ts` → FAIL.
- [ ] **8.3 Implement.**
- [ ] **8.4 Run** both, plus `npm run build -w @kitchenquest/game` → PASS.
- [ ] **8.5 Commit** `feat(game): asset manifest, lazy Phaser, home kitchen with Pan greeting and knife roll`
