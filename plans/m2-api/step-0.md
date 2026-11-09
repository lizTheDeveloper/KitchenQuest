# Step 0 — Carry-over core safety fixes from the M1 final review

**Files:** Modify `packages/core/src/rules/check.ts`, `packages/core/src/rules/check.test.ts`

1. **Unit folding (Important, "never ok").** `check.ts` folds limit units case-insensitively except exactly `t`/`T`. Dotted or plural forms (`T.`, `t.`, `Ts`, `ts`) fold together, so `@salt{1%T.}` against a 2 `t.`/serving limit reads `ok`. Replace with a whitelist: units fold case-insensitively only when the lowercase form is in a known case-insensitive set (`g, kg, mg, oz, lb, ml, l, tsp, tbsp, cup` and their plurals); anything else must match exactly. Tests: `T.` vs `t.` → unverified; `G` vs `g` → compared; `TBSP` vs `tbsp` → compared.
2. **Unmeasured line softens a known violation (Important).** When a per-serving limit's matching lines include one with a null quantity or a different unit, the rule currently yields only one `unverified` label finding, even when the measurable lines alone already exceed the limit. Change: sum the measurable same-unit lines; if that sum alone exceeds the limit, emit `match` findings for those lines (blocked or swap as usual) **and** the label finding for the unmeasurable line(s). Test: `@salt{50%g}` + `@table salt{}` vs 8 g/serving (servings 1) → `blocked`.

Run `npm test` and `npm run typecheck` from root. Commit `fix(core): whitelist case-insensitive units; known limit violations stay blocked`.
