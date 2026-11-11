// Quest content types (spec §3.3, §8). Moved from apps/game/src/content/types.ts (C33) so the game's runner and the
// API's event validation read one shape. The five M3 step types are unchanged; `travel` and `recognize` are new.

export interface RiddleOption {
  text: string;
  correct: boolean;
  reaction: string;
}

export type QuestStep =
  | { type: 'talk'; lines: string[] }
  /** Spec §3.3 step list: satisfied by arriving at `place` (`#/visit`). */
  | { type: 'travel'; place: string; lines: string[] }
  | { type: 'riddle'; prompt: string; options: RiddleOption[]; explain: string }
  /** `skill` is a technique id: finishing the drill is a `drill` event for it (→ Seen). */
  | { type: 'drill'; skill: string; prompt: string; lines: string[] }
  /**
   * `item` is an ingredient id. `lines` are the sending lines, the last one the return line. `adapted` (optional,
   * new in M5) is what the cook says instead when the player's rules block the item (content README errand rule).
   */
  | { type: 'errand'; stall: string; item: string; lines: string[]; adapted?: string[] }
  /** Audit M-3: `lines` when the player already has `technique` at Tried from another cook's dish, else `otherwise`. */
  | { type: 'recognize'; technique: string; lines: string[]; otherwise: string[] }
  | { type: 'cook'; recipe: string };

export type QuestStepType = QuestStep['type'];

export interface Quest {
  id: string;
  cook: string;
  title: string;
  /** `requires` is enforced (C4, Ruling 3); `trust` is advisory and gates nothing. */
  unlock: { requires: string[]; trust: number };
  steps: QuestStep[];
  /** Ruling 4: `skills` keys are techniques practised; their numbers are ignored. */
  rewards: { xp: number; trust: number; skills: Record<string, number> };
}
