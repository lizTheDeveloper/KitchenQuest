# Step 4 — Rule types, validation, and active phases

**Files:**
- Create: `packages/core/src/rules/types.ts`, `packages/core/src/rules/active.ts`, `packages/core/src/rules/active.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**
- Consumes: `IngredientGraph.has` (Step 3).
- Produces:
```ts
export type Severity = 'anaphylactic' | 'allergy' | 'intolerance' | 'preference';
export interface Rule {
  id: string;
  target: { kind: 'ingredient' | 'category' | 'component'; ids: string[] };
  type: 'avoid' | 'limit' | 'prefer';
  severity: Severity;
  limit?: { amount: number; unit: string; per: 'serving' | 'day' };
  phase?: { start: string; end?: string; journeyId?: string };
  note?: string;
}
export const SEVERE: ReadonlySet<Severity>;                          // anaphylactic, allergy
export function validateRules(rules: Rule[], graph: IngredientGraph): string[];  // [] when valid
export function isActive(rule: Rule, date: string): boolean;
```

- [ ] **4.1 Write failing tests:**
  - `validateRules` returns one problem naming the id for a target id missing from the graph; one for an empty `target.ids`; one for a `limit` rule without `limit`; one for a malformed date (`'12/01/2026'`); and `[]` for a valid rule.
  - `isActive` (Review Focus 3): no phase → `true`; `{start:'2026-11-10', end:'2026-12-01'}` → `false` on `2026-11-09`, `true` on `2026-11-10` and `2026-12-01`, `false` on `2026-12-02`; open-ended `{start:'2026-11-10'}` → `true` on `2030-01-01`.
- [ ] **4.2 Run.** Expected: FAIL.
- [ ] **4.3 Implement** `validateRules` and `isActive` (string comparison of ISO dates; validate format with `/^\d{4}-\d{2}-\d{2}$/` plus a real-date check).
- [ ] **4.4 Run.** Expected: PASS.
- [ ] **4.5 Commit** `feat(core): rule types, validation, phase activity`
