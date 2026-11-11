// One More Technique (audit M-2) and the Rusty refresher (spec §17) share one weekly slot. Pure and deterministic
// (technique id, then slug; no randomness), so the device and the server offer the same thing.
import type { IngredientGraph } from '../ingredients/graph';
import type { ParsedRecipe } from '../recipe/types';
import { check, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';
import { toolkitRows } from './toolkit';
import type { FreshnessThresholds, TechniqueNode, Tier, ToolkitState } from './types';

/** At most one suggestion a plan week, new technique or refresher (spec §17, audit M-2). */
export const ONE_MORE_PER_WEEK = 1;

/** Never 'blocked' or 'unverified': a ⛔ or ❓ dish is never offered (spec §2.2). */
export type SlotOffer =
  | { kind: 'new'; technique: string; from: string; recipe: string; status: 'ok' | 'swap' }
  | { kind: 'refresh'; technique: string; recipe: string; status: 'ok' | 'swap' };

/** Step 8's `buildPlanCard` takes this as `slot` (C42). */
export interface WeeklySlotInput {
  toolkit: ToolkitState;
  techniques: readonly TechniqueNode[];
  recipes: ReadonlyMap<string, ParsedRecipe>;
  /** Recipes the player may cook now (all canon, Ruling 3). */
  taught: ReadonlySet<string>;
  /** Slugs already in this week's plan. */
  planned: readonly string[];
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  /** The plan week's first day (Ruling 11); dishes are checked on it. */
  weekStart: string;
  today: string;
  thresholds: FreshnessThresholds;
  /** `slot` is this plan week's answer; anything but 'unanswered' means the week's one suggestion is used. */
  week: { hard: boolean; slot: 'unanswered' | 'accepted' | 'declined' | 'offered' };
}

const RANK: Record<Tier, number> = { seen: 0, tried: 1, yours: 2 };
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The dish to practise `technique` with: a taught, non-sacred recipe with that skill whose check on `weekStart` is
 * ✅ or a labelled swap; one already planned this week first, then by slug. `onlyPlanned` limits it to planned ones.
 */
function dishFor(technique: string, input: WeeklySlotInput, onlyPlanned: boolean): { recipe: string; status: 'ok' | 'swap' } | null {
  const planned = new Set(input.planned);
  const slugs = [...input.recipes.keys()]
    .filter((slug) => input.taught.has(slug) && (!onlyPlanned || planned.has(slug)))
    .sort((a, b) => Number(planned.has(b)) - Number(planned.has(a)) || byId(a, b));
  for (const slug of slugs) {
    const r = input.recipes.get(slug)!;
    if (r.meta.sacred || !r.meta.skills.includes(technique)) continue;
    const { status } = check(r, input.rules, input.graph, input.subs, input.weekStart);
    if (status === 'ok' || status === 'swap') return { recipe: slug, status };
  }
  return null;
}

/**
 * This plan week's one suggestion, or null: in a hard week, once the slot was offered or answered (saying no costs
 * nothing and is final for the week), or when nothing qualifies. Never a list.
 *
 * - new: a technique the player doesn't have, in the `adjacent` of one they have at Tried or Yours, every `prereqs` id
 *   at Seen or better, with a dish (see `dishFor`). A dish already planned this week wins over technique order.
 * - refresh, only when no new offer exists: a Rusty technique, the oldest `lastUsedAt` first, with the same dish rule.
 */
export function weeklySlot(input: WeeklySlotInput): SlotOffer | null {
  if (input.week.hard || input.week.slot !== 'unanswered') return null;
  const has = (id: string): boolean => Object.hasOwn(input.toolkit.techniques, id);
  const tier = (id: string): Tier | null => (has(id) ? input.toolkit.techniques[id].tier : null);

  // technique → the first (by id) held technique at Tried or Yours that lists it as adjacent.
  const from = new Map<string, string>();
  const nodes = [...input.techniques].sort((a, b) => byId(a.id, b.id));
  const prereqs = new Map(nodes.map((n) => [n.id, n.prereqs]));
  for (const n of nodes) {
    const t = tier(n.id);
    if (t === null || RANK[t] < RANK.tried) continue;
    for (const next of n.adjacent) if (!has(next) && !from.has(next)) from.set(next, n.id);
  }
  const candidates = [...from.keys()]
    .filter((id) => prereqs.has(id) && prereqs.get(id)!.every(has))
    .sort(byId);

  for (const onlyPlanned of [true, false]) {
    for (const technique of candidates) {
      const dish = dishFor(technique, input, onlyPlanned);
      if (dish) return { kind: 'new', technique, from: from.get(technique)!, ...dish };
    }
  }

  const rusty = toolkitRows(input.toolkit, input.today, input.thresholds)
    .filter((r) => r.freshness === 'rusty')
    .map((r) => ({ technique: r.technique, lastUsedAt: input.toolkit.techniques[r.technique].lastUsedAt }))
    .sort((a, b) => byId(a.lastUsedAt, b.lastUsedAt) || byId(a.technique, b.technique));
  for (const { technique } of rusty) {
    const dish = dishFor(technique, input, false);
    if (dish) return { kind: 'refresh', technique, ...dish };
  }
  return null;
}
