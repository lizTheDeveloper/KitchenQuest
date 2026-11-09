# Step 2 — Core: Technique Toolkit and Freshness

Data model and pure math only (spec §6, §17). M3 records one kind of event, "cooked", when cook mode finishes (Step 7). It also displays the toolkit (Step 8). Lessons, refresher XP and suggestions come in M5.

**Files:**
- Create: `packages/core/src/toolkit/toolkit.ts`, `packages/core/src/toolkit/toolkit.test.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/src/engine.ts` (export the toolkit from both)

**Interfaces:**
- Produces:
```ts
export type Tier = 'seen' | 'tried' | 'yours';
export type Freshness = 'sharp' | 'warm' | 'rusty';
export interface FreshnessThresholds { warmAfterDays: number; rustyAfterDays: number }
export type TechniqueEvent =
  | { kind: 'lesson'; technique: string; at: string }                    // at: YYYY-MM-DD
  | { kind: 'cooked'; technique: string; at: string; recipe: string };   // recipe: canon slug
export interface TechniqueRecord { tier: Tier; firstAt: string; lastUsedAt: string; recipes: string[] }
export interface ToolkitState { techniques: Record<string, TechniqueRecord> }
export const EMPTY_TOOLKIT: ToolkitState;
export function recordTechnique(state: ToolkitState, event: TechniqueEvent): ToolkitState;   // pure, never mutates input
export function freshness(lastUsedAt: string, today: string, t: FreshnessThresholds): Freshness;
export interface ToolkitRow { technique: string; tier: Tier; freshness: Freshness | null }   // null for 'seen'
export function toolkitRows(state: ToolkitState, today: string, t: FreshnessThresholds): ToolkitRow[];   // sorted by technique id
export function validateThresholds(t: FreshnessThresholds): string[];
```
- Tier rule: a lesson gives at least `seen`. A cooked event gives at least `tried`. Two or more distinct `recipes` give `yours`. The new tier is `max(old, computed)`, so it never drops.
- `lastUsedAt` is the later of the old value and `event.at`. An older event arriving late (offline sync) never makes a technique look staler. `firstAt` is the earlier of the two.
- Freshness: `days` is the whole-day difference between two `YYYY-MM-DD` strings, computed as calendar dates so time zones and DST don't apply. `days < warmAfterDays` → sharp. `days < rustyAfterDays` → warm. Otherwise rusty. A `lastUsedAt` after `today` (clock skew) → sharp.
- Invalid dates throw, using core's existing `isValidDate`. There is deliberately **no** function that removes a technique or lowers a tier (§6, never rule 6).

- [ ] **2.1 Tests** (`toolkit.test.ts`):
```ts
const T = { warmAfterDays: 42, rustyAfterDays: 120 };
test('lesson → seen; cooked → tried; same recipe twice stays tried; two recipes → yours', ...);
test('a lesson after yours keeps yours', ...);
test('tier never decreases (property)', () => fc.assert(fc.property(fc.array(eventArb), (events) => {
  let s = EMPTY_TOOLKIT;
  for (const e of events) { const next = recordTechnique(s, e);
    for (const [id, r] of Object.entries(s.techniques)) expect(rank(next.techniques[id].tier)).toBeGreaterThanOrEqual(rank(r.tier));
    s = next; }
})));
test('recordTechnique does not mutate its input', ...);   // deep-freeze the input
test('late older event does not move lastUsedAt back', ...);   // record 2026-03-01 then 2026-01-01 → lastUsedAt '2026-03-01', firstAt '2026-01-01'
test('freshness boundaries', () => {
  expect(freshness('2026-01-01', '2026-02-11', T)).toBe('sharp');  // 41 days
  expect(freshness('2026-01-01', '2026-02-12', T)).toBe('warm');   // 42
  expect(freshness('2026-01-01', '2026-04-30', T)).toBe('warm');   // 119
  expect(freshness('2026-01-01', '2026-05-01', T)).toBe('rusty');  // 120
  expect(freshness('2026-03-10', '2026-03-01', T)).toBe('sharp');  // future lastUsed
  expect(freshness('2026-03-28', '2026-03-30', T)).toBe('sharp');  // across a DST change
});
test('freshness never changes tier', ...);   // a 'yours' technique unused 400 days → row.tier 'yours', freshness 'rusty'
test('seen rows have null freshness', ...);
test('validateThresholds', ...);   // {42,120} → []; {120,42}, {0,10}, {4.5,10}, {-1,10} → each one problem
test('public surface has no removal', () => {
  expect(Object.keys(toolkitModule).sort()).toEqual(['EMPTY_TOOLKIT','freshness','recordTechnique','toolkitRows','validateThresholds']);
});
test('invalid dates throw', ...);   // at: '2026-13-01'
```
- [ ] **2.2 Run** `npm test -w @kitchenquest/core -- toolkit` → FAIL.
- [ ] **2.3 Implement** `toolkit.ts` and export it.
- [ ] **2.4 Run** `npm test -w @kitchenquest/core && npm run typecheck -w @kitchenquest/core` → PASS.
- [ ] **2.5 Commit** `feat(core): Technique Toolkit tiers and Freshness`
