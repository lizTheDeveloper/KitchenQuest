// The quest engine (spec §3.3, §8): a pure state machine over a quest file and a progress view. The game's runner
// (Step 9) and the API's event validation (Step 5) share it, so a quest reads the same on the device and the server.
// It decides nothing about rewards: it only says which progress events a step produces; grantsFor rewards them.
import type { IngredientGraph } from '../ingredients/graph';
import type { Catalogue, ProgressEvent, ProgressView } from '../progress/types';
import type { ParsedRecipe } from '../recipe/types';
import { check, type Substitution } from '../rules/check';
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
  /** The id of the `cooked` event the runner just recorded (the view must already include it). */
  | { type: 'cook'; cookedEventId: string };

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
}

export type AdvanceResult =
  | { ok: true; events: ProgressEvent[]; say: string[] }
  | { ok: false; reason: 'waiting' | 'not_current' | 'wrong_answer' | 'blocked' | 'already_done'; say: string[] };

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
      if (!errandAllowed(step.item, ctx)) return refuse('blocked', [...(step.adapted ?? [])]);
      events.push(stepEvent());
      say = step.lines.length > 0 ? [step.lines[step.lines.length - 1]] : [];
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
      const dates = own(p.cookedOn, step.recipe) ?? [];
      if (!dates.some((d) => d >= since && d <= at)) return refuse('not_current');
      events.push(stepEvent());
      break;
    }
  }
  if (index + 1 === q.steps.length) events.push(done());
  return { ok: true, events, say };
}
