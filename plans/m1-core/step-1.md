# Step 1 — Workspace restructure + core package skeleton

**Files:**
- Move: `index.html`, `vite.config.ts`, `src/`, `public/` → `apps/game/` (use `git mv`)
- Create: `apps/game/package.json`, `apps/game/tsconfig.json` (from the current root `tsconfig.json`)
- Modify: root `package.json` (becomes the workspace root), root `tsconfig.json` → `tsconfig.base.json`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/smoke.test.ts`
- Modify: `README.md` (layout section)

**Interfaces:**
- Produces: workspace package `@kitchenquest/core` (`"type": "module"`, `"main": "src/index.ts"`, `"types": "src/index.ts"`), consumed later by `apps/game` and `apps/api`.
- Produces: root scripts `npm test` → `npm test --workspaces --if-present`, `npm run typecheck` → `npm run typecheck --workspaces --if-present`.

- [ ] **1.1 Restructure.** Root `package.json`: `"private": true`, `"workspaces": ["apps/*", "packages/*"]`, keep `typescript` as a root devDependency. `apps/game/package.json` (name `@kitchenquest/game`) takes over `phaser`, `vite`, `vitest` and the existing `dev/build/preview/typecheck/test` scripts. The existing `src/util/movement.test.ts` must still pass from `apps/game`.
- [ ] **1.2 Core skeleton.** `packages/core/package.json`: name `@kitchenquest/core`, deps `@cooklang/cooklang@0.19.1` (exact), devDeps `vitest` (same range as the game), `fast-check@^4.10.2`; scripts `test: vitest run`, `typecheck: tsc --noEmit`. `tsconfig.json` extends `../../tsconfig.base.json` with `strict: true`.
- [ ] **1.3 Smoke test** `packages/core/src/smoke.test.ts`:

```ts
import { CORE_VERSION } from './index';
it('exports a version', () => { expect(CORE_VERSION).toBe('0.1.0'); });
```
- [ ] **1.4 Run** `npm install && npm test && npm run typecheck` from the repo root. Expected: both workspaces' tests pass, no type errors. Also run `npm run build -w @kitchenquest/game`: the build succeeds.
- [ ] **1.5 Commit** `chore: npm workspaces; move game to apps/game; add @kitchenquest/core`
