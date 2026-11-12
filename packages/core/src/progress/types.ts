import type { StallFile, StallQuestion } from '../market/types';
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
  /**
   * Cook mode finished. `standsInFor` (I3 ruling) names cooks whose every dish is ⛔ for the player on `at` and to
   * one of which this dish is an alternative (core `standInCooks`): the cook then counts toward their trust weeks
   * too. grantsFor accepts it only with the player's rules (its `rules` argument) and only when it holds.
   */
  | { id: string; kind: 'cooked'; at: string; recipe: string; planned: boolean; standsInFor?: string[] }
  | { id: string; kind: 'frame_cooked'; at: string; frame: string; technique: string; standsInFor?: string[] }
  /** `step` is 1-based: the first step of a quest is 1. */
  | { id: string; kind: 'quest_step'; at: string; quest: string; step: number }
  | { id: string; kind: 'quest_done'; at: string; quest: string }
  | { id: string; kind: 'recognized'; at: string; quest: string; technique: string }
  /** `weekStart` records which plan week the run closed; grants use `isoWeek(at)` (C16). */
  | { id: string; kind: 'market_run'; at: string; weekStart: string }
  /**
   * `minute` is the wall-clock minute of the local day (0–1439). There is no meal content. Across a DST change two
   * logs an hour apart can read as the same minute (the second earns nothing) or 70 real minutes as 130: harmless,
   * never a penalty (M5).
   */
  | {
      id: string;
      kind: 'meal_logged';
      at: string;
      minute: number;
      /**
       * The account's meal-log row this event is for (content-free: a random id). Meal logs are account-only, so the
       * API requires it and checks it is the player's own log eaten on `at`; undoing that log erases the event
       * (I1 ruling). Never copied into a grant.
       */
      mealLogId?: string;
    }
  /**
   * A finished stall round (M6 Rulings 1 and 2). `answers` are the question ids answered and each pick's FILE index
   * (`scoreAnswer`'s `pick`), in answer order. There is no "correct" flag: core scores each pick from the stall file.
   * Only what was answered is here, never which questions the round showed (M2 privacy carry): a question the rules
   * dropped leaves no trace. A Protein Counter round is health-revealing (`isHealthRevealing`, Ruling 17).
   */
  | { id: string; kind: 'stall_round'; at: string; stall: string; answers: { q: string; pick: number }[] }
  /** An M3 device toolkit record (Ruling 8). Grants nothing. */
  | { id: string; kind: 'imported'; at: string; technique: string; tier: Tier; firstAt: string; lastUsedAt: string; recipes: string[] };

export type ProgressEventKind = ProgressEvent['kind'];

export type XpReason = 'lesson' | 'drill' | 'cook' | 'frame' | 'quest' | 'market_run' | 'nourishment' | 'refresh' | 'market_game';

/** The stamp kinds; each has a `stamps` amount in data/rewards.yaml and a `stamp_names` entry (Step 4, C13). */
export type StampId = 'quest_done' | 'certificate' | 'market_run' | 'market_game';

/**
 * What an event earned, fixed when granted. Never negative, never reversed (spec §6).
 *
 * Self-contained (I2 ruling): `id` is the grant's own id, `eventId` the event it was granted for, and `isoDay` that
 * event's local date (YYYY-MM-DD). A grant holds no event content (no recipe, quest, minute or week start), so it can
 * outlive its event: erasing an event (a meal-log undo, a `health_data` delete) keeps the grant, and with it the XP,
 * the seen id and the day's nourishment count. Only account delete removes grants (both ledgers go).
 */
export type RewardGrant = { id: string; eventId: string; isoDay: string } & (
  | { kind: 'xp'; amount: number; reason: XpReason }
  | { kind: 'stamp'; stamp: StampId }
  /** The level reached; only ever one higher than before. */
  | { kind: 'trust'; cook: string; level: number }
  | { kind: 'level'; level: number }
  /** A technique reached "Yours" (audit M-1). */
  | { kind: 'certificate'; technique: string }
);

/** What `grantsFor` needs to validate and reward an event, built from content and recipes. */
export interface Catalogue {
  recipes: ReadonlyMap<string, { cook: string; skills: readonly string[]; sacred: boolean }>;
  /** `requires` is unlock.requires, enforced (C4). unlock.trust is advisory and not carried here. */
  quests: ReadonlyMap<
    string,
    { cook: string; steps: number; xp: number; trust: number; skills: readonly string[]; requires: readonly string[] }
  >;
  techniques: ReadonlySet<string>;
  frames: ReadonlyMap<string, { technique: string }>;
  /**
   * The market stalls (M6), by stall id: each question the stall file holds, with the bank it is in, and the file
   * itself (for `stallVariant` and `questionStatus` with the player's rules). Built with `marketCatalogue`. Optional
   * until the API (Step 6) and the device (Step 9) fill it: without it, every `stall_round` is `bad_event`.
   */
  market?: ReadonlyMap<string, MarketStall>;
}

/** One stall in `Catalogue.market`. `variant` is the bank the question is in ('seasonal': Wen's `seasonal` block). */
export interface MarketStall {
  questions: ReadonlyMap<string, { question: StallQuestion; variant: 'base' | 'protein_counter' | 'seasonal' }>;
  file: StallFile;
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
  /** quest id → local date of its first `quest_step` (a quest's `cook` step counts cooks from then on, Step 2). */
  questStartedOn: Record<string, string>;
  /** recipe slug → local dates it was cooked, sorted, without repeats. Sacred dishes are kept here too. */
  cookedOn: Record<string, string[]>;
  /** frame id → local dates of `frame_cooked` (the book's frames section, Step 11). */
  framesCookedOn: Record<string, string[]>;
  /**
   * Stall question id → whether it was ever answered correctly (scored from the stall file) and the local date it was
   * last answered: `nextRound`'s `AnsweredMap`. Only what was answered; never what a round showed.
   */
  marketAnswered: Record<string, { correct: boolean; lastAt: string }>;
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
    /** M6 Ruling 1: per stall question, the first time it is answered correctly, once ever. */
    market_game: number;
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
