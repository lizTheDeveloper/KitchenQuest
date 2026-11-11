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

## The Pan (the AI mentor)

The Pan is the mentor in the panel on every screen. It always works without AI: a scripted engine in the game answers from the written lines in `content/dialogue/pan.yaml` and makes the same cards. With the API's `AI_ENABLED=true` (and the player's `ai_health` consent for anything health-related), turns go to `POST /mentor/turn`, where a model on OpenRouter may only **propose** cards (`propose_rule`, `propose_meal_log`, `propose_profile`, `propose_pantry_change`). Code builds and spells every card, and nothing is written until the player taps it (or types "yes" to a non-severe card). The model's own words are never shown.

- `AI_ENABLED` is `false` by default; with it off no other AI variable is read and the mentor runs scripted. To turn it on, set `OPENROUTER_API_KEY`, `AI_PROVIDERS` and `AI_DAILY_BUDGET_USD` (see `.env.example`). Outside production, use synthetic data only.
- In production the API **refuses to boot** with `AI_ENABLED=true` until `docs/compliance/processors.json` lists the OpenRouter DPAs as signed (P-11; checklist in `docs/compliance/vendors/openrouter.md`).
- Allergy and diet rule help, meal logging, export and delete are never capped (§16); free-form chat has a daily allowance.

### The mentor eval

`npm run eval:mentor -w @kitchenquest/api` runs the Qwen spike's 41 conversations (`apps/api/eval/cases.ts`), three times each, through the real app against the real model, with made-up players in a throwaway database. It never runs in `npm test`. The bar: 0 hard (safety) fails and at least 95% of tool cases fully correct. A passing run writes `apps/api/eval/last-pass.json`; commit it.

```bash
eval "$(scripts/dev-db.sh url)"; export TEST_DATABASE_URL
OPENROUTER_API_KEY=… AI_PROVIDERS=tenstorrent npm run eval:mentor -w @kitchenquest/api
# behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1 so Node's fetch uses it
```

`apps/api/test/eval-gate.test.ts` (in `npm test`, no network) fails when the prompt, tools, model or `AI_PROVIDERS` in `.env.example` change without a new passing `last-pass.json`. `MENTOR_EVAL_GATE=skip-no-network` skips it, for a CI job with no recorded eval; the default CI job never sets it. Never write `last-pass.json` by hand.

## Deploying the API

A checklist for every production deploy:

- [ ] `NODE_ENV=production`. The DPA gate (P-11) keys on it: without it the API would start the AI with an unsigned processor.
- [ ] `TRUST_PROXY` set to the reverse proxy (hop count or addresses): the search, export and mentor limiters key on the client IP.
- [ ] `DATA_KEYS`, `DATA_KEY_ID` and `PSEUDONYM_KEY` from the secret store, never from the repo (`docs/compliance/key-management.md`).
- [ ] `APP_ORIGIN` is the game's origin; `MAILER=smtp` with `SMTP_URL` and the mail-provider settings in `docs/compliance/mail-provider.md`.
- [ ] `AI_ENABLED=false` until `processors.json` lists the OpenRouter DPAs as signed; then the production `OPENROUTER_API_KEY` (not the dev key), `AI_PROVIDERS` as in `.env.example`, and `AI_DAILY_BUDGET_USD`.
- [ ] `docs/compliance/` (`notices/`, `processors.json`) ships in the image: the API reads both at boot.
- [ ] The reverse proxy sends the security headers in `apps/game/deploy/`.

## Layout

npm workspaces monorepo.

```
apps/game/                # Phaser game + HTML overlays, a PWA (@kitchenquest/game)
  index.html              # page shell: HUD, #stage (the canvas, aria-hidden) and #view (the HTML screen)
  auth/verify/            # the magic-link landing page (/auth/verify)
  build/                  # Vite plugins: content + art compilers, service worker, security headers
  deploy/                 # production server snippets (security headers for the reverse proxy)
  scripts/                # one-off tools (make-icons.mjs: `npm run icons -w @kitchenquest/game`)
  e2e/                    # Playwright tests against `vite build` + `vite preview` (screens.ts lists every screen)
  public/                 # icons and the web manifest (served as-is)
  public/assets/          # static files served as-is (game art is compiled from art/ and prototype/art/)
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
  eval/                   # the mentor eval: cases, judge, runner (`npm run eval:mentor`), last-pass.json
packages/core/            # @kitchenquest/core: pure recipe/allergy logic, no I/O
tsconfig.base.json        # shared compiler options, extended by each workspace
```

Keep game rules in plain TypeScript (`packages/core`, or `apps/game/src/util/`) so they can be tested without a browser; scenes should mostly wire input and rendering to that logic.
