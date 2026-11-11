import type { Catalogue, ProgressEvent } from '../progress/types';
import { isValidDate } from '../rules/active';
import type { Freshness, FreshnessThresholds, TechniqueEvent, TechniqueRecord, Tier, ToolkitRow, ToolkitState } from './types';

export type { Tier, Freshness, FreshnessThresholds, TechniqueEvent, TechniqueRecord, ToolkitState, ToolkitRow } from './types';

export const EMPTY_TOOLKIT: ToolkitState = Object.freeze({ techniques: Object.freeze({}) });

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
  // Own keys only: a technique id such as "__proto__" or "constructor" is data, never an inherited property.
  const old = Object.hasOwn(state.techniques, event.technique) ? state.techniques[event.technique] : undefined;

  let record: TechniqueRecord;
  if (event.kind === 'recognized') {
    // Recognition only ever lifts Tried to Yours. It is not a use, so the dates stay as they were.
    if (!old || old.tier !== 'tried') return state;
    record = { ...old, recipes: [...old.recipes], tier: 'yours' };
  } else if (event.kind === 'imported') {
    const firstAt = requireDate(event.firstAt, 'imported firstAt');
    const lastUsedAt = requireDate(event.lastUsedAt, 'imported lastUsedAt');
    const recipes = old ? [...old.recipes] : [];
    for (const r of event.recipes) if (!recipes.includes(r)) recipes.push(r);
    let tier = old ? maxTier(old.tier, event.tier) : event.tier;
    if (recipes.length >= 2) tier = 'yours';
    record = {
      tier,
      firstAt: old && old.firstAt < firstAt ? old.firstAt : firstAt,
      lastUsedAt: old && old.lastUsedAt > lastUsedAt ? old.lastUsedAt : lastUsedAt,
      recipes,
    };
  } else {
    const recipes = old ? [...old.recipes] : [];
    if (event.kind === 'cooked' && !recipes.includes(event.recipe)) recipes.push(event.recipe);

    let computed: Tier = event.kind === 'cooked' ? 'tried' : 'seen';
    if (recipes.length >= 2) computed = 'yours';

    record = {
      tier: old ? maxTier(old.tier, computed) : computed,
      firstAt: old && old.firstAt < at ? old.firstAt : at,
      lastUsedAt: old && old.lastUsedAt > at ? old.lastUsedAt : at,
      recipes,
    };
  }
  // fromEntries defines own properties, so "__proto__" is stored as a key, not used as a prototype setter.
  return { techniques: Object.fromEntries([...Object.entries(state.techniques).filter(([k]) => k !== event.technique), [event.technique, record]]) };
}

/**
 * Whether using `technique` on `at` refreshes it: it was Tried or Yours and Rusty on that day, judged on the
 * toolkit as it stood before the event. Seen has nothing to fade; a bad date is never due.
 */
export function refreshDue(state: ToolkitState, technique: string, at: string, t: FreshnessThresholds): boolean {
  if (!isValidDate(at) || !Object.hasOwn(state.techniques, technique)) return false;
  const r = state.techniques[technique];
  if (r.tier === 'seen' || !isValidDate(r.lastUsedAt)) return false;
  return freshness(r.lastUsedAt, at, t) === 'rusty';
}

/** The frame entry a frame cook adds to a technique's recipe list: it counts as one more distinct dish. */
const frameKey = (frame: string): string => `frame:${frame}`;

function techniqueEventsOf(state: ToolkitState, e: ProgressEvent, cat: Catalogue): TechniqueEvent[] {
  switch (e.kind) {
    case 'lesson': {
      const r = cat.recipes.get(e.recipe);
      // A sacred dish is a story only (spec §10): it sits outside the toolkit loop.
      if (!r || r.sacred) return [];
      return r.skills.map((technique) => ({ kind: 'lesson', technique, at: e.at }));
    }
    case 'drill':
      return [{ kind: 'lesson', technique: e.technique, at: e.at }];
    case 'cooked': {
      const r = cat.recipes.get(e.recipe);
      if (!r || r.sacred) return [];
      return r.skills.map((technique) => ({ kind: 'cooked', technique, at: e.at, recipe: e.recipe }));
    }
    case 'frame_cooked':
      return [{ kind: 'cooked', technique: e.technique, at: e.at, recipe: frameKey(e.frame) }];
    case 'quest_done': {
      // Ruling 4: each rewards.skills key is a technique practised, read as Seen. Part of the fold, never a grant.
      const q = cat.quests.get(e.quest);
      return q ? q.skills.map((technique) => ({ kind: 'lesson', technique, at: e.at })) : [];
    }
    case 'recognized': {
      const q = cat.quests.get(e.quest);
      if (!q || recognizedCook(state, e.technique, q.cook, cat) === null) return [];
      return [{ kind: 'recognized', technique: e.technique, at: e.at }];
    }
    case 'imported':
      return [{ kind: 'imported', technique: e.technique, at: e.at, tier: e.tier, firstAt: e.firstAt, lastUsedAt: e.lastUsedAt, recipes: [...e.recipes] }];
    case 'quest_step':
    case 'market_run':
    case 'meal_logged':
      return [];
    default:
      return []; // stored data is not trusted: an unknown kind changes nothing

  }
}

/**
 * The other cook whose dish gave `technique` its Tried tier, when the player has it at Tried from a recipe of a
 * cook other than `questCook` (audit M-3); null otherwise. Frame entries and unknown recipes have no cook.
 */
export function recognizedCook(state: ToolkitState, technique: string, questCook: string, cat: Pick<Catalogue, 'recipes'>): string | null {
  if (!Object.hasOwn(state.techniques, technique)) return null;
  const r = state.techniques[technique];
  if (r.tier !== 'tried') return null;
  for (const slug of r.recipes) {
    const cook = cat.recipes.get(slug)?.cook;
    if (cook !== undefined && cook !== questCook) return cook;
  }
  return null;
}

/**
 * The toolkit as a fold over progress events (Ruling 7), optionally continuing from `start` (a compacted base).
 * Pure and total: an event it cannot read (a bad date, an unknown recipe) changes nothing.
 */
export function toolkitFromEvents(events: readonly ProgressEvent[], cat: Catalogue, start: ToolkitState = EMPTY_TOOLKIT): ToolkitState {
  let state = start;
  for (const e of events) {
    if (!isValidDate(e.at)) continue;
    for (const te of techniqueEventsOf(state, e, cat)) {
      try {
        state = recordTechnique(state, te);
      } catch {
        // a malformed imported record (bad dates): skipped, never thrown out of the fold
      }
    }
  }
  return state;
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
      const r = state.techniques[technique]; // an own key: it came from Object.keys
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
