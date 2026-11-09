# Kitchen Quest

A web game built with [Phaser 3](https://phaser.io), TypeScript, and [Vite](https://vite.dev).

## Getting started

```bash
npm install
npm run dev        # dev server at http://localhost:5173
```

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
export DATABASE_URL DATA_KEYS="k1:$(openssl rand -base64 32)" DATA_KEY_ID=k1
npm run dev -w @kitchenquest/api   # http://localhost:3000/health
```

`scripts/dev-db.sh stop` stops the cluster. Without local Postgres binaries use `docker compose up -d db` (same port). See `.env.example` for all variables. API tests fail with a clear message when `TEST_DATABASE_URL` is unset.

## Layout

npm workspaces monorepo.

```
apps/game/                # Phaser game (@kitchenquest/game)
  index.html              # page shell, mounts the game into #game
  public/assets/          # images, audio, tilemaps (served as-is)
  src/main.ts             # Phaser game config
  src/scenes/             # one file per Phaser scene
  src/util/               # pure game logic (unit-testable, no Phaser)
apps/api/                 # Fastify API (@kitchenquest/api)
packages/core/            # @kitchenquest/core: pure recipe/allergy logic, no I/O
tsconfig.base.json        # shared compiler options, extended by each workspace
```

Keep game rules in plain TypeScript (`packages/core`, or `apps/game/src/util/`) so they can be tested without a browser; scenes should mostly wire input and rendering to that logic.
