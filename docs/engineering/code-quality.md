# Code quality checks

`npm run lint` is the one command. CI runs it in the `lint` job on every push and pull request.
It runs three tools in order:

| Script | Tool | What it catches |
| --- | --- | --- |
| `lint:eslint` | ESLint 9 + typescript-eslint (type-aware) | Bugs and unsafe patterns: floating or misused promises, non-exhaustive `switch`, `any`, `==`, needless conditions. |
| `lint:arch` | dependency-cruiser (`.dependency-cruiser.cjs`) | Architecture rules: `packages/core` has no Node built-ins and never imports `apps/`; `apps/game` never imports `apps/api`; nothing under `org/` imports health modules (C-10); no circular imports. |
| `lint:dead` | knip (`knip.json`) | Unused files, exports and dependencies. |

`npm run format:check` runs Prettier (`.prettierrc`) but is **not** part of `npm run lint` or CI yet.
The repo gets one reformat commit at the next merge point with the game branch.

## Setup

The lint tools live in `tools/lint`, a standalone install (not an npm workspace) with its own
lockfile. typescript-eslint, knip and dependency-cruiser need the TypeScript JS API, which the
TypeScript 7 native compiler the repo builds with does not have, so `tools/lint` pins TypeScript
5.9.3 for them only. The repo compiler is unchanged.

```sh
npm ci
npm run lint:install   # npm ci --prefix tools/lint
npm run lint
```

When typescript-eslint supports TypeScript 7, delete `tools/lint/package.json`'s `typescript`
entry, move the tools into the root `devDependencies`, and drop `lint:install`.

## Fixing findings

- ESLint: `tools/lint/node_modules/.bin/eslint --fix <path>` fixes the auto-fixable ones.
  The config is `tools/lint/eslint.config.js` (re-exported by the root `eslint.config.js`).
  Tests and scripts have looser overrides there. Warnings (`no-unnecessary-condition`, 30 at the time of writing) do not fail the
  build, but do not add new ones. They are ticketed in `plans/tooling/step-2.md`.
- Architecture: the error names the rule and the import chain. Move the code or the dependency; do
  not edit the rule to make it pass. A new boundary goes in `.dependency-cruiser.cjs`.
- Dead code: delete it, or drop the `export` if it is only used in its own file. If it is
  deliberately public (a future entry point), tag its doc comment `@public`, or add the entry file to
  `knip.json`.

## Justifying a disable

Disable one rule on one line, with a reason after `--`. Never disable a whole file or use a blanket
`eslint-disable`. Unused disables are errors, so stale ones get cleaned up.

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the driver's row type is untyped
```

If the same disable is needed repeatedly, add a scoped override in `tools/lint/eslint.config.js`
with a comment, as done for Fastify `routes.ts` plugins.
