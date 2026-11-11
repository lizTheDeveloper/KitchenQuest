import {
  advance, alternativesFor, currentStep, dishStatus, errandAllowed, questStatus,
  type AdvanceResult, type IngredientGraph, type PantryItem, type ProgressEvent, type ProgressView, type Quest, type QuestStep, type RewardGrant,
  type Rule, type StepContext, type StepInput, type Substitution,
} from '@kitchenquest/core/engine';
import { content } from '../content';
import type { ClientContent } from '../content/types';
import { stepContextOf } from '../progress/catalogue';
import { newEventId } from '../progress/log';
import { routeHref } from '../shell/router';
import { statusChip } from '../ui/chips';
import { showDialogue } from '../ui/dialogue-box';
import { contentText, h } from '../ui/dom';

export interface QuestRunnerDeps {
  /** What the game shows now (progress/view.ts `currentProgress`): read again after every record. */
  progress: () => ProgressView;
  record: (e: ProgressEvent[]) => Promise<RewardGrant[]>;
  pantry: () => PantryItem[];
  /** The player's active rules, or null while they can't be read: then an errand or a cook step waits ("can't verify" is never safe). */
  rules: () => Rule[] | null;
  graph: IngredientGraph;
  subs: Substitution[];
  today: () => string;
  signal: AbortSignal;
  /** The cook speaking the quest's lines, and the Pan's lines by trigger (content/dialogue/pan.yaml). */
  cook?: { name: string; portrait: string | null };
  pan?: { portrait: string | null; line(trigger: string, vars: Record<string, string>): string };
  reducedMotion?: boolean;
  newId?: () => string;
  content?: ClientContent;
}

const own = <T>(r: Record<string, T>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);

/** Whether the pantry already holds the errand's item (the item itself, or something the graph files under it). */
function inPantry(item: string, pantry: readonly PantryItem[], graph: IngredientGraph): boolean {
  return pantry.some((p) => p.ingredientId !== null && (p.ingredientId === item || (graph.has(p.ingredientId) && graph.ancestors(p.ingredientId).includes(item))));
}

/**
 * Run a quest's steps in `slot` with the existing dialogue box (spec §3.3): talk, travel, errand, drill, riddle,
 * recognize and cook, through core `advance`, with the full StepContext built from the player's rules, the graph,
 * the substitutions, the canon recipes and the Pantry Frames on `today` (C5). Every passed step's events go to
 * `record` in order; the grants they earn are the progress service's to announce.
 *
 * Resolves 'done' when the quest is done, 'paused' when it waits for the player: a cook step whose dish they can
 * cook (the visit then shows the recipe card), "Not yet" on an errand or drill, unreadable rules, a waiting quest
 * (C4: never started), or leaving the screen (`signal`). A wrong riddle answer shows its reaction and keeps the step,
 * with no penalty.
 */
export async function runQuest(slot: HTMLElement, q: Quest, deps: QuestRunnerDeps): Promise<'done' | 'paused'> {
  const c = deps.content ?? content;
  const newId = deps.newId ?? newEventId;
  const cook = deps.cook ?? { name: own(c.cooks, q.cook)?.name ?? q.cook, portrait: null };
  const reducedMotion = deps.reducedMotion ?? true;
  const aborted = () => deps.signal.aborted;

  const say = async (lines: string[], who: { name: string; portrait: string | null } = cook) => {
    if (lines.length === 0 || aborted()) return;
    await showDialogue(slot, { speaker: who.name, portrait: who.portrait, lines, reducedMotion, signal: deps.signal });
  };
  const panSay = async (trigger: string, vars: Record<string, string>) => {
    if (!deps.pan) return;
    await say([deps.pan.line(trigger, vars)], { name: 'The Pan', portrait: deps.pan.portrait });
  };

  /** A panel of buttons under a prompt; resolves the chosen button's index, or -1 when the screen is left. */
  const choose = (prompt: Node[], buttons: string[], extra: Node[] = []): Promise<number> =>
    new Promise((resolve) => {
      if (aborted()) { resolve(-1); return; }
      const panel = h('div', { class: 'quest-panel', role: 'group', 'aria-label': `${cook.name}'s quest` },
        contentText('p', cook.name, { class: 'quest-speaker' }), ...prompt, ...extra);
      const row = h('div', { class: 'button-row quest-choices' });
      const done = (i: number) => {
        deps.signal.removeEventListener('abort', onAbort);
        panel.remove();
        resolve(i);
      };
      const onAbort = () => done(-1);
      deps.signal.addEventListener('abort', onAbort);
      buttons.forEach((label, i) => {
        row.append(h('button', { type: 'button', class: i === 0 ? 'btn btn-primary' : 'btn btn-secondary', 'data-choice': String(i), onclick: () => done(i) }, label));
      });
      panel.append(row);
      slot.append(panel);
      row.querySelector<HTMLElement>('button')?.focus();
    });

  /** The context for a step that judges food; null while the rules can't be read. */
  const context = (): StepContext | null => {
    const rules = deps.rules();
    return rules === null ? null : stepContextOf(rules, deps.pantry(), deps.today(), deps.graph, c);
  };
  const go = async (input: StepInput, ctx: StepContext): Promise<AdvanceResult> => {
    const r = advance(q, deps.progress(), input, deps.today(), newId, ctx);
    if (r.ok) await deps.record(r.events);
    return r;
  };

  const rulesWait = async () => {
    await choose([h('p', null, "Your rules couldn't be read just now, so this step waits. Open Your rules to look them over.")], ['Later']);
    return 'paused' as const;
  };

  while (!aborted()) {
    const view = deps.progress();
    const status = questStatus(q, view);
    if (status === 'done') return 'done';
    if (status === 'waiting') return 'paused'; // C4: unlock.requires is enforced; a waiting quest is never started
    const cur = currentStep(q, view);
    // A neutral context for steps that judge no food (talk, travel, drill, riddle, recognize): no rule is consulted.
    const neutral = stepContextOf([], [], deps.today(), deps.graph, c);
    if (cur === null) {
      // Every step passed but the finish never recorded (a lost write): finish it.
      const r = await go({ type: 'talk' }, neutral);
      if (!r.ok) return 'paused';
      continue;
    }
    const step: QuestStep = cur.step;
    switch (step.type) {
      case 'talk': {
        await say(step.lines);
        if (aborted()) return 'paused';
        await go({ type: 'talk' }, neutral);
        break;
      }
      case 'travel': {
        // Satisfied on arrival: the visit screen is the place.
        const r = await go({ type: 'travel' }, neutral);
        await say(r.say);
        break;
      }
      case 'drill': {
        await say(step.lines);
        const i = await choose([contentText('p', step.prompt, { class: 'quest-prompt' })], ["I've practised it", 'Not yet']);
        if (i !== 0) return 'paused';
        await go({ type: 'drill' }, neutral);
        break;
      }
      case 'riddle': {
        let reaction: HTMLElement | null = null;
        for (;;) {
          const i = await choose(
            [contentText('p', step.prompt, { class: 'quest-prompt' })],
            step.options.map((o) => o.text),
            reaction ? [reaction] : [],
          );
          if (i < 0) return 'paused';
          const r = await go({ type: 'riddle', option: i }, neutral);
          if (r.ok) { await say(r.say); break; }
          // Educationally wrong, never a penalty: the option's reaction, and the same step again.
          reaction = contentText('p', r.say.join(' '), { class: 'quest-reaction', role: 'status' });
        }
        break;
      }
      case 'errand': {
        const ctx = context();
        if (ctx === null) return rulesWait();
        if (!errandAllowed(step.item, ctx)) {
          // A player's rules never lock them out of progress: the step passes as adapted, with the same rewards.
          const r = await go({ type: 'errand', have: 'tapped' }, ctx);
          if (!r.ok) return 'paused';
          if (r.say.length > 0) await say(r.say);
          else if (r.adapted?.trigger) await panSay(r.adapted.trigger, { cook: cook.name });
          const swap = r.adapted?.swap ?? null;
          if (swap) {
            // A labelled swap the rules engine itself passed (✅ for this player today); nothing unverifiable.
            const card = h('div', { class: 'quest-swap', role: 'group', 'aria-label': 'Swap' },
              h('p', { class: 'swap-label' }, 'Swap, checked against your rules'),
              contentText('p', swap.name, { class: 'swap-name' }),
              swap.note ? contentText('p', swap.note, { class: 'swap-note' }) : null);
            if ((await choose([], ['Continue'], [card])) < 0) return 'paused';
          }
          break;
        }
        const sending = step.lines.slice(0, -1);
        await say(sending);
        if (aborted()) return 'paused';
        if (inPantry(step.item, deps.pantry(), deps.graph)) {
          const r = await go({ type: 'errand', have: 'pantry' }, ctx);
          await say(r.say);
          break;
        }
        const name = deps.graph.has(step.item) ? deps.graph.get(step.item).name : step.item;
        const i = await choose([h('p', { class: 'quest-prompt' }, 'Fetch: ', contentText('span', name))], ["I've got it", 'Not yet']);
        if (i !== 0) return 'paused';
        const r = await go({ type: 'errand', have: 'tapped' }, ctx);
        await say(r.say);
        break;
      }
      case 'recognize': {
        const r = await go({ type: 'recognize' }, neutral);
        if (!r.ok) return 'paused';
        if (r.events.some((e) => e.kind === 'recognized')) {
          await panSay('quest.recognize', { technique: techniqueTitle(step.technique, c), cook: cook.name });
        }
        await say(r.say);
        break;
      }
      case 'cook': {
        const ctx = context();
        if (ctx === null) return rulesWait();
        // A cook already done since the quest started (the cook screen advances this step when it finishes).
        const r = advance(q, deps.progress(), { type: 'cook', cookedEventId: '' }, deps.today(), newId, ctx);
        if (r.ok) { await deps.record(r.events); break; }
        if (dishStatus(step.recipe, ctx) !== 'blocked') return 'paused'; // cookable (✅, a swap, or ❓ with its labels checked): the card
        const alternatives = alternativesFor(step, ctx);
        const dish = own(c.recipes, step.recipe)?.meta.title ?? step.recipe;
        if (alternatives.length > 0) {
          // Same Hands, Different Kitchen: any of these, cooked, completes the step. ✅ or a labelled swap only.
          const list = h('ul', { class: 'quest-alternatives' }, ...alternatives.map((a) => {
            if (a.kind === 'recipe') {
              const title = own(c.recipes, a.slug)?.meta.title ?? a.slug;
              return h('li', null, statusChip(a.status), ' ', h('a', { href: routeHref({ name: 'recipe', slug: a.slug }) }, contentText('span', title)));
            }
            const frame = c.frames.find((f) => f.id === a.id);
            return h('li', null, statusChip(a.status), ' ', contentText('span', frame?.title ?? a.id));
          }));
          await choose([h('p', { class: 'quest-prompt' }, contentText('span', dish), " isn't cookable with your rules. Cooking one of these practises the same technique, and counts for this step:")], ['Continue'], [list]);
          return 'paused';
        }
        // Nothing else passes the rules: the adapted lesson (Seen, never Tried), with the same quest rewards.
        if (deps.pan) await panSay('quest.cook_adapted', { cook: cook.name });
        const i = await choose([h('p', { class: 'quest-prompt' }, contentText('span', dish), " isn't cookable with your rules.")], ['Learn it as a lesson', 'Not yet']);
        if (i !== 0) return 'paused';
        const lesson = await go({ type: 'cook', lesson: true }, ctx);
        if (!lesson.ok) return 'paused';
        break;
      }
    }
  }
  return 'paused';
}

function techniqueTitle(id: string, c: ClientContent): string {
  return c.techniques.techniques.find((t) => t.id === id)?.name ?? id;
}

/**
 * After cook mode records `cooked` (or a frame cook): the events of every quest whose current step is a cook step
 * that this cook completes (its dish, or a stand-in when the rules block it), via core `advance`.
 */
export function cookStepEvents(quests: readonly Quest[], view: ProgressView, today: string, ctx: StepContext, newId: () => string = newEventId): ProgressEvent[] {
  const out: ProgressEvent[] = [];
  for (const q of quests) {
    const status = questStatus(q, view);
    if (status !== 'in_progress' && status !== 'open') continue;
    if (currentStep(q, view)?.step.type !== 'cook') continue;
    const r = advance(q, view, { type: 'cook', cookedEventId: '' }, today, newId, ctx);
    if (r.ok) out.push(...r.events);
  }
  return out;
}
