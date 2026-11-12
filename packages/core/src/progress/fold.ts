// The one fold over a progress history. grantsFor, deriveProgress and compactHistory all read it, so the device
// and the API, compacted or not, see the same facts. Internal to progress/: not exported from the package.
//
// FOLD_VERSION (M6 Step 7 review I1): bump it with ANY change to what the fold computes or to the shape of
// `ProgressView` or `Facts` (a new field, a changed rule for a tier, a step, a key). The API's snapshot hash includes
// it, so every stored snapshot (a base folded by older code) is ignored and rebuilt from the ledgers instead of
// carrying the old fold forward. `fold-version.test.ts` pins the shape: it fingerprints a full fold and compares it
// with FOLD_SHAPES[FOLD_VERSION]; a shape change fails until a NEW version is added (old entries are never edited).
import { scoreAnswer } from '../market/round';
import { isValidDate } from '../rules/active';
import { EMPTY_TOOLKIT, toolkitFromEvents } from '../toolkit/toolkit';
import type { ToolkitState } from '../toolkit/types';
import type { Catalogue, ProgressEvent, ProgressHistory, ProgressSnapshot, ProgressView, RewardGrant } from './types';
import { isoWeek } from './week';

/** The fold's version (see the header). Exported from the package: the API's snapshot hash reads it. */
export const FOLD_VERSION = 1;

/**
 * The shape fingerprint of the view and facts at each FOLD_VERSION (`fold-version.test.ts` computes it). Append a new
 * version's entry when the shape changes; never edit an old one.
 */
export const FOLD_SHAPES: Readonly<Record<number, string>> = { 1: '4e3185af' };

/** The JSON-safe facts a snapshot carries beside its view (C15). */
export interface Facts {
  v: 1;
  /** Every event id seen, for the duplicate check. */
  ids: string[];
  /** local date → events seen with that `at` (the daily cap, C14). */
  perDate: Record<string, number>;
  /** Once-ever and once-per-period grant keys already used. */
  keys: string[];
  /** cook id → ISO weeks in which that cook's dish was cooked (Ruling 2). */
  cookWeeks: Record<string, string[]>;
  /** local date → nourishment grants made that day, by the grant's own isoDay (Ruling 6; I2 ruling). */
  nourishCount: Record<string, number>;
  /** local date → minutes of surviving meal-log events that earned nourishment (the 2 h gap). */
  nourishMinutes: Record<string, number[]>;
}

export interface FoldState {
  ids: Set<string>;
  perDate: Map<string, number>;
  keys: Set<string>;
  cookWeeks: Map<string, Set<string>>;
  nourishCount: Map<string, number>;
  nourishMinutes: Map<string, number[]>;
  xp: number;
  /** The highest level granted, at least 1. */
  level: number;
  stamps: number;
  trust: Map<string, number>;
  toolkit: ToolkitState;
  questsDone: string[];
  questSteps: Map<string, number>;
  questStartedOn: Map<string, string>;
  cookedOn: Map<string, Set<string>>;
  framesCookedOn: Map<string, Set<string>>;
  marketAnswered: Map<string, { correct: boolean; lastAt: string }>;
}

/** A grant key: JSON so an id holding ':' can never collide with another key. */
export const key = (...parts: (string | number)[]): string => JSON.stringify(parts);

/** The once-key a grant uses up, read from the event it was granted for; null for grants with no key. */
function grantKey(g: RewardGrant, e: ProgressEvent): string | null {
  if (!isValidDate(e.at)) return null;
  if (g.kind === 'certificate') return key('cert', g.technique);
  if (g.kind === 'stamp') {
    if (g.stamp === 'quest_done' && e.kind === 'quest_done') return key('quest', e.quest);
    if (g.stamp === 'market_run' && e.kind === 'market_run') return key('market', isoWeek(e.at));
    if (g.stamp === 'market_game' && e.kind === 'stall_round') return key('stall', e.stall, isoWeek(e.at));
    return null;
  }
  if (g.kind !== 'xp') return null;
  switch (g.reason) {
    case 'lesson':
      return e.kind === 'lesson' ? key('lesson', e.recipe, isoWeek(e.at)) : null;
    case 'drill':
      return e.kind === 'drill' ? key('drill', e.quest, e.step, isoWeek(e.at)) : null;
    case 'cook':
      return e.kind === 'cooked' ? key('cook', e.recipe, e.at) : null;
    case 'frame':
      return e.kind === 'frame_cooked' ? key('frame', e.frame, e.at) : null;
    case 'quest':
      return e.kind === 'quest_done' ? key('quest', e.quest) : null;
    case 'market_run':
      return e.kind === 'market_run' ? key('market', isoWeek(e.at)) : null;
    case 'nourishment': // counted per date in `nourish`
    case 'refresh': // once per refresh by freshness itself
    case 'market_game': // once per question, read from `marketAnswered` (the events), not a key
      return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const entries = (v: unknown): [string, unknown][] => (isObj(v) ? Object.entries(v) : []);
const nonNeg = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

function fromBase(base: ProgressSnapshot | null): FoldState {
  const s: FoldState = {
    ids: new Set(),
    perDate: new Map(),
    keys: new Set(),
    cookWeeks: new Map(),
    nourishCount: new Map(),
    nourishMinutes: new Map(),
    xp: 0,
    level: 1,
    stamps: 0,
    trust: new Map(),
    toolkit: EMPTY_TOOLKIT,
    questsDone: [],
    questSteps: new Map(),
    questStartedOn: new Map(),
    cookedOn: new Map(),
    framesCookedOn: new Map(),
    marketAnswered: new Map(),
  };
  if (!base) return s;
  // A stored snapshot is read defensively: a field that isn't the right shape counts as empty, never as a throw.
  const f = isObj(base.facts) ? base.facts : {};
  for (const id of strings(f.ids)) s.ids.add(id);
  for (const [d, n] of entries(f.perDate)) s.perDate.set(d, nonNeg(n));
  for (const k of strings(f.keys)) s.keys.add(k);
  for (const [c, w] of entries(f.cookWeeks)) s.cookWeeks.set(c, new Set(strings(w)));
  for (const [d, n] of entries(f.nourishCount)) s.nourishCount.set(d, nonNeg(n));
  for (const [d, m] of entries(f.nourishMinutes))
    s.nourishMinutes.set(d, Array.isArray(m) ? m.filter((x): x is number => typeof x === 'number') : []);
  const v: Partial<ProgressView> = isObj(base.view) ? base.view : {};
  s.xp = nonNeg(v.xp);
  s.level = Math.max(1, nonNeg(v.level));
  s.stamps = nonNeg(v.stamps);
  for (const [c, l] of entries(v.trust)) s.trust.set(c, nonNeg(l));
  if (isObj(v.toolkit) && isObj(v.toolkit.techniques)) s.toolkit = v.toolkit;
  s.questsDone = strings(v.questsDone);
  for (const [q, n] of entries(v.questSteps)) s.questSteps.set(q, nonNeg(n));
  for (const [q, d] of entries(v.questStartedOn)) if (typeof d === 'string' && isValidDate(d)) s.questStartedOn.set(q, d);
  for (const [r, ds] of entries(v.cookedOn)) s.cookedOn.set(r, new Set(strings(ds)));
  for (const [fr, ds] of entries(v.framesCookedOn)) s.framesCookedOn.set(fr, new Set(strings(ds)));
  for (const [q, a] of entries(v.marketAnswered))
    if (isObj(a) && typeof a.lastAt === 'string' && isValidDate(a.lastAt)) s.marketAnswered.set(q, { correct: a.correct === true, lastAt: a.lastAt });
  return s;
}

const addTo = (m: Map<string, Set<string>>, k: string, v: string) => {
  const set = m.get(k) ?? new Set<string>();
  set.add(v);
  m.set(k, set);
};

/** The cooks an accepted cook stands in for (I3); stored data is not trusted, so a malformed field is none. */
export const standsInFor = (e: { standsInFor?: unknown }): string[] => strings(e.standsInFor);

/**
 * A stall round's answers into `marketAnswered`: each pick scored from the stall file (never a stored flag), "ever
 * correct" only ever turning on, `lastAt` the latest date. Stored data is not trusted: a malformed answer is skipped,
 * and a question the catalogue no longer holds keeps its date but can't turn correct.
 */
function applyAnswers(s: FoldState, e: Extract<ProgressEvent, { kind: 'stall_round' }>, cat: Catalogue): void {
  const stall = cat.market?.get(e.stall);
  const answers: unknown = e.answers;
  if (!Array.isArray(answers)) return;
  for (const a of answers as unknown[]) {
    if (!isObj(a) || typeof a.q !== 'string' || typeof a.pick !== 'number') continue;
    const entry = stall?.questions.get(a.q);
    const correct = entry !== undefined && scoreAnswer(entry.question, a.pick).correct;
    const was = s.marketAnswered.get(a.q);
    s.marketAnswered.set(a.q, { correct: correct || was?.correct === true, lastAt: was !== undefined && was.lastAt > e.at ? was.lastAt : e.at });
  }
}

/** Apply one accepted event's own facts (not its grants) to the state. */
export function applyEvent(s: FoldState, e: ProgressEvent, cat: Catalogue): void {
  s.ids.add(e.id);
  s.perDate.set(e.at, (s.perDate.get(e.at) ?? 0) + 1);
  if (!isValidDate(e.at)) return;
  s.toolkit = toolkitFromEvents([e], cat, s.toolkit);
  switch (e.kind) {
    case 'cooked': {
      addTo(s.cookedOn, e.recipe, e.at); // sacred dishes too (C39): the record is kept, only the loop skips them
      const r = cat.recipes.get(e.recipe);
      if (r && !r.sacred) {
        addTo(s.cookWeeks, r.cook, isoWeek(e.at));
        for (const c of standsInFor(e)) addTo(s.cookWeeks, c, isoWeek(e.at));
      }
      break;
    }
    case 'frame_cooked':
      addTo(s.framesCookedOn, e.frame, e.at);
      for (const c of standsInFor(e)) addTo(s.cookWeeks, c, isoWeek(e.at));
      break;
    case 'quest_step':
      if (e.step > (s.questSteps.get(e.quest) ?? 0)) s.questSteps.set(e.quest, e.step);
      if (e.step === 1 && !s.questStartedOn.has(e.quest)) s.questStartedOn.set(e.quest, e.at);
      break;
    case 'quest_done':
      if (!s.questsDone.includes(e.quest)) s.questsDone.push(e.quest);
      break;
    case 'stall_round':
      applyAnswers(s, e, cat);
      break;
    case 'lesson':
    case 'drill':
    case 'recognized':
    case 'market_run':
    case 'meal_logged':
    case 'imported':
      break; // the toolkit fold above is all they change
  }
}

/**
 * Apply one grant. `e` is the event it was granted for, when the history still holds it. A grant whose event was
 * erased still counts in full: its XP, its id as seen (I1) and its day's nourishment count (I2 ruling).
 */
export function applyGrant(s: FoldState, g: RewardGrant, e: ProgressEvent | undefined): void {
  s.ids.add(g.eventId);
  switch (g.kind) {
    case 'xp':
      s.xp += nonNeg(g.amount);
      if (g.reason === 'nourishment') {
        const day = isValidDate(g.isoDay) ? g.isoDay : e?.at;
        if (day !== undefined) s.nourishCount.set(day, (s.nourishCount.get(day) ?? 0) + 1);
        if (e?.kind === 'meal_logged') s.nourishMinutes.set(e.at, [...(s.nourishMinutes.get(e.at) ?? []), e.minute]);
      }
      break;
    case 'stamp':
      s.stamps += 1;
      break;
    case 'trust':
      if (g.level > (s.trust.get(g.cook) ?? 0)) s.trust.set(g.cook, g.level);
      break;
    case 'level':
      if (g.level > s.level) s.level = g.level;
      break;
    case 'certificate':
      break;
  }
  const k = e ? grantKey(g, e) : null;
  if (k !== null) s.keys.add(k);
}

/** Fold a whole history: base, then each event followed by its grants, then grants whose event is not held. */
export function foldHistory(h: ProgressHistory, cat: Catalogue): FoldState {
  const s = fromBase(h.base);
  const byEvent = new Map<string, RewardGrant[]>();
  const held = new Set(h.events.map((e) => e.id));
  const orphans: RewardGrant[] = [];
  for (const g of h.grants) {
    if (!held.has(g.eventId)) orphans.push(g);
    else byEvent.set(g.eventId, [...(byEvent.get(g.eventId) ?? []), g]);
  }
  for (const e of h.events) {
    applyEvent(s, e, cat);
    for (const g of byEvent.get(e.id) ?? []) applyGrant(s, g, e);
    byEvent.delete(e.id); // a repeated id (never accepted, but stored data is not trusted) gets its grants once
  }
  for (const g of orphans) applyGrant(s, g, undefined);
  return s;
}

const sortedRecord = (m: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]));

export function viewOf(s: FoldState): ProgressView {
  return {
    xp: s.xp,
    level: s.level,
    stamps: s.stamps,
    trust: Object.fromEntries(s.trust),
    toolkit: s.toolkit,
    questsDone: [...s.questsDone],
    questSteps: Object.fromEntries(s.questSteps),
    questStartedOn: Object.fromEntries(s.questStartedOn),
    cookedOn: sortedRecord(s.cookedOn),
    framesCookedOn: sortedRecord(s.framesCookedOn),
    marketAnswered: Object.fromEntries([...s.marketAnswered].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([q, a]) => [q, { ...a }])),
  };
}

export function snapshotOf(s: FoldState): ProgressSnapshot {
  const facts: Facts = {
    v: 1,
    ids: [...s.ids],
    perDate: Object.fromEntries(s.perDate),
    keys: [...s.keys],
    cookWeeks: sortedRecord(s.cookWeeks),
    nourishCount: Object.fromEntries(s.nourishCount),
    nourishMinutes: Object.fromEntries([...s.nourishMinutes].map(([d, m]) => [d, [...m]])),
  };
  return { view: viewOf(s), facts };
}
