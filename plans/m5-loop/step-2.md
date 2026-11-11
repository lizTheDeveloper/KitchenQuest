# Step 2 — Core: the quest engine, lessons and the weekly technique slot

Quests are data (spec §3.3, §8). This step gives them an engine: a pure state machine over the quest file, shared by the game (Step 9) and the API's event validation (Step 5). It adds the `recognize` step (audit M-3, Same Hands Different Kitchen) and moves the quest types from the game into core. It also builds One More Technique (audit M-2): at most one suggestion a plan week, chosen from the `adjacent` graph and filtered by the rules engine. It shares one slot with the Rusty refresher (§17), is never offered in a hard week, and declining it costs nothing.

**Files:**
- Create:
  - `packages/core/src/quests/types.ts`: `Quest`, `QuestStep` (moved from `apps/game/src/content/types.ts`, plus `recognize`);
  - `packages/core/src/quests/engine.ts`;
  - `packages/core/src/quests/validate.ts`;
  - `packages/core/src/toolkit/one-more.ts`;
  - `packages/core/src/quests/index.ts`.
- Modify:
  - `apps/game/src/content/types.ts`: re-export the quest types from core; no local copies;
  - `packages/core/src/index.ts` and `engine.ts`.
- Test: `packages/core/src/quests/engine.test.ts`, `validate.test.ts`, `packages/core/src/toolkit/one-more.test.ts`.

**Interfaces:**
- Consumes: `ProgressView`, `ProgressEvent`, `Catalogue`, `planWeekStart` (Step 1); `check`, `Rule`, `IngredientGraph`, `Substitution`, `ParsedRecipe` (M1); `toolkitRows`, `freshness` (M3).
- Produces:
```ts
// quests/types.ts
export type QuestStep =
  | { type: 'talk'; lines: string[] }
  | { type: 'travel'; place: string; lines: string[] }               // new (spec §3.3 step list): satisfied by arriving (#/visit)
  | { type: 'riddle'; prompt: string; options: RiddleOption[]; explain: string }
  | { type: 'drill'; skill: string; prompt: string; lines: string[] }
  | { type: 'errand'; stall: string; item: string; lines: string[] }
  | { type: 'recognize'; technique: string; lines: string[]; otherwise: string[] }   // lines if known from another cook, else `otherwise`
  | { type: 'cook'; recipe: string };
export interface Quest { id: string; cook: string; title: string; unlock: { requires: string[]; trust: number };
  steps: QuestStep[]; rewards: { xp: number; trust: number; skills: Record<string, number> } }
// quests/engine.ts
export type QuestStatus = 'waiting' | 'open' | 'in_progress' | 'done';   // waiting = unlock not met (advisory display only, Ruling 3)
export function questStatus(q: Quest, p: ProgressView): QuestStatus;
export function currentStep(q: Quest, p: ProgressView): { index: number; step: QuestStep } | null;
export type StepInput =
  | { type: 'talk' | 'travel' } | { type: 'riddle'; option: number } | { type: 'drill' }
  | { type: 'errand'; have: 'pantry' | 'ticked' | 'tapped' }          // Ruling 16: pantry/list/"I've got it"; the stall minigame is M6
  | { type: 'recognize' } | { type: 'cook'; cookedEventId: string };
export function advance(q: Quest, p: ProgressView, input: StepInput, at: string, newId: () => string):
  | { ok: true; events: ProgressEvent[]; say: string[] }              // quest_step (+ drill / recognized / quest_done)
  | { ok: false; reason: 'not_current' | 'wrong_answer' | 'blocked' | 'already_done'; say: string[] };
// a wrong riddle option → ok:false 'wrong_answer' with that option's reaction; the player stays on the step, no penalty
// errand for an item the rules block → ok:false 'blocked' with the cook's adapted line (content README errand rule)
// cook step: satisfied only by a `cooked` event for that recipe dated on/after the quest started
export function recognizedFrom(technique: string, quest: Quest, p: ProgressView, cat: Catalogue): string | null; // the other cook id
// quests/validate.ts — used by the content build (Step 4) and the API catalogue (Step 5)
export function validateQuests(quests: Quest[], cat: Pick<Catalogue, 'recipes' | 'techniques'>, cooks: ReadonlySet<string>, stalls: ReadonlySet<string>, graph: IngredientGraph): string[];
// toolkit/one-more.ts
export interface TechniqueData { id: string; name: string; adjacent: string[]; prereqs: string[] }
export type SlotOffer =
  | { kind: 'new'; technique: string; from: string; recipe: string; status: 'ok' | 'swap' }       // never 'blocked' / 'unverified'
  | { kind: 'refresh'; technique: string; recipe: string; status: 'ok' | 'swap' };
export function weeklySlot(input: {
  toolkit: ToolkitState; techniques: readonly TechniqueData[]; recipes: ReadonlyMap<string, ParsedRecipe>;
  taught: ReadonlySet<string>;          // recipes the player may cook now (all canon, Ruling 3)
  planned: readonly string[];           // slugs already in this week's plan
  rules: Rule[]; graph: IngredientGraph; subs: Substitution[];
  weekStart: string; today: string; thresholds: FreshnessThresholds;
  week: { hard: boolean; slot: 'unanswered' | 'accepted' | 'declined' | 'offered' };
}): SlotOffer | null;
```
- `weeklySlot` rules:
  - It returns `null` when `week.hard`, when the slot was already answered or offered this week, or when nothing qualifies. It is never a list (`ONE_MORE_PER_WEEK = 1`).
  - **new:** a technique the player doesn't have, adjacent to one they have at Tried or Yours, with every `prereqs` id at Seen or better, and taught by a recipe whose `check` status on `weekStart` is `ok` or `swap`. ❓ and ⛔ recipes are skipped, so "can't verify" is never offered. A recipe already planned this week is preferred.
  - **refresh:** used only when no `new` offer exists. It picks a Rusty technique (`toolkitRows`), the oldest `lastUsedAt` first, with the same recipe filter.
  - The order is deterministic: technique id, then slug. There is no randomness, so the test and the server agree.
  - Sacred recipes are never offered.
- Accepting adds the drill or lesson for that recipe to a kitchen day before the cook day (the plan, Step 3). Declining records `declined` for the week and nothing else.
- `validateQuests` checks:
  - each step's references exist: recipe, technique, stall, ingredient in the graph;
  - riddles have exactly one correct option;
  - `requires` names known quests with no cycles;
  - `unlock.trust` is in 0–5;
  - a `recognize` step's technique is not taught by the quest's own cook's recipe, so recognition is always of something learned elsewhere.

- [ ] **2.1 Write the failing tests:**
```ts
test('leela-tempering runs talk → riddle → drill → errand → cook → done, emitting quest_step events in order', ...);
test('a wrong riddle option keeps the step and returns its reaction; never a penalty event', ...);
test('advance on a step that is not current → not_current, no events', ...);
test('errand satisfied by pantry, by a ticked list item, or by a tap; a rule-blocked item → blocked + adapted line', ...);
test('cook step needs a cooked event for that recipe on/after the quest started', ...);
test('recognize: Tried tempering from Leela, at Marisol → lines + recognized event; never met → otherwise lines, no event', ...);
test('questStatus waiting when unlock.trust not met — display only: advance still works (Ruling 3)', ...);
test('quest_done once: replaying the last step after done → already_done', ...);
test('validateQuests: two correct options, unknown recipe, requires cycle, recognize of own cook\'s technique → problems', ...);
test('weeklySlot: one new adjacent technique with an ok dish; prereq missing → none; hard week → null', ...);
test('weeklySlot never offers a ❓ or ⛔ dish: a player whose rules block the only tempering dish gets null', ...);
test('weeklySlot falls back to the oldest Rusty refresher only when no new offer exists; declined this week → null', ...);
test('weeklySlot is deterministic: same input → same offer', ...);
```
- [ ] **2.2 Run** `npm test -w @kitchenquest/core -- quests one-more` → FAIL.
- [ ] **2.3 Implement.** Move the quest types without changing their shape for the five existing step types, so the existing content still type-checks. `travel` and `recognize` are additions only.
- [ ] **2.4 Run** `npm test -w @kitchenquest/core` and `npm test -w @kitchenquest/game` → PASS.
- [ ] **2.5 Commit** `feat(core): quest engine with recognize and travel steps; one weekly technique slot, rules-checked`
