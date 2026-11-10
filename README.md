# Kitchen Quest

A web game built with [Phaser 3](https://phaser.io), TypeScript, and [Vite](https://vite.dev).

## Getting started

```bash
npm install
npm run dev        # dev server at http://localhost:5173
npm run test:e2e   # builds the game, then drives Chromium against `vite preview`
```

### The game

- **API.** The game talks to the M2 API same-origin under `/api`. `vite dev` and `vite preview` proxy `/api/*` to `KQ_API_ORIGIN` (default `http://localhost:3000`), stripping the `/api` prefix; in production the reverse proxy does the same. Without an API the game runs signed out.
- **Sign-in links.** The API's `APP_ORIGIN` must be the game's origin (e.g. `http://localhost:5173` for `npm run dev`), so magic links land on the game's `/auth/verify` page.
- **Content and art are compiled at build time.** The YAML under `content/` and the `.cook` recipes under `recipes/` are validated and bundled when Vite builds; a bad YAML file fails the build and names its path.
- **Art.** Files in `art/` override those in `prototype/art/` by manifest key; `prototype/art/` is the fallback.
- **E2E tests** use Playwright's Chromium (`playwright@1.63.0`). CI installs it with `npx playwright install --with-deps chromium`; dev containers come with it.

## Scripts

| Command             | What it does                              |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Start the Vite dev server with hot reload |
| `npm run build`     | Type-check and build to `dist/`           |
| `npm run preview`   | Serve the production build locally        |
| `npm run typecheck` | Run the TypeScript compiler, no output    |
| `npm test`          | Run unit tests with Vitest                |

## Running the API

```bash
scripts/dev-db.sh start            # private Postgres 16 on port 54329 (data in .data/pg, or /var/lib/kitchenquest-pg as root); prints the URLs
eval "$(scripts/dev-db.sh url)"; export TEST_DATABASE_URL   # needed by `npm test`
export DATABASE_URL DATA_KEYS="k1:$(openssl rand -base64 32)" DATA_KEY_ID=k1 PSEUDONYM_KEY=$(openssl rand -base64 32)
npm run dev -w @kitchenquest/api   # http://localhost:3000/health
```

`scripts/dev-db.sh stop` stops the cluster. Without local Postgres binaries use `docker compose up -d db` (same port). See `.env.example` for all variables. API tests fail with a clear message when `TEST_DATABASE_URL` is unset.

## Layout

npm workspaces monorepo.

```
apps/game/                # Phaser game + HTML overlays, a PWA (@kitchenquest/game)
  index.html              # page shell: HUD, #stage (the canvas, aria-hidden) and #view (the HTML screen)
  auth/verify/            # the magic-link landing page (/auth/verify)
  build/                  # Vite plugins: content + art compilers, service worker, security headers
  e2e/                    # Playwright tests against `vite build` + `vite preview` (screens.ts lists every screen)
  public/                 # icons and the web manifest (served as-is)
  src/shell/              # router, screens, motion settings
  src/content/            # the compiled content, typed
  src/mentor/             # the Pan: dialogue picker and the mentor panel
  src/recipes/            # recipe shelf and recipe cards (status from core `check`)
  src/cook/               # cook mode: steps, timers, wake lock, certificate
  src/kitchen/            # the home kitchen and the knife roll
  src/world/              # world map, travel permit, cook visits
  src/pwa/                # service worker and install prompts
  src/api/                # M2 API client
  src/auth/               # the /auth/verify page
  src/scenes/             # Phaser scenes (no text on the canvas)
  src/util/               # pure game logic (unit-testable, no Phaser)
apps/api/                 # Fastify API (@kitchenquest/api)
packages/core/            # @kitchenquest/core: pure recipe/allergy logic, no I/O
tsconfig.base.json        # shared compiler options, extended by each workspace
```

Keep game rules in plain TypeScript (`packages/core`, or `apps/game/src/util/`) so they can be tested without a browser; scenes should mostly wire input and rendering to that logic.
