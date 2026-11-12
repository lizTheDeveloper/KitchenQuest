// Test support for progress/ tests only (not exported from the package). The catalogue mirrors the launch content:
// three cooks, their dishes and quests, plus a same-cook second dish and a sacred dish for the edge cases.
import { BRAM, graph as marketGraph, SEASONAL_STRAWBERRY, subs as marketSubs, WEN } from '../market/fixtures';
import type { RulesContext } from '../quests/alternatives';
import type { FreshnessThresholds } from '../toolkit/types';
import { grantsFor, marketCatalogue } from './rewards';
import type { Catalogue, ProgressEvent, ProgressHistory, RewardGrant, RewardsData } from './types';

/** Must equal data/rewards.yaml (packages/core/test/progress-data.test.ts pins it). */
export const DATA: RewardsData = {
  xp: { lesson: 10, drill: 10, cook: 30, frame: 20, market_run: 20, refresh: 15, market_game: 5, nourishment: { per_log: 5, max_per_day: 3, min_gap_minutes: 120 } },
  levels: [100, 250, 450, 700, 1000, 1400, 1900, 2500],
  stamps: { quest_done: 1, certificate: 1, market_run: 1, market_game: 1 },
  trust: { names: ['Stranger', 'Guest', 'Acquainted', 'Trusted apprentice', 'Family friend', 'Keeper of the dish'], weeks_for_level: [2, 4, 7, 10] },
};

export const T: FreshnessThresholds = { warmAfterDays: 42, rustyAfterDays: 120 };

export const CAT: Catalogue = {
  recipes: new Map([
    ['parippu', { cook: 'leela', skills: ['legumes', 'heat-control', 'tempering'], sacred: false }],
    ['onigiri', { cook: 'haruka', skills: ['grains', 'heat-control', 'shaping'], sacred: false }],
    ['frijoles-de-olla', { cook: 'marisol', skills: ['legumes', 'heat-control', 'patience'], sacred: false }],
    ['sambar', { cook: 'leela', skills: ['legumes', 'tempering'], sacred: false }],
    ['ofrenda', { cook: 'marisol', skills: ['patience', 'knife'], sacred: true }],
  ]),
  quests: new Map([
    ['leela-tempering', { cook: 'leela', steps: 5, xp: 40, trust: 1, skills: ['tempering', 'legumes', 'knife'], requires: [] }],
    ['marisol-salt-question', { cook: 'marisol', steps: 5, xp: 45, trust: 1, skills: ['legumes', 'heat-control', 'patience'], requires: ['leela-tempering'] }],
    ['haruka-gluey-rice', { cook: 'haruka', steps: 5, xp: 50, trust: 1, skills: ['grains', 'shaping', 'heat-control'], requires: ['marisol-salt-question'] }],
  ]),
  techniques: new Set(['legumes', 'heat-control', 'tempering', 'grains', 'shaping', 'patience', 'knife', 'stir-fry', 'emulsion', 'quick-sauce']),
  frames: new Map([
    ['fried-rice', { technique: 'stir-fry' }],
    ['green-sauce', { technique: 'emulsion' }],
    ['quick-tomato', { technique: 'quick-sauce' }],
  ]),
};

/**
 * CAT plus two market stalls (M6 Step 3): Big Bram with his Protein Counter variant, and Old Wen with one seasonal
 * question (the market fixtures' stall files and graph).
 */
export const MARKET_CAT: Catalogue = {
  ...CAT,
  market: marketCatalogue([BRAM, { ...WEN, seasonal: { 'test-vale': { '6': [SEASONAL_STRAWBERRY] } } }]),
};

/** The player's rules for a stall round, over the market fixtures' graph and the shipped substitutions. */
export const rulesCtx = (rules: RulesContext['rules'] = []): RulesContext => ({ rules, graph: marketGraph, subs: marketSubs, recipes: new Map() });

export const EMPTY: ProgressHistory = { events: [], grants: [], base: null };

let counter = 0;
const nextId = () => `e${++counter}`;

export const ev = {
  lesson: (recipe: string, at: string): ProgressEvent => ({ id: nextId(), kind: 'lesson', at, recipe }),
  cooked: (recipe: string, at: string, planned = false): ProgressEvent => ({ id: nextId(), kind: 'cooked', at, recipe, planned }),
  drill: (quest: string, step: number, technique: string, at: string): ProgressEvent => ({ id: nextId(), kind: 'drill', at, quest, step, technique }),
  frame: (frame: string, technique: string, at: string): ProgressEvent => ({ id: nextId(), kind: 'frame_cooked', at, frame, technique }),
  step: (quest: string, step: number, at: string): ProgressEvent => ({ id: nextId(), kind: 'quest_step', at, quest, step }),
  done: (quest: string, at: string): ProgressEvent => ({ id: nextId(), kind: 'quest_done', at, quest }),
  recognized: (quest: string, technique: string, at: string): ProgressEvent => ({ id: nextId(), kind: 'recognized', at, quest, technique }),
  market: (at: string, weekStart = at): ProgressEvent => ({ id: nextId(), kind: 'market_run', at, weekStart }),
  meal: (at: string, minute: number): ProgressEvent => ({ id: nextId(), kind: 'meal_logged', at, minute }),
  /** `answers`: [question id, file-index pick] pairs. */
  round: (stall: string, at: string, answers: [string, number][]): ProgressEvent => ({ id: nextId(), kind: 'stall_round', at, stall, answers: answers.map(([q, pick]) => ({ q, pick })) }),
};

/** Every step of a quest, then its quest_done, all on one date. */
export const finishQuest = (quest: string, at: string, steps = 5): ProgressEvent[] => [
  ...Array.from({ length: steps }, (_, i) => ev.step(quest, i + 1, at)),
  ev.done(quest, at),
];

export interface Played {
  history: ProgressHistory;
  results: { event: ProgressEvent; grants: RewardGrant[]; problems: string[] }[];
}

/** Feed events one by one through grantsFor, keeping the accepted ones and their grants, as the API does. */
export function play(events: readonly ProgressEvent[], start: ProgressHistory = EMPTY, data: RewardsData = DATA, cat: Catalogue = CAT, rules?: RulesContext): Played {
  let history = start;
  const results: Played['results'] = [];
  for (const event of events) {
    const r = grantsFor(event, history, cat, data, T, rules);
    results.push({ ...r, event });
    if (r.problems.length === 0) history = { ...history, events: [...history.events, r.event], grants: [...history.grants, ...r.grants] };
  }
  return { history, results };
}

/** The grants of the last event played. */
export const last = (p: Played) => p.results[p.results.length - 1];

export const xpOf = (grants: readonly RewardGrant[]) => grants.reduce((s, g) => s + (g.kind === 'xp' ? g.amount : 0), 0);

/** A local date `days` after `from`. */
export function addDays(from: string, days: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
