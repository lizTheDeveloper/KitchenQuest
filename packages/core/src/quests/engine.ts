// The quest engine (spec §3.3, §8): a pure state machine over a quest file and a progress view. The game's runner
// (Step 9) and the API's event validation (Step 5) share it, so a quest reads the same on the device and the server.
// It decides nothing about rewards: it only says which progress events a step produces; grantsFor rewards them.
import type { IngredientGraph } from '../ingredients/graph';
import type { Catalogue, ProgressEvent, ProgressView } from '../progress/types';
import type { ParsedRecipe } from '../recipe/types';
import { check, type CheckStatus, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';
import { recognizedCook } from '../toolkit/toolkit';
import type { Quest, QuestStep } from './types';

/**
 * waiting = a quest named in `unlock.requires` is not done; enforced (C4, Ruling 3). `unlock.trust` is advisory and
 * never changes the status.
 */
export type QuestStatus = 'waiting' | 'open' | 'in_progress' | 'done';

const own = <T>(r: Record<string, T>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);
const stepsDone = (q: Quest, p: ProgressView): number => own(p.questSteps, q.id) ?? 0;

export function questStatus(q: Quest, p: ProgressView): QuestStatus {
  if (p.questsDone.includes(q.id)) return 'done';
  if (q.unlock.requires.some((r) => !p.questsDone.includes(r))) return 'waiting';
  return stepsDone(q, p) > 0 ? 'in_progress' : 'open';
}

/**
 * The step the player is on (0-based `index`), whatever the status: a waiting quest's first step is current but
 * `advance` refuses it. null once the quest is done or every step is passed.
 */
export function currentStep(q: Quest, p: ProgressView): { index: number; step: QuestStep } | null {
  if (p.questsDone.includes(q.id)) return null;
  const index = stepsDone(q, p);
  return index < q.steps.length ? { index, step: q.steps[index] } : null;
}

export type StepInput =
  | { type: 'talk' | 'travel' }
  | { type: 'riddle'; option: number }
  | { type: 'drill' }
  /** Ruling 16: the item is in the pantry, ticked on this week's list, or the player tapped "I've got it". */
  | { type: 'errand'; have: 'pantry' | 'ticked' | 'tapped' }
  | { type: 'recognize' }
  /** The id of the `cooked` / `frame_cooked` event the runner just recorded (the view must already include it). */
  | { type: 'cook'; cookedEventId: string }
  /** The adapted lesson, allowed only when the rules block the dish and no alternative exists (concern-1 ruling). */
  | { type: 'cook'; lesson: true };

/**
 * What a step needs beyond the quest and the view (C5): the player's rules for an errand's item on `today`, and the
 * recipes' cooks for a recognize step.
 */
export interface StepContext {
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  today: string;
  cat: Pick<Catalogue, 'recipes'>;
  /** Every canon recipe (all taught, Ruling 3), for checking a cook step's dish and its alternatives. */
  recipes: ReadonlyMap<string, ParsedRecipe>;
  /**
   * Pantry Frames the player could cook, each with its technique and its rules status today as the frame engine
   * (Step 3) works it out with `check`. Optional until frames exist; only 'ok' and 'swap' frames are ever offered.
   */
  frames?: readonly FrameOption[];
}

export interface FrameOption {
  id: string;
  technique: string;
  status: CheckStatus;
}

/** A dish that can stand in for a rule-blocked quest dish: never ⛔ or ❓. */
export type CookAlternative =
  | { kind: 'recipe'; slug: string; status: 'ok' | 'swap' }
  | { kind: 'frame'; id: string; status: 'ok' | 'swap' };

/** The Pan trigger for a quest cook step completed as an adapted lesson (content/dialogue/pan.yaml). */
export const COOK_ADAPTED_TRIGGER = 'quest.cook_adapted';

/**
 * How a quest cook step whose dish the rules block was completed (concern-1 ruling): through `via`, a cooked
 * alternative, or, when the catalogue has none, as an adapted lesson (`via` null, `trigger` set). Same quest rewards.
 */
export interface CookAdapted {
  recipe: string;
  via: CookAlternative | null;
  trigger: typeof COOK_ADAPTED_TRIGGER | null;
}

/** The Pan trigger a rule-adapted errand speaks when the cook file has no `adapted` lines (content/dialogue/pan.yaml). */
export const ERRAND_ADAPTED_TRIGGER = 'quest.errand_adapted';

/**
 * How a rule-blocked errand was completed (concern-3 ruling: a player's rules never lock them out of progress). The
 * step passes with the same events, so the same rewards, as the normal path. `trigger` is set when the cook file has
 * no `adapted` lines and the game speaks the Pan's scripted fallback instead. `swap` is a curated swap for the item
 * that the rules engine itself passes (✅ for this player today), or null: nothing unverifiable is ever suggested.
 */
export interface ErrandAdapted {
  item: string;
  trigger: typeof ERRAND_ADAPTED_TRIGGER | null;
  swap: { id: string; name: string; note?: string } | null;
}

export type AdvanceResult =
  | { ok: true; events: ProgressEvent[]; say: string[]; adapted?: ErrandAdapted; cook?: CookAdapted }
  | { ok: false; reason: 'waiting' | 'not_current' | 'wrong_answer' | 'already_done'; say: string[] };

/** A one-line recipe holding just `item`, so the rules engine judges a market errand like any dish. */
function itemRecipe(name: string): ParsedRecipe {
  return {
    meta: { title: name, country: '', region: '', credit: '', cook: '', difficulty: 1, skills: [], servings: 1, license: '', status: 'draft', sacred: false, contributors: [] },
    ingredients: [{ name, displayName: null, quantity: null, unit: null, note: null }],
    timers: [],
    steps: [],
    source: '',
  };
}

/**
 * Whether the player may fetch ingredient `item` today. Only ✅ passes: a ⛔ item, an item with only a swap (the
 * item itself still matches a rule), and a ❓ item (unknown, label-dependent) are all blocked, since "can't verify"
 * is never safe (spec §2.2).
 */
export function errandAllowed(item: string, ctx: StepContext): boolean {
  if (!ctx.graph.has(item)) return false;
  return check(itemRecipe(ctx.graph.get(item).name), ctx.rules, ctx.graph, ctx.subs, ctx.today).status === 'ok';
}

/**
 * The swap to fetch instead of a blocked `item`: the rules engine's own swap (check status 'swap', the same swap on
 * every finding), kept only if the swapped-in ingredient is itself ✅ for these rules today. Otherwise null.
 */
function errandSwap(item: string, ctx: StepContext): ErrandAdapted['swap'] {
  if (!ctx.graph.has(item)) return null;
  const r = check(itemRecipe(ctx.graph.get(item).name), ctx.rules, ctx.graph, ctx.subs, ctx.today);
  if (r.status !== 'swap') return null;
  const swaps = r.findings.map((f) => f.swap);
  const first = swaps[0];
  if (!first || swaps.some((sw) => sw?.toId !== first.toId)) return null;
  if (!errandAllowed(first.toId, ctx)) return null;
  return first.note === undefined ? { id: first.toId, name: first.toName } : { id: first.toId, name: first.toName, note: first.note };
}

/** The rules status of a quest dish today; a recipe missing from `ctx.recipes` can't be verified. */
export function dishStatus(slug: string, ctx: StepContext): CheckStatus {
  const r = ctx.recipes.get(slug);
  return r ? check(r, ctx.rules, ctx.graph, ctx.subs, ctx.today).status : 'unverified';
}

const passes = (s: CheckStatus): s is 'ok' | 'swap' => s === 'ok' || s === 'swap';

/**
 * What can stand in for a cook step's dish: every other non-sacred recipe, and every frame, that practises one of
 * the dish's techniques (its `skills`) and whose rules check today is ✅ or a labelled swap. Recipes by slug, then
 * frames by id. ⛔ and ❓ are never listed. Meant for when `dishStatus` of the step's own dish is ⛔ or ❓.
 */
export function alternativesFor(step: Extract<QuestStep, { type: 'cook' }>, ctx: StepContext): CookAlternative[] {
  const skills = new Set(ctx.recipes.get(step.recipe)?.meta.skills ?? []);
  const out: CookAlternative[] = [];
  for (const slug of [...ctx.recipes.keys()].sort()) {
    const r = ctx.recipes.get(slug)!;
    if (slug === step.recipe || r.meta.sacred || !r.meta.skills.some((t) => skills.has(t))) continue;
    const status = check(r, ctx.rules, ctx.graph, ctx.subs, ctx.today).status;
    if (passes(status)) out.push({ kind: 'recipe', slug, status });
  }
  for (const f of [...(ctx.frames ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (skills.has(f.technique) && passes(f.status)) out.push({ kind: 'frame', id: f.id, status: f.status });
  }
  return out;
}

/** The other cook from whom the player has `technique` at Tried (audit M-3), or null. */
export function recognizedFrom(technique: string, quest: Quest, p: ProgressView, cat: Pick<Catalogue, 'recipes'>): string | null {
  return recognizedCook(p.toolkit, technique, quest.cook, cat);
}

const refuse = (reason: Extract<AdvanceResult, { ok: false }>['reason'], say: string[] = []): AdvanceResult => ({ ok: false, reason, say });

/**
 * Pass the current step with `input`. On success, the events to record in order: the step's `quest_step` (1-based
 * `step`), then its `drill` or `recognized` event, then `quest_done` after the last step. A refusal records nothing:
 * a wrong riddle answer keeps the player on the step with that option's reaction, never a penalty.
 *
 * `say` is what the cook says in answer: a travel step's arrival lines, a riddle's reaction and explanation, an
 * errand's return line (its last line), a recognize step's `lines` or `otherwise`; talk, drill and cook steps' own
 * lines belong to the step itself (`currentStep`), so they say nothing more here.
 *
 * An errand whose item the player's rules block (⛔, swap-only or ❓) is never a dead end: it passes through the
 * adapted path with the same events, and `adapted` says how (the cook's `adapted` lines in `say`, else the Pan
 * trigger, plus a rules-safe swap when one exists).
 */
export function advance(q: Quest, p: ProgressView, input: StepInput, at: string, newId: () => string, ctx: StepContext): AdvanceResult {
  const status = questStatus(q, p);
  if (status === 'done') return refuse('already_done');
  if (status === 'waiting') return refuse('waiting');

  const index = stepsDone(q, p);
  const events: ProgressEvent[] = [];
  const done = (): ProgressEvent => ({ id: newId(), kind: 'quest_done', at, quest: q.id });
  if (index >= q.steps.length) {
    // Every step passed but quest_done never recorded (a lost write): finishing is all that is left.
    return { ok: true, events: [done()], say: [] };
  }
  const step = q.steps[index];
  if (input.type !== step.type) return refuse('not_current');

  const stepEvent = (): ProgressEvent => ({ id: newId(), kind: 'quest_step', at, quest: q.id, step: index + 1 });
  let say: string[] = [];
  let adapted: ErrandAdapted | undefined;
  let cook: CookAdapted | undefined;
  switch (step.type) {
    case 'talk':
      events.push(stepEvent());
      break;
    case 'travel':
      events.push(stepEvent());
      say = [...step.lines];
      break;
    case 'riddle': {
      const option = input.type === 'riddle' && Number.isInteger(input.option) ? step.options[input.option] : undefined;
      if (!option) return refuse('wrong_answer');
      if (!option.correct) return refuse('wrong_answer', [option.reaction]);
      events.push(stepEvent());
      say = [option.reaction, step.explain];
      break;
    }
    case 'drill':
      events.push(stepEvent(), { id: newId(), kind: 'drill', at, quest: q.id, step: index + 1, technique: step.skill });
      break;
    case 'errand':
      events.push(stepEvent());
      if (!errandAllowed(step.item, ctx)) {
        const lines = step.adapted ?? [];
        adapted = { item: step.item, trigger: lines.length > 0 ? null : ERRAND_ADAPTED_TRIGGER, swap: errandSwap(step.item, ctx) };
        say = [...lines];
      } else say = step.lines.length > 0 ? [step.lines[step.lines.length - 1]] : [];
      break;
    case 'recognize': {
      const from = recognizedFrom(step.technique, q, p, ctx.cat);
      events.push(stepEvent());
      if (from !== null) events.push({ id: newId(), kind: 'recognized', at, quest: q.id, technique: step.technique });
      say = [...(from !== null ? step.lines : step.otherwise)];
      break;
    }
    case 'cook': {
      // A cook counts only from the day the quest started (its first quest_step; today if this is that step).
      const since = own(p.questStartedOn, q.id) ?? at;
      const cookedSince = (dates: string[] | undefined) => (dates ?? []).some((d) => d >= since && d <= at);
      const lesson = input.type === 'cook' && 'lesson' in input;
      const status = dishStatus(step.recipe, ctx);
      // The quest's own dish, really cooked since the quest started, counts unless the rules block it: a ❓ dish is
      // cookable once the player has checked the labels (I2 ruling), so its cook completes the step too.
      if (status !== 'blocked' && !lesson && cookedSince(own(p.cookedOn, step.recipe))) {
        events.push(stepEvent());
        break;
      }
      if (passes(status)) return refuse('not_current');
      // ⛔, or ❓ and not cooked: a player's rules never lock them out of progress (concern-1 ruling).
      const alternatives = alternativesFor(step, ctx);
      if (alternatives.length > 0) {
        if (lesson) return refuse('not_current');
        const via = alternatives.find((a) => cookedSince(a.kind === 'recipe' ? own(p.cookedOn, a.slug) : own(p.framesCookedOn, a.id)));
        if (!via) return refuse('not_current');
        events.push(stepEvent());
        cook = { recipe: step.recipe, via, trigger: null };
        break;
      }
      if (!lesson) return refuse('not_current');
      // The adapted lesson: a read-through of the dish (Seen, never Tried: tiers come only from real cooking).
      events.push(stepEvent(), { id: newId(), kind: 'lesson', at, recipe: step.recipe });
      cook = { recipe: step.recipe, via: null, trigger: COOK_ADAPTED_TRIGGER };
      break;
    }
  }
  if (index + 1 === q.steps.length) events.push(done());
  return { ok: true, events, say, ...(adapted ? { adapted } : {}), ...(cook ? { cook } : {}) };
}
