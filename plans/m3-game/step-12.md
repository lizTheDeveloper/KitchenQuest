# Step 12 — Accessibility and never-rules sweep, CI, README

Earlier tasks each check their own screens. This one checks the whole game the way a player meets it: keyboard only, with reduced motion, in Family Table mode, at phone width. It also checks that no screen carries a purchase prompt, a streak or forbidden copy, and puts it all in CI.

**Files:**
- Create: `apps/game/e2e/screens.ts` (the list below, shared by the sweep tests), `apps/game/e2e/a11y.e2e.test.ts`, `apps/game/e2e/keyboard.e2e.test.ts`, `apps/game/e2e/motion.e2e.test.ts`, `apps/game/e2e/never-rules.e2e.test.ts`
- Modify: `.github/workflows/ci.yml` (add a `game` job), root `README.md` (a game section)

**Interfaces:**
- Consumes: `openApp`, `expectNoA11yViolations`, `expectNoHorizontalScroll`, `offOrigin` (Step 3).
- Produces:
```ts
// e2e/screens.ts
export interface ScreenCase { label: string; path: string; open?: (page: Page) => Promise<void>; seed?: Partial<PlayerState> }
export const SCREENS: ScreenCase[];
```
- `SCREENS`:
  - kitchen
  - kitchen with the knife roll open (a seeded rusty technique)
  - recipe shelf
  - recipe card (ok)
  - recipe card (blocked, severe rule)
  - map
  - map with the travel permit open
  - visit (dialogue showing)
  - visit with the recipe card open
  - cook mode step 1
  - cook mode with a running timer
  - certificate
  - settings (signed out)
  - settings (signed in, `/api/me` mocked)
  - mentor panel open (standard)
  - mentor panel open (Family Table)
  - `/auth/verify?token=x`
  - not found
- Banned rendered text (`never-rules`), in two scopes, because written content legitimately says "buy the dark ones" and "nobody's food is 'exotic'":
  - **UI chrome**: text outside any `[data-content]` element must not match `/\b(buy|purchase|upgrade|subscribe|subscription|premium|guild|pro plan|price|streak|in a row|exotic|unlock(ed)?|loot(ed)?|acquired|discovered)\b|\$\s?\d/i`. This covers spec §16 never rules 1–9, §19, and voice.md §0.2–0.3.
  - **Content** (inside `[data-content]`): must not match `/\b(upgrade|subscribe|subscription|premium|guild|pro plan|streak)\b|\$\s?\d/i`. The Pan and cooks never sell (never rule 7), and nothing counts streaks.

- [ ] **12.1 Tests:**
  - `a11y.e2e.test.ts`, for every `SCREENS` case:
    - `expectNoA11yViolations`
    - exactly one visible `h1`
    - every visible `button` and `a` has a non-empty accessible name
    - no `img` lacks `alt` (decorative ones use `alt=""`)
    - `#stage` is `aria-hidden="true"`
    - at width 400: `expectNoHorizontalScroll`
    - with `page.emulateMedia({ colorScheme: 'dark' })` and 200% text (`document.documentElement.style.fontSize = '200%'`) the h1 and the primary action are still visible, with no horizontal scroll
  - `keyboard.e2e.test.ts`: using only `keyboard.press` (no mouse, no `click()`), from `/`:
    - Tab to "Go out to the world map", Enter → `#/map`
    - Tab to the Leela pin, Enter → the permit dialog has focus; Tab to "Stamp it ✔", Enter → `#/visit/leela`
    - Enter through every intro line, Tab to "See the recipe: Parippu", Enter; Tab to "Cook it", Enter → cook mode with focus on the h1
    - ArrowRight to step 2, Tab to the timer button, Enter → the tray shows a timer
    - ArrowRight × 5 to "Done ▶", Enter → the certificate; Enter on confirm → `#/kitchen`
    - Then: Tab to `#pan-button`, Enter → the panel; type "thanks", Enter → a Pan bubble; Escape → focus on `#pan-button`
    - Every focused element along the way has a visible focus style (`getComputedStyle(el).outlineStyle !== 'none'` or a non-none `box-shadow`)
  - `motion.e2e.test.ts` with `emulateMedia({ reducedMotion: 'reduce' })`:
    - the greeting text is complete within 100 ms of the box appearing
    - after stamping the travel permit, `document.getAnimations().length === 0`
    - the Phaser `Kitchen` scene has no running tweens (`window.__kqTweens?.() ?? 0` is 0, a count exposed by `phaser-host.ts` in all builds since it carries no data)
    - Settings "Reduce motion: On" with the media query not set → the same results
  - `never-rules.e2e.test.ts`:
    - for every `SCREENS` case, both scopes pass (collect text with a `TreeWalker`, splitting on the nearest `[data-content]` ancestor), and `offOrigin(requests)` is empty
    - for the Family Table panel case also: no element matches `textarea, input[type="text"], #pan-talk`
    - the seeded knife roll with a rusty technique contains no element whose computed `color` or `background-color` equals the `--chili` value
- [ ] **12.2 Run** `npm run test:e2e -w @kitchenquest/game` → fix every failure in the screen that owns it, not in the test. Do not add banned-word exceptions. If a written content line trips the pattern, report it for the writers rather than editing the line yourself, unless it is an obvious mistake.
- [ ] **12.3 CI:** add a `game` job to `.github/workflows/ci.yml`:
  - Node 22, `npm ci`
  - `npx playwright install --with-deps chromium` (**CI runners only**; never run it in this container, which has Chromium pre-installed)
  - `npm run typecheck -w @kitchenquest/game`
  - `npm test -w @kitchenquest/game`
  - `npm run build -w @kitchenquest/game`
  - `npm run test:e2e -w @kitchenquest/game`
  - Keep the existing `test` job unchanged.
- [ ] **12.4 README:** under "Getting started", add:
  - `npm run test:e2e` (builds, then drives Chromium against `vite preview`)
  - the `/api` proxy and `KQ_API_ORIGIN`
  - that the M2 API's `APP_ORIGIN` must be the game's origin, so magic links land on `/auth/verify`
  - that content and art are compiled at build time (a bad YAML file fails the build with its path)
  - that `art/` overrides `prototype/art/` by manifest key
  - Update the layout block for `apps/game` (`build/`, `e2e/`, `src/shell|content|mentor|recipes|cook|kitchen|world|pwa|api|auth`).
- [ ] **12.5 Run** from the root: `npm run typecheck && npm test && npm run test:e2e` → PASS (the API tests need `TEST_DATABASE_URL`, as before).
- [ ] **12.6 Commit** `test(game): accessibility, keyboard, reduced-motion and never-rules sweeps; CI game job`
