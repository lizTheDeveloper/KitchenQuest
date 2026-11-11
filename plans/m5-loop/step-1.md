# Step 1 — Core: progress events, rewards, levels, trust and toolkit growth

Everything the loop pays out is decided here by pure, tested functions, so the API (Step 5) and the device (Step 9) grant exactly the same thing. The model is event-sourced (Ruling 7). A `ProgressEvent` says what happened, with ids and a local date and no content. `grantsFor` turns one event, plus what has already been granted, into `RewardGrant`s using `data/rewards.yaml`. Derived state (XP, level, stamps, trust per cook, toolkit) is a fold over events and grants. Nothing here can produce a negative grant, and nothing reads consecutive days.

**Files:**
- Create:
  - `packages/core/src/progress/types.ts`
  - `packages/core/src/progress/rewards.ts`: `RewardsData`, `StampId`, `validateRewards`, `grantsFor`;
  - `packages/core/src/progress/derive.ts`: `deriveProgress`, `levelFor`, `trustLevel`, `compactHistory`;
  - `packages/core/src/progress/week.ts`: `isoWeek`, `planWeekStart`;
  - `packages/core/src/progress/index.ts`;
  - `packages/core/src/toolkit/techniques.ts`: `TechniqueNode`, `validateTechniques` (C17, C33);
  - `data/rewards.yaml`.
- Modify:
  - `packages/core/src/toolkit/toolkit.ts`: a `recognized` event kind; `refreshDue`; `imported` events from M3 records;
  - `data/techniques.yaml`: `adjacent` and `prereqs` on each technique;
  - `packages/core/src/index.ts` and `packages/core/src/engine.ts`: export `./progress`.
- Test: `packages/core/src/progress/rewards.test.ts`, `derive.test.ts`, `week.test.ts`, `never-rules.test.ts` (property tests), `packages/core/src/toolkit/techniques.test.ts`, and an extended `packages/core/src/toolkit/toolkit.test.ts`.

**Interfaces:**
- Consumes: `recordTechnique`, `freshness`, `ToolkitState`, `FreshnessThresholds`, `isValidDate` (M3 core); `ParsedRecipe.meta.{cook, skills, sacred}` (M1).
- Produces:
```ts
// progress/types.ts — every id is content (canon slug, quest id, technique id, cook id); no free text, no amounts
export type ProgressEvent =
  | { id: string; kind: 'lesson'; at: string; recipe: string }                       // recipe read-through (Ruling 20)
  | { id: string; kind: 'drill'; at: string; quest: string; step: number; technique: string }
  | { id: string; kind: 'cooked'; at: string; recipe: string; planned: boolean }       // cook mode finished
  | { id: string; kind: 'frame_cooked'; at: string; frame: string; technique: string }
  | { id: string; kind: 'quest_step'; at: string; quest: string; step: number }
  | { id: string; kind: 'quest_done'; at: string; quest: string }
  | { id: string; kind: 'recognized'; at: string; quest: string; technique: string }
  | { id: string; kind: 'market_run'; at: string; weekStart: string }
  | { id: string; kind: 'meal_logged'; at: string; minute: number }                    // minute of the local day; no meal content
  | { id: string; kind: 'imported'; at: string; technique: string; tier: Tier; firstAt: string; lastUsedAt: string; recipes: string[] }; // M3 device toolkit (Ruling 8)
// There is deliberately no kind for rules, consents, profile edits, reminders or pantry changes (§6, never rule 8).
export type RewardGrant =
  | { kind: 'xp'; amount: number; reason: XpReason; eventId: string }
  | { kind: 'stamp'; stamp: StampId; eventId: string }
  | { kind: 'trust'; cook: string; level: number; eventId: string }   // the level reached; only ever one higher than before
  | { kind: 'level'; level: number; eventId: string }
  | { kind: 'certificate'; technique: string; eventId: string };      // "Yours" (audit M-1)
export type XpReason = 'lesson' | 'drill' | 'cook' | 'frame' | 'quest' | 'market_run' | 'nourishment' | 'refresh';
export interface Catalogue {   // what grantsFor needs to validate and price an event, built from content + recipes
  recipes: ReadonlyMap<string, { cook: string; skills: readonly string[]; sacred: boolean }>;
  quests: ReadonlyMap<string, { cook: string; steps: number; xp: number; trust: number; skills: readonly string[];
    requires: readonly string[] }>;   // unlock.requires, enforced (C4); unlock.trust is advisory and not carried here
  techniques: ReadonlySet<string>;
  frames: ReadonlyMap<string, { technique: string }>;
}
// progress/rewards.ts
export interface RewardsData {   // data/rewards.yaml, validated
  xp: { lesson: number; drill: number; cook: number; frame: number; market_run: number; refresh: number;
        nourishment: { per_log: number; max_per_day: number; min_gap_minutes: number } };
  levels: number[];                          // cumulative XP for level 2, 3, …; strictly increasing
  stamps: { quest_done: number; certificate: number; market_run: number };
  trust: { names: string[]; weeks_for_level: number[] }; // names[0] = Stranger, names[1] = Guest; weeks_for_level[i] = cook-weeks for level i+2
}
export type StampId = keyof RewardsData['stamps'];   // 'quest_done' | 'certificate' | 'market_run'; each has a stamp_names entry (Step 4, C13)
export const MAX_PROGRESS_EVENTS_PER_DAY = 200;      // per local date (`at`); core enforces it so the device and the API agree (C14)
export function validateRewards(d: unknown): string[];   // rewards.yaml only; techniques.yaml is validateTechniques' (C17)
export function grantsFor(event: ProgressEvent, history: ProgressHistory, cat: Catalogue, data: RewardsData,
  thresholds: FreshnessThresholds): { grants: RewardGrant[]; problems: string[] };   // problems non-empty → reject the event, grant nothing
export interface ProgressHistory { events: readonly ProgressEvent[]; grants: readonly RewardGrant[];
  base: ProgressSnapshot | null }   // null except on a compacted device log (C15)
// progress/derive.ts
export interface ProgressView { xp: number; level: number; stamps: number; trust: Record<string, number>;
  toolkit: ToolkitState; questsDone: string[]; questSteps: Record<string, number>; cookedOn: Record<string, string[]>;
  framesCookedOn: Record<string, string[]> }   // frame id → local dates of `frame_cooked` (the book's frames section, Step 11)
export function deriveProgress(h: ProgressHistory, cat: Catalogue): ProgressView;   // level = max(level grants, 1); trust = max per cook
export function levelFor(xp: number, levels: readonly number[]): number;
export function trustLevel(cookWeeks: number, questDone: boolean, data: RewardsData): number;
// C15: the device log's compaction. Folds the oldest events (and their grants) into `base`, keeping the newest `keep` events.
// `ProgressSnapshot` holds the ProgressView at the fold plus every fact grantsFor reads from history (once-ever and
// once-per-period keys, cook-weeks per cook, nourishment grants per date, the event ids and per-date counts it has seen).
export interface ProgressSnapshot { view: ProgressView; facts: unknown /* opaque to callers; core-owned, JSON-safe */ }
export function compactHistory(h: ProgressHistory, keep: number, cat: Catalogue): ProgressHistory;
  // invariant: deriveProgress and the grants of any next event are identical before and after compaction
// progress/week.ts
export function isoWeek(date: string): string;                            // 'YYYY-Www'; for trust (Ruling 2)
export function planWeekStart(date: string, marketDays: readonly number[]): string;  // Ruling 11; Monday when none
// toolkit/techniques.ts — data/techniques.yaml's entries (C33: the game's TechniqueData.techniques becomes TechniqueNode[], Step 4)
export interface TechniqueNode { id: string; name: string; adjacent: string[]; prereqs: string[] }
export function validateTechniques(nodes: unknown): string[];   // every adjacent/prereqs id exists; no self-reference; no prereqs cycle
// toolkit.ts additions
export type TechniqueEvent = /* M3 kinds */ | { kind: 'recognized'; technique: string; at: string } | { kind: 'imported'; /* as above */ };
export function refreshDue(state: ToolkitState, technique: string, at: string, t: FreshnessThresholds): boolean; // was rusty before `at`
export function toolkitFromEvents(events: readonly ProgressEvent[], cat: Catalogue): ToolkitState;
```
- Grant rules:
  - **lesson / drill:** a technique becomes Seen. XP once per (recipe or quest step) per ISO week of the event's local date (`isoWeek(at)`, C16), so a re-read is free to do but earns nothing new. `grantsFor` takes no market days.
  - **cooked:** Tried, or Yours on a second distinct recipe (M3 rule). Cook XP once per recipe per day. A `certificate` grant and a stamp the first time a technique reaches Yours.
    - Refresh XP when a technique used by the recipe was Rusty before this event (`refreshDue`), once per technique per refresh.
    - Trust: when this event adds a new ISO week to the cook's cook-weeks and `trustLevel` rises, exactly one `trust` grant.
    - **Sacred recipe → no grants at all** (§10). The event is still recorded and kept in `deriveProgress().cookedOn`, but no book page is ever built for a sacred dish (Step 11, C39).
  - **frame_cooked:** Tried or Yours on the frame's technique, and frame XP. The date goes into `framesCookedOn`.
  - **quest_step / quest_done:** a step must be the next step of a known quest (`questSteps[quest] + 1`), and every quest in its `requires` must be done (C4: a step of a waiting quest is a problem). `quest_done` needs every step done. It grants the quest's `xp`, a stamp and trust level 1 if the player was a Stranger. It is granted once per quest, ever. Each `rewards.skills` key becomes Seen through the fold: `toolkitFromEvents` reads a `quest_done` as Seen for each key of that quest's `skills` (Ruling 4). That is part of the fold, not an extra event and not a grant.
  - **recognized:** moves a Tried technique to Yours (audit M-3), only when the player has it at Tried from a recipe of a *different* cook. Otherwise it is recorded with no grant.
  - **market_run:** XP and a stamp once per ISO week of the event's local date (`isoWeek(at)`, C16). `weekStart` is kept on the event as the record of which plan week it closed.
  - **meal_logged:** nourishment XP per Ruling 5, counted on existing `nourishment` grants for that `at` (Ruling 6). It carries no meal content.
  - **imported:** rebuilds the M3 toolkit record and grants nothing.
  - **level:** after the XP grants, if `levelFor(total)` exceeds the highest `level` grant, one `level` grant per level crossed.
  - **Validation problems** (reject the event): an unknown recipe, quest, step, technique or frame; a bad date; a quest step out of order; a step of a quest whose `requires` are not all done; a duplicate `id`; and `too_many_events` when history already holds `MAX_PROGRESS_EVENTS_PER_DAY` events with the same `at` (per event, never the whole batch, C14). The date window is the caller's (Step 5); `grantsFor` only checks that `at` is a valid date.
- `data/rewards.yaml` (first values; tunable, never lowering what was granted): `xp: { lesson: 10, drill: 10, cook: 30, frame: 20, market_run: 20, refresh: 15, nourishment: { per_log: 5, max_per_day: 3, min_gap_minutes: 120 } }`, `levels: [100, 250, 450, 700, 1000, 1400, 1900, 2500]`, `stamps: { quest_done: 1, certificate: 1, market_run: 1 }`, `trust: { names: [Stranger, Guest, Acquainted, Trusted apprentice, Family friend, Keeper of the dish], weeks_for_level: [2, 4, 7, 10] }`. `validateRewards` requires `trust.names.length === trust.weeks_for_level.length + 2` (Stranger and Guest, then one name per threshold), never a fixed count (C17).
- `data/techniques.yaml`: add `adjacent: [ids]` and `prereqs: [ids]` to each of the seven techniques, plus the frame techniques Step 4 needs (`stir-fry`, `emulsion`, `quick-sauce`). `adjacent` on technique H lists the techniques to suggest after H (it need not be symmetric): `weeklySlot` (Step 2) offers T when T is in the `adjacent` of a technique the player has at Tried or Yours. The build (Step 4) and the API boot (Step 5) run `validateTechniques` over the file. First values (tunable data):

  | id | adjacent | prereqs |
  |---|---|---|
  | `legumes` | `tempering` | — |
  | `heat-control` | `tempering`, `stir-fry`, `quick-sauce` | — |
  | `tempering` | `quick-sauce` | `heat-control` |
  | `grains` | `shaping`, `stir-fry` | — |
  | `shaping` | `knife` | `grains` |
  | `patience` | `emulsion` | — |
  | `knife` | `emulsion` | — |
  | `stir-fry` | — | `heat-control`, `grains` |
  | `emulsion` | — | `knife` |
  | `quick-sauce` | — | `heat-control` |

  With these, a player who has cooked only frijoles de olla (legumes, heat-control, patience at Tried) is offered `tempering` by parippu (Step 12's e2e relies on this).

- [ ] **1.1 Write the failing tests:**
```ts
test('a cooked event grants cook XP, Tried, and the level crossing; a second distinct recipe gives Yours + certificate + stamp', ...);
test('cook XP once per recipe per day; a re-cook next day earns again', ...);
test('nourishment: 3 logs ≥ 2 h apart earn 5 each; a 4th earns 0; a log 1 h after the last earns 0', ...);
test('nourishment counts grants, not events: a deleted/undone meal never re-opens the cap (Ruling 6)', ...);   // history keeps the grant
test('trust: quest_done → 1; cook-weeks 2/4/7/10 → 2..5; two cooks the same week → one rise; a 6-week gap loses nothing', ...);
test('trust rises at most one level per event and never to a level the data has no name for', ...);
test('refresh XP only when the technique was Rusty before the event, once per refresh', ...);
test('recognized: Tried from another cook → Yours; same cook or Seen only → recorded, no grant', ...);
test('sacred recipe: zero grants, event still in deriveProgress().cookedOn', ...);
test('compactHistory: derived view and the grants of a next event are identical before and after; nothing lowers (C15)', ...);
test('quest_step out of order, unknown quest, unknown recipe, bad date, duplicate id → problems, no grants', ...);
test('a quest_step of a quest whose unlock.requires is not done → problems, no grants (C4)', ...);
test('the 201st event with one local date → problem too_many_events for that event only; other dates still accepted (C14)', ...);
test('lesson/drill XP once per ISO week of the event date; market_run XP and stamp once per ISO week (C16)', ...);
test('quest_done makes each rewards.skills key Seen in toolkitFromEvents, with no extra event or grant (Ruling 4)', ...);
test('imported events rebuild an M3 toolkit exactly and grant nothing', ...);
test('planWeekStart: market day Sat → the Saturday on or before; none → Monday; isoWeek across a year boundary', ...);
// never-rules.test.ts (fast-check)
test('property: no grant is ever negative or lowers a derived value; deriveProgress over a prefix ≤ over the whole; compaction lowers nothing', ...);
test('property: shuffling the calendar gaps between the same events never changes total XP (no streak term)', ...);
test('property: grants are independent of anything but events, catalogue and data (grantsFor has no entitlement input)', ...);   // type-level + grep
test('raising a level threshold in data after the fact keeps every level already granted', ...);
test('validateRewards: non-increasing levels, a negative amount, trust names ≠ weeks_for_level + 2 → problems', ...);
// toolkit/techniques.test.ts
test('validateTechniques: unknown id in adjacent or prereqs, a self-reference, a prereqs cycle → problems; the shipped file → none', ...);
```
- [ ] **1.2 Run** `npm test -w @kitchenquest/core -- progress toolkit techniques` → FAIL.
- [ ] **1.3 Implement.** `grantsFor` is total and pure, and never throws on player-shaped input (it returns problems instead). `refreshDue` uses the toolkit as it stood before the event. Export everything from `index.ts` and `engine.ts` (no WASM import in `progress/`).
- [ ] **1.4 Run** `npm test -w @kitchenquest/core` and `npm test -w @kitchenquest/game` (the game build compiles `data/`) → PASS.
- [ ] **1.5 Commit** `feat(core): event-sourced progress, rewards, trust and toolkit growth; nothing earned goes down`
