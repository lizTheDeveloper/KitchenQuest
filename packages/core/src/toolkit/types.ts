// Toolkit types live here so progress/ can import them without a cycle (toolkit.ts reads progress/ types).
export type Tier = 'seen' | 'tried' | 'yours';
export type Freshness = 'sharp' | 'warm' | 'rusty';
export interface FreshnessThresholds {
  warmAfterDays: number;
  rustyAfterDays: number;
}
export type TechniqueEvent =
  | { kind: 'lesson'; technique: string; at: string } // at: YYYY-MM-DD
  | { kind: 'cooked'; technique: string; at: string; recipe: string } // recipe: canon slug
  /** A cross-cook recognition (audit M-3): moves Tried to Yours. The caller decides it qualifies. */
  | { kind: 'recognized'; technique: string; at: string }
  /** An M3 device record, merged upward (Ruling 8). */
  | { kind: 'imported'; technique: string; at: string; tier: Tier; firstAt: string; lastUsedAt: string; recipes: string[] };
export interface TechniqueRecord {
  tier: Tier;
  firstAt: string;
  lastUsedAt: string;
  recipes: string[];
}
export interface ToolkitState {
  techniques: Record<string, TechniqueRecord>;
}
export interface ToolkitRow {
  technique: string;
  tier: Tier;
  /** null for 'seen': a technique only read about has nothing to fade. */
  freshness: Freshness | null;
}
