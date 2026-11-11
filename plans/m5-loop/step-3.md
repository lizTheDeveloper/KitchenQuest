# Step 3 — Core: the week (plan, market list, pantry dates, Use-It-Up, Pantry Frames, margin notes, cooked-for)

The rest of the loop's decisions, as pure functions:
- turning a plan request into checked plan items;
- picking dishes when the player says "pick 3";
- the plan's food-group flags;
- the Form 12-M list (plan ingredients minus the pantry, grouped by stall);
- which bought item to rescue;
- filling a Pantry Frame from the cupboard;
- applying a margin note to a recipe;
- reading "who ate with you".

Every path that names food for the player to cook ends in `check()` (spec §2.2, §4.4).

**Files:**
- Create:
  - `packages/core/src/week/plan.ts`: `PlanItem`, `resolvePlanRequest`, `suggestPlan`, `checkPlan`, `planFlags`, `FoodGroups`;
  - `packages/core/src/week/market-list.ts`: `marketList`, `stallFor`, `StallMap`, `MarketRunView` (C40);
  - `packages/core/src/week/use-it-up.ts`: `rescueCandidate`, `KeepsMap`;
  - `packages/core/src/week/frames.ts`;
  - `packages/core/src/book/margin-notes.ts`;
  - `packages/core/src/book/cooked-for.ts`;
  - `packages/core/src/week/index.ts` and `packages/core/src/book/index.ts`.
- Modify:
  - `packages/core/src/mentor/cards.ts`: `PantryItem` gains `addedOn?: string` and `source?: 'told' | 'market'`. A missing `source` means told (C9): `buildPantryCard` and the M4 pantry rows are left as they are, set neither field, and so are never rescued (Ruling 12). Only the market tick (Step 6, Step 10) writes `source: 'market'` with `addedOn`;
  - `packages/core/src/index.ts` and `engine.ts`.
- Test: `plan.test.ts`, `market-list.test.ts`, `use-it-up.test.ts`, `frames.test.ts`, `margin-notes.test.ts`, `cooked-for.test.ts`, and a property test `week/never-safe.test.ts`.

**Interfaces:**
- Consumes: `check`, `CheckResult`, `ParsedRecipe`, `Rule`, `IngredientGraph`, `Substitution` (M1); `matchDish`, `weekdayNumbers`, `pantryMatcher`, `normalizeTurn`, `playerOwnWords`, `PantryItem` (M4 core mentor); `planWeekStart` (Step 1).
- Produces:
```ts
// week/plan.ts
export type PlanItem =
  | { day: number /* 0–6, offset from weekStart */; kind: 'dish'; slug: string; servings: number }
  | { day: number; kind: 'lesson'; slug: string };                      // One More Technique's drill day (Step 2)
export interface Plan { weekStart: string; items: PlanItem[]; hard: boolean; slot: 'unanswered' | 'offered' | 'accepted' | 'declined' }
export interface PlanRequest { days: { weekday: string; dish: string }[] | null; pick: number | null; hard: boolean | null; after?: string | null }
export function resolvePlanRequest(req: PlanRequest, ctx: PlanContext):
  { items: PlanItem[]; unknown: string[]; dropped: { slug: string; status: 'blocked' }[] };
  // names → slugs via M4's matchDish, unchanged (never guessed, no aliases: "dal" alone → `unknown`, C1); weekday names → day
  // offsets from weekStart; "after Saturday" → days strictly after; pick → suggestPlan; blocked dishes are dropped and reported,
  // never placed. `unknown` holds each unmatched dish string in the player's words, trimmed, with one leading "the", "a" or "an"
  // dropped and nothing else changed ("the dal" → "dal", "your eggs" → "your eggs"); Step 8 uses the same strings (C19)
export function suggestPlan(n: number, ctx: PlanContext, avoidDays?: number[]): PlanItem[];
  // ≤ n; only dishes whose check is ok or swap (never ❓ or ⛔, C18); variety by cook; deterministic
export interface PlanContext { weekStart: string; recipes: ReadonlyMap<string, ParsedRecipe>; rules: Rule[]; graph: IngredientGraph;
  subs: Substitution[]; existing: readonly PlanItem[]; foodGroups: FoodGroups }
export type PlanItemCheck = { item: PlanItem; status: CheckResult['status']; findings: CheckResult['findings'] };
export function checkPlan(plan: Plan, ctx: PlanContext): PlanItemCheck[];    // each item checked on its own date (weekStart + day)
export type FoodGroup = 'veg_fruit' | 'protein' | 'grain';
export type FoodGroups = Readonly<Record<string, FoodGroup>>;              // data/food-groups.json: ingredient or category id → group
export type PlanFlag = 'gap_green' | 'gap_protein' | 'balanced' | null;
export function planFlags(plan: Plan, ctx: PlanContext): PlanFlag;           // `balanced` only when every group is present; unknown ids count for nothing
export function validatePlan(plan: unknown, ctx: PlanContext): string[];     // day 0–6, ≤ MAX_PLAN_ITEMS, known slug, servings 0.5–10, no sacred
export const MAX_PLAN_ITEMS = 21;
// week/market-list.ts
export interface ListItem { key: string; name: string; ingredientId: string | null; stall: StallId; forDishes: string[]; ticked: boolean }
export type StallId = 'wen' | 'bram' | 'okafor-sato' | 'spice' | 'general';   // the content/market ids + 'general' (C11); no 'dairy'
export type StallMap = Readonly<Record<string, StallId>>;                     // data/stalls.json: ingredient or category id → stall
export interface MarketRunView { id: string; weekStart: string; items: ListItem[]; doneAt: string | null }
  // C40: the one shape for a market run, used by the API (Step 6) and the device (Step 10 local-week.ts)
export function marketList(plan: Plan, ctx: PlanContext, pantry: readonly PantryItem[], stallOf: StallMap): ListItem[];
  // dish items only; scales by servings is NOT done (names only, M6 adds amounts); pantry match via pantryMatcher;
  // an ingredient whose rule finding has a swap lists the swap (labelled "for {dish}, swapped"), never the blocked one
export function stallFor(ingredientId: string | null, graph: IngredientGraph, stallOf: StallMap): StallId;  // is_a ancestry, else 'general'
// week/use-it-up.ts
export type KeepsMap = Readonly<Record<string, number>>;                    // data/keeps.json: ingredient id → days it keeps
export function rescueCandidate(pantry: readonly (PantryItem & { id: string })[], plan: Plan | null, today: string,
  keeps: KeepsMap, nudgedToday: boolean): { item: PantryItem & { id: string }; daysLeft: number } | null;
  // only source 'market' with addedOn and a keeps entry; not used by a planned dish still to come; daysLeft ≤ 2; at most one; null when nudgedToday
// week/frames.ts
export interface Frame { id: string; title: string; technique: string; status: 'draft' | 'reviewed'; credit: string;
  slots: { key: string; accepts: string[] /* ingredient ids */; optional: boolean }[]; steps: string[] /* with {slot} */;
  rescues: string[] /* ingredient ids it can rescue */ }
export interface FilledFrame { frame: string; fills: Record<string, { name: string; ingredientId: string | null } | null>;
  recipe: ParsedRecipe; check: CheckResult; emptyRequired: string[] }
export function fillFrame(frame: Frame, pantry: readonly PantryItem[], ctx: { rules: Rule[]; graph: IngredientGraph; subs: Substitution[]; today: string },
  pick?: Record<string, string>): FilledFrame;
  // each candidate is checked alone; blocked candidates are never chosen; an unresolved pantry name is never auto-picked (❓) — the
  // player may pick it, and then the frame's status is ❓; a required slot with no passing candidate → emptyRequired, never filled by guess
export function validateFrames(frames: Frame[], graph: IngredientGraph, techniques: ReadonlySet<string>): string[];
// book/margin-notes.ts — a structured diff over the canon ingredients; the canon text is never altered (audit M-5)
export type NoteOp = { op: 'add'; name: string } | { op: 'swap'; from: string; to: string } | { op: 'remove'; name: string };
export interface MarginNote { recipe: string; ops: NoteOp[]; text: string | null /* ≤ NOTE_TEXT_MAX */; at: string }
export function parseMarginNote(text: string, recipe: ParsedRecipe, graph: IngredientGraph): { ops: NoteOp[]; rest: string | null };
  // "added lime, used chickpeas instead of lentils, less salt" → add lime, swap lentils→chickpeas, rest "less salt"
export function applyNotes(recipe: ParsedRecipe, notes: readonly MarginNote[]): ParsedRecipe;   // a copy; `remove` of a missing name is a no-op
export function checkWithNotes(recipe: ParsedRecipe, notes: readonly MarginNote[], rules: Rule[], graph: IngredientGraph, subs: Substitution[], date: string): CheckResult;
export function validateNote(n: unknown, recipes: ReadonlyMap<string, ParsedRecipe>): string[]; // sacred → problem; ≤ 12 ops; names 1–80
export const NOTE_TEXT_MAX = 280; export const MAX_NOTES_PER_RECIPE = 20;
// book/cooked-for.ts — Ruling 10: fixed sets only, never a name
export const COOKED_FOR_COUNTS = ['just_me', 'one', 'two_to_three', 'four_plus'] as const;
export const COOKED_FOR_WHO = ['partner', 'family', 'flatmate', 'friends', 'neighbours', 'colleagues', 'guests'] as const;
export type CookedForCount = (typeof COOKED_FOR_COUNTS)[number]; export type CookedForWho = (typeof COOKED_FOR_WHO)[number];
export interface CookedFor { count: CookedForCount; who: CookedForWho | null }
export interface SharedEntry { cookedOn: string; recipe: string | null; frame: string | null; cookedFor: CookedFor }   // a Shared Table row (Step 7)
export interface SharedTally { shared: number; byRecipe: Record<string, number> }   // counts only, never a list of people (C21)
export function parseCookedFor(text: string): CookedFor | null;   // "just me" → just_me; "my flatmate Sam" → one + flatmate (Sam dropped);
                                                                 // "mum, dad and my sister" → two_to_three + family; unreadable → null
export function shareTally(entries: readonly SharedEntry[]): SharedTally;
  // meals shared (count ≠ just_me) in total and per recipe slug; frame entries count in `shared` only; never people ranked
```
- `parseCookedFor` counts:
  - It counts the people mentioned besides the player ("mum, dad and my sister" → `two_to_three`, `family`).
  - A bare number wins ("fed 6 of us" → `four_plus`).
  - Anything it can't read is `null`, and the UI offers the fixed chips.
  - **No proper noun, word outside the fixed sets, or health word is ever returned or stored.** A test feeds names and "my son's nut allergy" and asserts that the output holds only enum values.
- `planFlags` uses a curated `data/food-groups.json` (`{ ingredientId: 'veg_fruit' | 'protein' | 'grain' }`, Step 4) through `is_a` ancestry. It never claims `balanced` from unknown ids.
- `marketList` never lists a blocked ingredient as something to buy. A ⛔ dish has no list entries. It shows in the plan with `plan.blocked_dish` (Step 10).

- [ ] **3.1 Write the failing tests:**
```ts
test('T07 shape: "parippu Sunday, onigiri Monday, eggs Wednesday" → two items, Sunday parippu and Monday onigiri, on the right day offsets; unknown ["eggs"]', ...);
test('no alias: "dal Sunday" → no item, unknown ["dal"]; "frijoles" alone → unknown; "frijoles de olla" → frijoles-de-olla (C1)', ...);
test('T08 shape: pick 3, after Saturday, market day Saturday → three items on days after the market day', ...);
test('a blocked dish named by the player is dropped and reported, never placed', ...);
test('suggestPlan: rules block 2 of 3 dishes → returns 1, never pads with ⛔ or ❓; a ❓ dish is never picked', ...);
test('checkPlan checks each item on its own date (a phased rule active from Thursday blocks only Thursday)', ...);
test('planFlags: unknown ids never yield balanced; no veg_fruit → gap_green', ...);
test('marketList: pantry "Onion" removes onion; a swap ingredient is listed as the swap; ⛔ dish adds nothing; grouped by stall', ...);
test('rescueCandidate: market spinach 3 days old, keeps 4 → candidate; told spinach → none; unknown keeps → none; nudgedToday → none', ...);
test('rescueCandidate ignores an item a planned dish later this week will use', ...);
test('fillFrame: never picks a blocked candidate; unresolved pantry name not auto-picked; picked → frame ❓; empty required slot reported', ...);
test('parseMarginNote + checkWithNotes: "used peanut butter" on a peanut-rule player → ⛔ with the finding', ...);
test('applyNotes never mutates the canon recipe; validateNote rejects sacred recipes', ...);
test('parseCookedFor never returns a name or a health word (names, "nut allergy", emoji, 500 chars)', ...);
test('shareTally: just_me ignored; byRecipe counts per slug; frame entries add to shared only', ...);
// week/never-safe.test.ts (fast-check)
test('property: any plan/frame/notes containing an ingredient under an avoid rule is never ok', ...);
```
- [ ] **3.2 Run** `npm test -w @kitchenquest/core -- week book` → FAIL.
- [ ] **3.3 Implement.** Reuse `matchDish`, `weekdayNumbers` and `pantryMatcher` unchanged, and do not write a second matcher or an alias table (C1). The `PantryItem` change is additive: M4 rows without the fields still parse and count as told (test with a stored M4 shape).
- [ ] **3.4 Run** `npm test -w @kitchenquest/core` and `npm test -w @kitchenquest/game` → PASS.
- [ ] **3.5 Commit** `feat(core): plan, market list, pantry dates, rescue, frames, margin notes, cooked-for — all through check()`
