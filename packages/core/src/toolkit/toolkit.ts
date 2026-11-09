import { isValidDate } from '../rules/active';

export type Tier = 'seen' | 'tried' | 'yours';
export type Freshness = 'sharp' | 'warm' | 'rusty';
export interface FreshnessThresholds {
  warmAfterDays: number;
  rustyAfterDays: number;
}
export type TechniqueEvent =
  | { kind: 'lesson'; technique: string; at: string } // at: YYYY-MM-DD
  | { kind: 'cooked'; technique: string; at: string; recipe: string }; // recipe: canon slug
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

export const EMPTY_TOOLKIT: ToolkitState = Object.freeze({ techniques: Object.freeze({}) }) as ToolkitState;

const RANK: Record<Tier, number> = { seen: 0, tried: 1, yours: 2 };
const maxTier = (a: Tier, b: Tier): Tier => (RANK[a] >= RANK[b] ? a : b);

function requireDate(value: string, what: string): string {
  if (!isValidDate(value)) throw new Error(`${what} is not a valid YYYY-MM-DD date: ${String(value)}`);
  return value;
}

/**
 * Record one event. Pure: returns a new state and never mutates the input. Tiers only go up;
 * nothing here (or anywhere in this module) removes a technique or lowers a tier.
 */
export function recordTechnique(state: ToolkitState, event: TechniqueEvent): ToolkitState {
  const at = requireDate(event.at, 'event date');
  const old = state.techniques[event.technique];
  const recipes = old ? [...old.recipes] : [];
  if (event.kind === 'cooked' && !recipes.includes(event.recipe)) recipes.push(event.recipe);

  let computed: Tier = event.kind === 'cooked' ? 'tried' : 'seen';
  if (recipes.length >= 2) computed = 'yours';

  const record: TechniqueRecord = {
    tier: old ? maxTier(old.tier, computed) : computed,
    firstAt: old && old.firstAt < at ? old.firstAt : at,
    lastUsedAt: old && old.lastUsedAt > at ? old.lastUsedAt : at,
    recipes,
  };
  return { techniques: { ...state.techniques, [event.technique]: record } };
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** How rusty a technique is. Whole calendar days, so time zones and DST never matter. */
export function freshness(lastUsedAt: string, today: string, t: FreshnessThresholds): Freshness {
  requireDate(lastUsedAt, 'lastUsedAt');
  requireDate(today, 'today');
  const days = dayNumber(today) - dayNumber(lastUsedAt);
  if (days < t.warmAfterDays) return 'sharp'; // also covers a lastUsedAt in the future (clock skew)
  if (days < t.rustyAfterDays) return 'warm';
  return 'rusty';
}

export function toolkitRows(state: ToolkitState, today: string, t: FreshnessThresholds): ToolkitRow[] {
  return Object.keys(state.techniques)
    .sort()
    .map((technique) => {
      const r = state.techniques[technique];
      return {
        technique,
        tier: r.tier,
        freshness: r.tier === 'seen' ? null : freshness(r.lastUsedAt, today, t),
      };
    });
}

/** Every problem with the thresholds; empty when they are usable. */
export function validateThresholds(t: FreshnessThresholds): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(t.warmAfterDays) || t.warmAfterDays < 1)
    problems.push('warmAfterDays must be a whole number of at least 1');
  if (!Number.isInteger(t.rustyAfterDays) || t.rustyAfterDays < 1)
    problems.push('rustyAfterDays must be a whole number of at least 1');
  if (problems.length === 0 && t.rustyAfterDays <= t.warmAfterDays)
    problems.push('rustyAfterDays must be greater than warmAfterDays');
  return problems;
}
