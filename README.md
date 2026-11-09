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

## Layout

```
index.html            # page shell, mounts the game into #game
public/assets/        # images, audio, tilemaps (served as-is)
src/main.ts           # Phaser game config
src/scenes/           # one file per Phaser scene
src/util/             # pure game logic (unit-testable, no Phaser)
```

Keep game rules in plain TypeScript under `src/util/` (or similar) so they can be tested without a browser; scenes should mostly wire input and rendering to that logic.
