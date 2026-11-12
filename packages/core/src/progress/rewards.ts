import { questionStatus, stallVariant } from '../market/bank';
import { MAX_ROUND_ANSWERS, scoreAnswer } from '../market/round';
import type { MarketCtx, StallFile, StallQuestion } from '../market/types';
import { isValidDate } from '../rules/active';
import { refreshDue, toolkitFromEvents } from '../toolkit/toolkit';
import type { FreshnessThresholds, ToolkitState } from '../toolkit/types';
import { levelFor, trustLevel } from './derive';
import { standInCooks, type RulesContext } from '../quests/alternatives';
import { applyEvent, applyGrant, foldHistory, key, standsInFor, type FoldState } from './fold';
import type { Catalogue, MarketStall, ProgressEvent, ProgressHistory, RewardGrant, RewardsData, StampId, XpReason } from './types';
import { isoWeek } from './week';

/** Per local date (`at`). Core enforces it, per event, so the device and the API agree (C14). */
export const MAX_PROGRESS_EVENTS_PER_DAY = 200;

/**
 * Something about an accepted event that was set aside. `stand_in_dropped`: its `standsInFor` claim was missing the
 * player's rules, malformed, or didn't hold, so the claim was dropped and the cook kept its own grants (ruling on
 * fix-round concern 3: drop the claim, never the event).
 */
export type ProgressWarning = 'stand_in_dropped';

/** The result for one event. Store `event` (as accepted, a dropped claim removed), never the event as sent. */
export interface GrantResult {
  event: ProgressEvent;
  grants: RewardGrant[];
  problems: string[];
  warnings: ProgressWarning[];
}

/**
 * Whether a `standsInFor` claim holds (I3): the player's rules are given, the date is valid, the claim is a
 * non-empty list naming each cook once, and every cook is one `standInCooks` gives for this cook on its date.
 */
function claimHolds(e: ProgressEvent, cat: Catalogue, rules: RulesContext | undefined): boolean {
  const claim: unknown = (e as { standsInFor?: unknown }).standsInFor;
  if (rules === undefined || !isValidDate(e.at) || !Array.isArray(claim) || claim.length === 0) return false;
  if (new Set(claim).size !== claim.length || !claim.every((c) => isStr(c))) return false;
  const dish = e.kind === 'cooked' ? ({ kind: 'recipe', slug: e.recipe } as const) : e.kind === 'frame_cooked' ? ({ kind: 'frame', id: e.frame } as const) : null;
  if (dish === null) return false; // only a cook can stand in; lessons never count
  const holds = new Set(standInCooks(dish, e.at, cat, rules));
  return claim.every((c: string) => holds.has(c));
}

/** Why an event was rejected. Any problem means the event is not recorded and earns nothing. */
export type ProgressProblem =
  | 'bad_event'
  | 'bad_id'
  | 'duplicate_id'
  | 'bad_date'
  | 'too_many_events'
  | 'unknown_kind'
  | 'unknown_recipe'
  | 'unknown_quest'
  | 'unknown_step'
  | 'step_out_of_order'
  | 'quest_waiting'
  | 'quest_not_finished'
  | 'quest_already_done'
  | 'unknown_technique'
  | 'unknown_frame'
  | 'technique_mismatch'
  | 'bad_field'
  /**
   * M6: a `stall_round` that is otherwise well-formed arrived without the player's rules (the device signed out, before
   * rules load), or with rules that can't be read. Nothing is stored; the caller retries once rules load (fail closed,
   * M5 C5 pattern).
   */
  | 'rules_unknown';

const STAMP_IDS: readonly StampId[] = ['quest_done', 'certificate', 'market_run', 'market_game'];
const XP_KEYS = ['lesson', 'drill', 'cook', 'frame', 'market_run', 'refresh', 'market_game'] as const;
const TIERS = new Set(['seen', 'tried', 'yours']);
const MAX_ID_LENGTH = 128;
const MAX_IMPORTED_RECIPES = 100;
const MINUTES_PER_DAY = 1440;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const isPositive = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** Every problem with data/rewards.yaml (parsed); empty when it is usable. techniques.yaml is validateTechniques'. */
export function validateRewards(d: unknown): string[] {
  const p: string[] = [];
  if (!isObj(d)) return ['rewards must be a mapping'];

  if (!isObj(d.xp)) p.push('xp must be a mapping');
  else {
    for (const k of XP_KEYS) if (!isAmount(d.xp[k])) p.push(`xp.${k} must be a whole number of at least 0`);
    const n = d.xp.nourishment;
    if (!isObj(n)) p.push('xp.nourishment must be a mapping');
    else {
      if (!isAmount(n.per_log)) p.push('xp.nourishment.per_log must be a whole number of at least 0');
      if (!isAmount(n.max_per_day)) p.push('xp.nourishment.max_per_day must be a whole number of at least 0');
      if (!isAmount(n.min_gap_minutes) || n.min_gap_minutes >= MINUTES_PER_DAY)
        p.push('xp.nourishment.min_gap_minutes must be a whole number from 0 to 1439');
    }
  }

  const levels: unknown = d.levels;
  if (!Array.isArray(levels) || levels.length === 0) p.push('levels must be a non-empty list');
  else if (!levels.every(isPositive)) p.push('levels must be whole numbers of at least 1');
  else if (levels.some((v, i) => i > 0 && v <= levels[i - 1])) p.push('levels must be strictly increasing');

  if (!isObj(d.stamps)) p.push('stamps must be a mapping');
  else {
    for (const k of STAMP_IDS) if (!isAmount(d.stamps[k])) p.push(`stamps.${k} must be a whole number of at least 0`);
    for (const k of Object.keys(d.stamps))
      if (!(STAMP_IDS as readonly string[]).includes(k)) p.push(`stamps.${k} is not a stamp kind`);
  }

  if (!isObj(d.trust)) p.push('trust must be a mapping');
  else {
    const { names, weeks_for_level: weeks } = d.trust;
    const namesOk = Array.isArray(names) && names.every(isStr);
    const weeksOk = Array.isArray(weeks) && weeks.every(isPositive);
    if (!namesOk) p.push('trust.names must be a list of names');
    if (!weeksOk) p.push('trust.weeks_for_level must be a list of whole numbers of at least 1');
    if (weeksOk && weeks.some((v, i) => i > 0 && v <= weeks[i - 1])) p.push('trust.weeks_for_level must be strictly increasing');
    if (namesOk && weeksOk && names.length !== weeks.length + 2)
      p.push(`trust.names needs ${weeks.length + 2} names (Stranger, Guest, then one per weeks_for_level), not ${names.length}`);
  }
  return p;
}

// ---- the market (M6) ----------------------------------------------------------------------------------------

/**
 * `Catalogue.market` from the stall files (M6): every question each file holds, with its bank. Built the same way by
 * the API (Step 6) and the device (Step 9). Throws on a stall id given twice, a question id in two banks of one
 * stall, or a question id at two stalls (fix round 1, M4: `marketAnswered` is keyed by the bare id, so a shared id would
 * let one stall's answer use up another's first-correct XP), so a broken catalogue fails at load, never at grant time.
 */
export function marketCatalogue(files: readonly StallFile[]): Map<string, MarketStall> {
  const out = new Map<string, MarketStall>();
  const owner = new Map<string, string>();
  for (const file of files) {
    if (out.has(file.id)) throw new Error(`stall "${file.id}" is given twice`);
    const questions = new Map<string, { question: StallQuestion; variant: 'base' | 'protein_counter' | 'seasonal' }>();
    const add = (list: readonly StallQuestion[], variant: 'base' | 'protein_counter' | 'seasonal') => {
      for (const question of list) {
        if (questions.has(question.id)) throw new Error(`stall "${file.id}": question "${question.id}" is in two banks`);
        const other = owner.get(question.id);
        if (other !== undefined) throw new Error(`question "${question.id}" is at two stalls ("${other}" and "${file.id}")`);
        owner.set(question.id, file.id);
        questions.set(question.id, { question, variant });
      }
    };
    add(file.questions, 'base');
    add(file.variants?.protein_counter?.questions ?? [], 'protein_counter');
    for (const months of Object.values(file.seasonal ?? {})) for (const list of Object.values(months)) if (Array.isArray(list)) add(list, 'seasonal');
    out.set(file.id, { questions, file });
  }
  return out;
}

const ROUND_KEYS: ReadonlySet<string> = new Set(['id', 'kind', 'at', 'stall', 'answers']);
const ANSWER_KEYS: ReadonlySet<string> = new Set(['q', 'pick']);

/**
 * A `stall_round` (M6 Rulings 1, 2 and 4; Review Focus 4). Shape first, all `bad_event`: the stall is in `cat.market`;
 * no key outside the event's shape (a forged "correct" flag, a score); 1–MAX_ROUND_ANSWERS answers, each `{ q, pick }`
 * only, each q one of that stall's questions and given once, each pick a file index in range. Then the rules: without
 * them, `rules_unknown`. With them, every question must be one the player could have been shown on `at`: in the bank
 * `stallVariant` gives them (a Protein Counter question only while their rules block meat, a base or seasonal one only
 * while they don't) and `questionStatus` 'ok' with MarketCtx { rules, graph, subs, date: at, country: null } (no
 * substitutions: a question kept only by a curated swap is hidden). The country scope is a relevance filter, not
 * safety, so it isn't re-checked. A hidden question → `bad_event`, and nothing is stored.
 */
function validateStallRound(e: Record<string, unknown>, cat: Catalogue, rules: RulesContext | undefined): ProgressProblem[] {
  const stall = isStr(e.stall) && cat.market !== undefined ? cat.market.get(e.stall) : undefined;
  if (stall === undefined || Object.keys(e).some((k) => !ROUND_KEYS.has(k))) return ['bad_event'];
  const answers: unknown = e.answers;
  if (!Array.isArray(answers) || answers.length < 1 || answers.length > MAX_ROUND_ANSWERS) return ['bad_event'];
  const seen = new Set<string>();
  const asked: { question: StallQuestion; variant: 'base' | 'protein_counter' | 'seasonal' }[] = [];
  for (const a of answers as unknown[]) {
    if (!isObj(a) || Object.keys(a).some((k) => !ANSWER_KEYS.has(k)) || !isStr(a.q) || seen.has(a.q)) return ['bad_event'];
    seen.add(a.q);
    const entry = stall.questions.get(a.q);
    if (entry === undefined || !Number.isInteger(a.pick) || (a.pick as number) < 0 || (a.pick as number) >= entry.question.options.length)
      return ['bad_event'];
    asked.push(entry);
  }
  if (rules === undefined) return ['rules_unknown'];
  if (!isValidDate(e.at)) return []; // `validate` already reports bad_date
  const ctx: MarketCtx = { rules: rules.rules, graph: rules.graph, subs: rules.subs, date: e.at, country: null };
  try {
    const variant = stallVariant(stall.file, ctx);
    for (const { question, variant: bank } of asked) {
      if ((bank === 'protein_counter' ? 'protein_counter' : 'base') !== variant) return ['bad_event'];
      if (questionStatus(question, ctx) !== 'ok') return ['bad_event'];
    }
  } catch {
    return ['rules_unknown']; // rules the engine can't read: can't verify is never safe, and never stored
  }
  return [];
}

/**
 * Whether an event reveals health data (M6 Ruling 17): a `stall_round` with any Protein Counter question, which shows
 * the player's rules exclude meat. It decides which rounds need `health_data` consent to be accepted, nothing more.
 * Sealing is by kind, never by this: every `stall_round` is sealed at rest (Task 3 privacy ruling: answered question ids
 * can imply a rule over time), and a `health_data` delete erases every `stall_round` (Task 3 ruling I2), not only the
 * ones this calls revealing. Fail closed: a round naming a stall or question the catalogue doesn't hold (content
 * removed since), or with no readable answers, counts as revealing. Every other kind is false.
 */
export function isHealthRevealing(e: ProgressEvent, cat: Catalogue): boolean {
  if (e.kind !== 'stall_round') return false;
  const stall = cat.market?.get(e.stall);
  const answers: unknown = e.answers;
  if (stall === undefined || !Array.isArray(answers) || answers.length === 0) return true;
  return (answers as unknown[]).some((a) => {
    const entry = isObj(a) && typeof a.q === 'string' ? stall.questions.get(a.q) : undefined;
    return entry === undefined || entry.variant === 'protein_counter';
  });
}

// ---- event validation ---------------------------------------------------------------------------------------

function requiresDone(q: { requires: readonly string[] }, s: FoldState): boolean {
  return q.requires.every((r) => s.questsDone.includes(r));
}

function validateKind(e: Record<string, unknown>, s: FoldState, cat: Catalogue, rules: RulesContext | undefined): ProgressProblem[] {
  const p: ProgressProblem[] = [];
  const quest = () => {
    const q = isStr(e.quest) ? cat.quests.get(e.quest) : undefined;
    if (!q) p.push('unknown_quest');
    return q;
  };
  const technique = () => {
    if (!isStr(e.technique) || !cat.techniques.has(e.technique)) p.push('unknown_technique');
  };
  switch (e.kind) {
    case 'lesson':
      if (!isStr(e.recipe) || !cat.recipes.has(e.recipe)) p.push('unknown_recipe');
      break;
    case 'cooked':
      if (!isStr(e.recipe) || !cat.recipes.has(e.recipe)) p.push('unknown_recipe');
      if (typeof e.planned !== 'boolean') p.push('bad_field');
      break;
    case 'drill': {
      const q = quest();
      technique();
      if (q) {
        if (!Number.isInteger(e.step) || (e.step as number) < 1 || (e.step as number) > q.steps) p.push('unknown_step');
        if (!requiresDone(q, s)) p.push('quest_waiting');
      }
      break;
    }
    case 'frame_cooked': {
      const f = isStr(e.frame) ? cat.frames.get(e.frame) : undefined;
      if (!f) p.push('unknown_frame');
      technique();
      if (f && isStr(e.technique) && cat.techniques.has(e.technique) && f.technique !== e.technique) p.push('technique_mismatch');
      break;
    }
    case 'quest_step': {
      const q = quest();
      if (!q) break;
      const step = e.step;
      if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > q.steps) p.push('unknown_step');
      else if (step !== (s.questSteps.get(e.quest as string) ?? 0) + 1) p.push('step_out_of_order');
      if (!requiresDone(q, s)) p.push('quest_waiting');
      break;
    }
    case 'quest_done': {
      const q = quest();
      if (!q) break;
      if (s.questsDone.includes(e.quest as string)) p.push('quest_already_done');
      else if ((s.questSteps.get(e.quest as string) ?? 0) < q.steps) p.push('quest_not_finished');
      if (!requiresDone(q, s)) p.push('quest_waiting');
      break;
    }
    case 'recognized': {
      const q = quest();
      technique();
      if (q && !requiresDone(q, s)) p.push('quest_waiting');
      break;
    }
    case 'market_run':
      if (!isValidDate(e.weekStart)) p.push('bad_field');
      break;
    case 'stall_round':
      p.push(...validateStallRound(e, cat, rules));
      break;
    case 'meal_logged':
      if (!Number.isInteger(e.minute) || (e.minute as number) < 0 || (e.minute as number) >= MINUTES_PER_DAY) p.push('bad_field');
      break;
    case 'imported': {
      technique();
      const datesOk = isValidDate(e.firstAt) && isValidDate(e.lastUsedAt) && e.firstAt <= e.lastUsedAt;
      // M3: an M3 record is checked against the catalogue so it can't be laundered into a certificate. Each recipe is
      // a known, non-sacred dish that teaches the technique, and the tier is the one M3's rule gives those recipes
      // (none → Seen, one → Tried, two or more → Yours).
      const recipes: unknown = e.recipes;
      const recipesOk =
        Array.isArray(recipes) &&
        recipes.length <= MAX_IMPORTED_RECIPES &&
        new Set(recipes).size === recipes.length &&
        recipes.every((r) => {
          const recipe = isStr(r) ? cat.recipes.get(r) : undefined;
          return recipe !== undefined && !recipe.sacred && recipe.skills.includes(e.technique as string);
        });
      const tierOk = recipesOk && e.tier === (recipes.length === 0 ? 'seen' : recipes.length === 1 ? 'tried' : 'yours');
      if (typeof e.tier !== 'string' || !TIERS.has(e.tier) || !datesOk || !recipesOk || !tierOk) p.push('bad_field');
      break;
    }
    default:
      p.push('unknown_kind');
  }
  return p;
}

function validate(event: unknown, s: FoldState, cat: Catalogue, rules: RulesContext | undefined): ProgressProblem[] {
  if (!isObj(event)) return ['bad_event'];
  const p: ProgressProblem[] = [];
  if (!isStr(event.id) || event.id.length > MAX_ID_LENGTH) p.push('bad_id');
  else if (s.ids.has(event.id)) p.push('duplicate_id');
  if (!isValidDate(event.at)) p.push('bad_date');
  else if ((s.perDate.get(event.at) ?? 0) >= MAX_PROGRESS_EVENTS_PER_DAY) p.push('too_many_events');
  p.push(...validateKind(event, s, cat, rules));
  return p;
}

// ---- grants -------------------------------------------------------------------------------------------------

/** A grant before its own id and day are stamped on (`evaluate` adds both). */
type Draft = RewardGrant extends infer G ? (G extends RewardGrant ? Omit<G, 'id' | 'isoDay'> : never) : never;

const RANK = { seen: 0, tried: 1, yours: 2 } as const;

function certificates(before: ToolkitState, after: ToolkitState, s: FoldState, data: RewardsData, eventId: string): Draft[] {
  const out: Draft[] = [];
  for (const [technique, r] of Object.entries(after.techniques)) {
    const was = Object.hasOwn(before.techniques, technique) ? before.techniques[technique].tier : null;
    if (r.tier !== 'yours' || (was !== null && RANK[was] >= RANK.yours) || s.keys.has(key('cert', technique))) continue;
    out.push({ kind: 'certificate', technique, eventId });
    out.push(...stamps('certificate', data, eventId));
  }
  return out;
}

const stamps = (stamp: StampId, data: RewardsData, eventId: string): Draft[] =>
  Array.from({ length: data.stamps[stamp] }, () => ({ kind: 'stamp', stamp, eventId }) as const);

function trustRise(cook: string, cookWeeks: number, s: FoldState, cat: Catalogue, data: RewardsData, eventId: string): Draft[] {
  const questDone = s.questsDone.some((q) => {
    const quest = cat.quests.get(q);
    return quest !== undefined && quest.cook === cook && quest.trust >= 1;
  });
  const current = s.trust.get(cook) ?? 0;
  // At most one level per event, never past the last named level.
  if (trustLevel(cookWeeks, questDone, data) <= current || current + 1 > data.trust.names.length - 1) return [];
  return [{ kind: 'trust', cook, level: current + 1, eventId }];
}

function eventGrants(e: ProgressEvent, s: FoldState, cat: Catalogue, data: RewardsData, t: FreshnessThresholds): Draft[] {
  const out: Draft[] = [];
  const xp = (amount: number, reason: XpReason, onceKey: string | null) => {
    if (amount <= 0 || (onceKey !== null && s.keys.has(onceKey))) return;
    out.push({ kind: 'xp', amount, reason, eventId: e.id });
  };
  const before = s.toolkit;
  const after = toolkitFromEvents([e], cat, before);
  /** A new ISO cook-week for each of these cooks may lift their trust one level (Ruling 2; I3 adds stand-ins). */
  const cookWeek = (cooks: readonly string[]) => {
    for (const cook of new Set(cooks)) {
      const weeks = s.cookWeeks.get(cook) ?? new Set<string>();
      if (!weeks.has(isoWeek(e.at))) out.push(...trustRise(cook, weeks.size + 1, s, cat, data, e.id));
    }
  };
  const refreshes = (techniques: readonly string[]) => {
    for (const technique of new Set(techniques)) if (refreshDue(before, technique, e.at, t)) xp(data.xp.refresh, 'refresh', null);
  };

  switch (e.kind) {
    case 'lesson': {
      const r = cat.recipes.get(e.recipe);
      if (!r || r.sacred) return []; // spec §10: a sacred dish is outside the loop, so no grants of any kind
      xp(data.xp.lesson, 'lesson', key('lesson', e.recipe, isoWeek(e.at)));
      break;
    }
    case 'drill':
      xp(data.xp.drill, 'drill', key('drill', e.quest, e.step, isoWeek(e.at)));
      break;
    case 'cooked': {
      const r = cat.recipes.get(e.recipe);
      if (!r || r.sacred) return [];
      xp(data.xp.cook, 'cook', key('cook', e.recipe, e.at));
      refreshes(r.skills);
      cookWeek([r.cook, ...standsInFor(e)]);
      break;
    }
    case 'frame_cooked':
      xp(data.xp.frame, 'frame', key('frame', e.frame, e.at));
      refreshes([e.technique]);
      cookWeek(standsInFor(e));
      break;
    case 'quest_done': {
      const q = cat.quests.get(e.quest);
      if (!q) return [];
      if (q.xp > 0) xp(q.xp, 'quest', key('quest', e.quest));
      out.push(...stamps('quest_done', data, e.id));
      if ((s.trust.get(q.cook) ?? 0) === 0 && q.trust >= 1) out.push({ kind: 'trust', cook: q.cook, level: 1, eventId: e.id });
      break;
    }
    case 'market_run': {
      const k = key('market', isoWeek(e.at));
      if (s.keys.has(k)) break;
      xp(data.xp.market_run, 'market_run', k);
      out.push(...stamps('market_run', data, e.id));
      break;
    }
    case 'stall_round': {
      // M6 Ruling 1: XP for each answer the stall file scores correct whose question was never correct before (once
      // ever); one stamp per stall per ISO week for any accepted round, whatever the score. A wrong answer earns
      // nothing and lowers nothing.
      const stall = cat.market?.get(e.stall);
      if (stall === undefined) return [];
      for (const a of e.answers) {
        const entry = stall.questions.get(a.q);
        if (entry !== undefined && scoreAnswer(entry.question, a.pick).correct && s.marketAnswered.get(a.q)?.correct !== true)
          xp(data.xp.market_game, 'market_game', null);
      }
      if (!s.keys.has(key('stall', e.stall, isoWeek(e.at)))) out.push(...stamps('market_game', data, e.id));
      break;
    }
    case 'meal_logged': {
      // Ruling 5/6: flat, capped per day, counted on grants already made for this date (an undo never re-opens it).
      const n = data.xp.nourishment;
      // The cap counts the day's grants by their own isoDay, so an erased log still uses its slot. The gap compares
      // surviving meal-log events that earned, since a grant carries no minute (I2 ruling).
      const count = s.nourishCount.get(e.at) ?? 0;
      const earned = s.nourishMinutes.get(e.at) ?? [];
      if (count < n.max_per_day && earned.every((m) => Math.abs(m - e.minute) >= n.min_gap_minutes))
        xp(n.per_log, 'nourishment', null);
      break;
    }
    case 'imported':
      return []; // rebuilds the M3 record; grants nothing, not even a certificate
    case 'quest_step': // quest XP comes with quest_done
    case 'recognized': // its certificate, when it lifts Tried to Yours, is below
      break;
  }
  out.push(...certificates(before, after, s, data, e.id));
  return out;
}

function evaluate(
  sent: ProgressEvent,
  s: FoldState,
  cat: Catalogue,
  data: RewardsData,
  thresholds: FreshnessThresholds,
  rules: RulesContext | undefined,
): GrantResult {
  const problems = validate(sent, s, cat, rules);
  if (problems.length > 0) return { event: sent, grants: [], problems, warnings: [] };

  // A claim that doesn't hold is dropped, never the event: the cook keeps its own grants (concern-3 ruling).
  let event = sent;
  const warnings: ProgressWarning[] = [];
  if (Object.hasOwn(sent, 'standsInFor') && !claimHolds(sent, cat, rules)) {
    event = Object.fromEntries(Object.entries(sent).filter(([k]) => k !== 'standsInFor')) as unknown as ProgressEvent;
    warnings.push('stand_in_dropped');
  }

  const drafts = eventGrants(event, s, cat, data, thresholds);
  const gained = drafts.reduce((sum, g) => sum + (g.kind === 'xp' ? g.amount : 0), 0);
  // Levels come only with XP this event earned (M1): a sacred, imported or zero-XP event carries no level grant,
  // even after a retune; the catch-up waits for the next event that earns.
  if (gained > 0) {
    const reached = levelFor(s.xp + gained, data.levels);
    for (let level = s.level + 1; level <= reached; level++) drafts.push({ kind: 'level', level, eventId: event.id });
  }
  const grants = drafts.map((g, i): RewardGrant => ({ ...g, id: `${event.id}#${i}`, isoDay: event.at }));
  return { event, grants, problems: [], warnings };
}

/**
 * What one event earns, given what the history already holds (Ruling 7). Total and pure: it never throws on
 * player-shaped input. Problems non-empty → reject the event and grant nothing. It reads only the event, the
 * history, the catalogue and the data: no paid status is an input (never rule 3) and nothing reads a run of days.
 *
 * `rules` is the player's rules and content (I3): needed to keep a cook's `standsInFor` claim. Without it, or
 * when the claim doesn't hold, the claim is dropped (warning `stand_in_dropped`) and the cook earns as any cook.
 * A `stall_round` (M6) needs it too: without it the round is rejected `rules_unknown` and the caller retries.
 * Callers store the returned `event`, so a dropped claim never reaches the fold.
 *
 * Order matters (M2): each grant is fixed when written, so the same events in another order can earn a different,
 * never lower, total (meal gaps, trust weeks counted before the quest). Device and account views need not converge;
 * they are merged field-wise upward (Ruling 8).
 */
export function grantsFor(
  event: ProgressEvent,
  history: ProgressHistory,
  cat: Catalogue,
  data: RewardsData,
  thresholds: FreshnessThresholds,
  rules?: RulesContext,
): GrantResult {
  return evaluate(event, foldHistory(history, cat), cat, data, thresholds, rules);
}

/**
 * `grantsFor` over a batch, in order, each event seeing the history plus the batch's earlier accepted events and
 * their grants. Exactly the same results as calling `grantsFor` once per event and appending what was accepted,
 * but the history is folded once, so a sign-in upload of thousands of events stays fast. The daily cap is still
 * per event (C14): an event over it is rejected and the rest of the batch goes on.
 */
export function grantsForBatch(
  events: readonly ProgressEvent[],
  history: ProgressHistory,
  cat: Catalogue,
  data: RewardsData,
  thresholds: FreshnessThresholds,
  rules?: RulesContext,
): GrantResult[] {
  const s = foldHistory(history, cat);
  return events.map((sent) => {
    const r = evaluate(sent, s, cat, data, thresholds, rules);
    if (r.problems.length === 0) {
      applyEvent(s, r.event, cat);
      for (const g of r.grants) applyGrant(s, g, r.event);
    }
    return r;
  });
}
