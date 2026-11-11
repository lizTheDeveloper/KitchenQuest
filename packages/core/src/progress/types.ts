import type { Tier, ToolkitState } from '../toolkit/types';

/**
 * What happened, as content-free facts (Ruling 7). Every id is content (canon slug, quest id, technique id, frame id,
 * cook id) or a client event id; `at` is the player's local date (YYYY-MM-DD). No free text and no amounts: a client
 * never says what it earned. `grantsFor` decides that.
 *
 * There is deliberately no kind for rules, consents, profile edits, reminders or pantry changes (spec §6, never rule 8).
 */
export type ProgressEvent =
  /** A recipe read-through (Ruling 20). */
  | { id: string; kind: 'lesson'; at: string; recipe: string }
  | { id: string; kind: 'drill'; at: string; quest: string; step: number; technique: string }
  /** Cook mode finished. */
  | { id: string; kind: 'cooked'; at: string; recipe: string; planned: boolean }
  | { id: string; kind: 'frame_cooked'; at: string; frame: string; technique: string }
  /** `step` is 1-based: the first step of a quest is 1. */
  | { id: string; kind: 'quest_step'; at: string; quest: string; step: number }
  | { id: string; kind: 'quest_done'; at: string; quest: string }
  | { id: string; kind: 'recognized'; at: string; quest: string; technique: string }
  /** `weekStart` records which plan week the run closed; grants use `isoWeek(at)` (C16). */
  | { id: string; kind: 'market_run'; at: string; weekStart: string }
  /** `minute` is the minute of the local day (0–1439). There is no meal content. */
  | { id: string; kind: 'meal_logged'; at: string; minute: number }
  /** An M3 device toolkit record (Ruling 8). Grants nothing. */
  | { id: string; kind: 'imported'; at: string; technique: string; tier: Tier; firstAt: string; lastUsedAt: string; recipes: string[] };

export type ProgressEventKind = ProgressEvent['kind'];

export type XpReason = 'lesson' | 'drill' | 'cook' | 'frame' | 'quest' | 'market_run' | 'nourishment' | 'refresh';

/** The stamp kinds; each has a `stamps` amount in data/rewards.yaml and a `stamp_names` entry (Step 4, C13). */
export type StampId = 'quest_done' | 'certificate' | 'market_run';

/** What an event earned, fixed when granted. Never negative, never reversed (spec §6). */
export type RewardGrant =
  | { kind: 'xp'; amount: number; reason: XpReason; eventId: string }
  | { kind: 'stamp'; stamp: StampId; eventId: string }
  /** The level reached; only ever one higher than before. */
  | { kind: 'trust'; cook: string; level: number; eventId: string }
  | { kind: 'level'; level: number; eventId: string }
  /** A technique reached "Yours" (audit M-1). */
  | { kind: 'certificate'; technique: string; eventId: string };

/** What `grantsFor` needs to validate and price an event, built from content and recipes. */
export interface Catalogue {
  recipes: ReadonlyMap<string, { cook: string; skills: readonly string[]; sacred: boolean }>;
  /** `requires` is unlock.requires, enforced (C4). unlock.trust is advisory and not carried here. */
  quests: ReadonlyMap<
    string,
    { cook: string; steps: number; xp: number; trust: number; skills: readonly string[]; requires: readonly string[] }
  >;
  techniques: ReadonlySet<string>;
  frames: ReadonlyMap<string, { technique: string }>;
}

export interface ProgressView {
  xp: number;
  level: number;
  stamps: number;
  /** cook id → trust level (0 Stranger … 5 Keeper of the dish); a cook with no grant is absent. */
  trust: Record<string, number>;
  toolkit: ToolkitState;
  questsDone: string[];
  /** quest id → steps done (the highest step reached). */
  questSteps: Record<string, number>;
  /** recipe slug → local dates it was cooked, sorted, without repeats. Sacred dishes are kept here too. */
  cookedOn: Record<string, string[]>;
  /** frame id → local dates of `frame_cooked` (the book's frames section, Step 11). */
  framesCookedOn: Record<string, string[]>;
}

/**
 * A compacted device log's base (C15): the view at the fold, plus every fact `grantsFor` reads from history.
 * `facts` is core-owned and JSON-safe; callers store it and pass it back untouched.
 */
export interface ProgressSnapshot {
  view: ProgressView;
  facts: unknown;
}

export interface ProgressHistory {
  events: readonly ProgressEvent[];
  grants: readonly RewardGrant[];
  /** null except on a compacted device log (C15). */
  base: ProgressSnapshot | null;
}

/** data/rewards.yaml, validated by `validateRewards`. Tunable; a retune never lowers what was granted. */
export interface RewardsData {
  xp: {
    lesson: number;
    drill: number;
    cook: number;
    frame: number;
    market_run: number;
    refresh: number;
    /** Ruling 5: flat per qualifying log, blind to what or how much was eaten. */
    nourishment: { per_log: number; max_per_day: number; min_gap_minutes: number };
  };
  /** Cumulative XP for level 2, 3, …; strictly increasing. */
  levels: number[];
  /** How many stamps each occasion gives. */
  stamps: Record<StampId, number>;
  /** names[0] = Stranger, names[1] = Guest; weeks_for_level[i] = cook-weeks for level i + 2. */
  trust: { names: string[]; weeks_for_level: number[] };
}
