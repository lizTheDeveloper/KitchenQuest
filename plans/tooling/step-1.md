# Tooling Step 1 — Linting, architecture rules, dead-code checks

Founder request (2026-11-09): add linters and checks so the codebase stays maintainable.

**Scope:** whole monorepo (`packages/core`, `apps/api`, `apps/game`, scripts). Runs in this checkout (branch `claude/eager-cori-h3gmju`). The game milestone is being built in parallel on another branch and merges later; its code must pass these checks at merge time, so keep rules sensible, not punitive.

1. **ESLint 9 flat config** at the repo root with `typescript-eslint` (type-aware, `projectService`).
   - Rules on: `recommendedTypeChecked`, plus `no-floating-promises`, `no-misused-promises`, `await-thenable`, `switch-exhaustiveness-check`, `consistent-type-imports`, `no-unnecessary-condition` (warn), and `eqeqeq`.
   - Allow `any` only with an inline disable plus a reason.
   - Separate overrides for tests (looser) and for scripts.
   - Formatting rules off; Prettier owns formatting.
   - Fix all errors in existing code. Don't blanket-disable. If a rule produces many false positives, downgrade it to `warn`, and list each such decision in the report.
2. **Architecture rules** with `dependency-cruiser` (config `.dependency-cruiser.cjs`):
   - `packages/core/src` imports no `node:` modules or Node built-ins, and nothing from `apps/`. This is the "core does no I/O" constraint. Tests under `packages/core/test` are allowed `node:fs`.
   - `apps/game` never imports from `apps/api`.
   - Compliance C-10: nothing under any `org/` path may import health modules (`rules/`, `consent/health-data`, `crypto/userkeys`). No `org/` exists yet, so this rule guards the future.
   - No circular dependencies.
3. **knip** for unused files, exports and dependencies, with a config that understands the workspaces, Vite and Vitest entry points. Fix what it finds, or record a justified ignore.
4. **Prettier:** add `.prettierrc` (single quotes, 2-space indent, width 100, matching existing style as closely as possible), `.prettierignore` (migrations, lockfile, `art/`, `prototype/`, generated output) and a `format:check` script. **Do NOT reformat the repo in this step**, and don't add `format:check` to CI yet. The one-time reformat happens at the next merge point with the game branch, as its own commit.
5. **Scripts and CI:**
   - Root `npm run lint` runs eslint, depcruise and knip.
   - CI gains a `lint` job, or steps in the existing job, running `npm run lint`.
   - Add a short `docs/engineering/code-quality.md` covering what runs, how to fix, and how to justify a disable.
6. **Verify:** `npm run lint`, `npm run typecheck` and `npm test --workspaces` (with TEST_DATABASE_URL) all pass, with no warnings left un-ticketed in the report.

Commit `chore: ESLint, dependency-cruiser boundaries, knip, Prettier config, lint in CI`.
