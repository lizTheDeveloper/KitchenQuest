# Tooling Step 2 — Merge-point hardening (runs right after the game branch merges)

Deferred from step 1 so the parallel game branch isn't disrupted mid-task.

1. **One-time Prettier reformat** of the whole repo, in its own commit `style: prettier reformat (no logic changes)`, followed by adding `npm run format:check` to the CI `lint` job. Add the commit SHA to `.git-blame-ignore-revs`.
2. **Enable `noUncheckedIndexedAccess`** in `tsconfig.base.json`. Fix every new type error by real guards or by `!` with a one-line reason only where an invariant genuinely holds (the step-1 review listed the known safe sites in `packages/core/src/rules/check.ts` and `apps/api/src/auth/rate-limit.ts`). This should clear the 30 `no-unnecessary-condition` warnings; then raise that rule to `error`.
3. **Lint the game code** that arrived with the merge: fix all errors, justify disables.
4. Verify: `npm run lint`, `npm run format:check`, `npm run typecheck`, all tests, game build.
