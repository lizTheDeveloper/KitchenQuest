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
- Allergy and diet rule help, meal logging, export and delete are free forever (§16); free-form chat has a daily allowance.
- **One abuse limit, the same for every plan:** at most 200 meal logs and 200 rule edits that loosen a rule per player per rolling day (`apps/api/src/usage/write-cap.ts`, controller ruling M-4). It is far above human use, it reads no plan or entitlement (a Guild player meets it exactly where a free player does), it is never sold or raised for pay, and it never blocks adding, removing or tightening a rule. The Pan says so plainly (`write.daily_limit`). `apps/api/test/free-forever.test.ts` pins all of this.
- In production with `AI_ENABLED=true`, the API compares the **live** AI config (model, `AI_PROVIDERS`, prompt, tools and request parameters) with `apps/api/eval/last-pass.json` at boot. If they differ, it logs an `eval_gate` error and starts with the AI off, so the scripted mentor answers every turn (I-3). Run the eval with the exact production config before changing any of these.

### The mentor eval

`npm run eval:mentor -w @kitchenquest/api` runs the Qwen spike's 41 conversations (`apps/api/eval/cases.ts`), three times each, through the real app against the real model, with made-up players in a throwaway database. It never runs in `npm test`. The bar: 0 hard (safety) fails and at least 95% of tool cases fully correct. A passing run writes `apps/api/eval/last-pass.json`; commit it.

```bash
eval "$(scripts/dev-db.sh url)"; export TEST_DATABASE_URL
OPENROUTER_API_KEY=… AI_PROVIDERS=tenstorrent npm run eval:mentor -w @kitchenquest/api
# behind an HTTPS proxy, add NODE_USE_ENV_PROXY=1 so Node's fetch uses it
```

`apps/api/test/eval-gate.test.ts` (in `npm test`, no network) fails when the prompt, tools, model, request parameters (temperature, `max_tokens`, reasoning, `tool_choice`) or `AI_PROVIDERS` in `.env.example` change without a new passing `last-pass.json`. `MENTOR_EVAL_GATE=skip-no-network` skips it, for a CI job with no recorded eval; the default CI job never sets it. Never write `last-pass.json` by hand.

## The weekly loop (M5)

Plan the week, shop it, cook it, keep it. Every part works with the AI off and signed out, and none of it is ever sold (§16, never rules 3–9): `apps/api/test/free-forever.test.ts` and `apps/game/e2e/free-forever.e2e.test.ts` pin it for a capped player with no entitlements.

- **Plan** (`#/plan`, Form 7-W): dishes per weekday, each checked by the rules engine (⛔ is never cookable, ❓ stays ❓), the hard-week box and at most one *One More Technique* a week ("Not this week" is a full answer). The Pan can propose a plan card ("plan my week: parippu on Sunday, pick two"); code matches the dish names and picks, never the model (Ruling 14). At the AI cap the chat turn stays scripted and the form still plans (Ruling 27).
- **Market** (`#/market`, Form 12-M): the plan's ingredients minus the pantry, by stall. Ticking puts the item in the pantry, dated; "That's the shop done" closes the run.
- **Use-It-Up** (the kitchen): at most one rescue nudge a day for food the player bought (`data/keeps.json`), offering a Pantry Frame (`#/frame/<id>`, `content/frames/`) or the compost. Off in Settings, and never in Family Table mode.
- **Quests** (`#/visit/<cook>`): each cook's quest (talk, errand, drill, riddle, recognize, cook), with adapted paths so a player's rules never lock them out of progress.
- **Cook → log**: after cook mode, three skippable questions: who ate (Cooked for Someone: fixed choices, no names), a margin note, and a one-tap meal log. Notes, Cooked for Someone and meal logs are account-only.
- **The Recipe Book** (`#/book`, `#/book/<slug>`): one page per taught dish, with the dates cooked and the player's notes; "Download my book" saves a self-contained HTML file.
- **Progress is event-sourced** (Ruling 7): the game sends events (`POST /progress/events`), never amounts; core computes the grants from `data/rewards.yaml` (XP, the level curve, stamps, trust thresholds; tunable data). `reward_grants` is append-only, and a database trigger refuses any UPDATE (`apps/api/migrations/0017_reward_grants_append_only.sql`): nothing earned is taken back (§6). Signed out, progress, the plan and the list live on the device; signing in offers to add them to the account (`upload: true`), and the game shows the higher of the account's and the device's values.
- **Family Table mode** keeps nothing from the loop: lines and chips only, no text box, no writes (Ruling 25).
- **API routes** (all need a session): `GET /progress`, `POST /progress/events`; `GET /plans/current`, `PUT`/`DELETE /plans/:weekStart`; `POST /market-runs`, `POST /market-runs/:id/ticks`, `POST /market-runs/:id/finish`; `GET`/`POST /notes`, `DELETE /notes/:id`; `POST /shared-table`, `GET /shared-table/tally`, `DELETE /shared-table/:id`. Plans, market runs, notes and meal-log events are health data and need the `health_data` consent (notice v3); see `docs/compliance/data-inventory.md` (H-11–H-13, U-5, L-5).
- **Data files:** `data/rewards.yaml`, `data/techniques.yaml` (`adjacent`, `prereqs`), `data/stalls.json`, `data/food-groups.json`, `data/keeps.json`; content in `content/frames/` and each cook's `quest`. The API loads and checks them at boot and refuses to start on a bad file, naming it.
- M5 adds no environment variable and no script.

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
  src/quests/             # the quest runner (M5)
  src/progress/           # the progress log, sync and the account/device views (M5)
  src/week/               # the plan, the market list, Use-It-Up (M5)
  src/book/               # the Recipe Book, margin notes, the after-cook slips (M5)
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
