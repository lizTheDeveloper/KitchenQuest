import {
  buildMealCard, parseCookedFor, slotForTime,
  type CookedFor, type CookedForCount, type CookedForWho, type MarginNote, type MealSlot, type ParsedRecipe, type ProgressEvent,
} from '@kitchenquest/core/engine';
import { content } from '../content';
import type { RulesState } from '../recipes/rules';
import type { Dialogue } from '../mentor/dialogue';
import type { CardWriter, KeepOutcome } from '../mentor/writer';
import { newEventId } from '../progress/log';
import { contentText, h } from '../ui/dom';
import { NOT_DONE, noteForm, saidText } from '../book/note-form';
import { COUNT_CHIPS, WHO_CHIPS, bookSlip, chipGroup, cookedForSummary, cookedForWords, undoButton } from '../book/slips';

/**
 * After cook mode (M5 Step 11): three optional questions, in order, each a card or chips and each skippable with one
 * tap, never a gate. 1 "Who ate with you?" (Cooked for Someone), 2 "Did you change anything?" (a margin note) and
 * 3 "Log it?" (spec §5's one-tap log, M4 deferral C25). "Back to the kitchen" ends it at any point, writing nothing
 * more. Skipping writes nothing and costs nothing; answering earns nothing either (Cooked for Someone and notes feed
 * no reward, M-9), except the meal log's flat nourishment, which core computes from the `meal_logged` event and the
 * game never shows as a number (Ruling 5).
 *
 * - Family Table (§19, Ruling 25, C31): nothing is asked and nothing is kept. The flow ends at once.
 * - Signed out: there is nowhere to keep any of it. Cooked for Someone is skipped silently; the other two say plainly
 *   that they need an account (`margin.needs_account`, `log.needs_account`), with no control to press.
 * - Without `health_data` (notes and meal logs are health data): `consent.health_first` and the 3-C card come first.
 * - A sacred dish takes none of this (§10); a frame takes no margin note (audit M-5).
 * - Typed answers live in this page's memory only and are read by core into fixed values (cooked-for) or ops (notes);
 *   a name typed into "Who ate with you?" is dropped before the card is built and never leaves the device.
 */

export interface AfterCookInput {
  slug: string | null; frame: string | null; recipe: ParsedRecipe;
  /** The player's local date (YYYY-MM-DD) the dish was cooked on. */
  at: string;
}
export interface AfterCookDeps {
  writer: CardWriter;
  record: (events: ProgressEvent[]) => Promise<unknown>;
  signedIn: () => boolean;
  familyTable: () => boolean;
  healthConsent: () => 'granted' | 'reconsent' | 'missing';
  dialogue: Dialogue;
  now: () => Date;
  /** The player's rules now: a margin note's read-back is checked against them before the stamp. */
  rules: () => RulesState;
  /** The player's notes on this dish so far (one GET /notes, filtered here by slug, C32), or [] when unknown. */
  notes: () => Promise<MarginNote[]>;
  /** Show the 3-C health consent card in `slot`; true once the player granted it, false on "Not now" or a failure. */
  askConsent: (slot: HTMLElement) => Promise<boolean>;
}

const LEAVE = 'Back to the kitchen';
const NOT_READ = "I couldn't read that as who ate. Tap a choice instead; nothing typed is kept.";
const SERVINGS: readonly { value: number; label: string }[] = [{ value: 0.5, label: '½' }, { value: 1, label: '1' }, { value: 2, label: '2' }];

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Runs the after-cook questions in `slot`. Resolves when the player is done ("Back to the kitchen"), or at once when nothing is asked. */
export function afterCook(slot: HTMLElement, input: AfterCookInput, deps: AfterCookDeps): Promise<void> {
  const { recipe, slug, frame, at } = input;
  if (deps.familyTable() || recipe.meta.sacred || (slug === null && frame === null)) return Promise.resolve();
  const say = (trigger: string, vars: Record<string, string> = {}) => deps.dialogue.say(trigger, vars).text;
  const dish = slug !== null ? recipe.meta.title : (content.frames.find((f) => f.id === frame)?.title ?? recipe.meta.title);

  return new Promise<void>((resolve) => {
    const steps = h('div', { class: 'after-cook-steps' });
    const leave = h('button', { type: 'button', class: 'btn btn-secondary after-cook-leave' }, LEAVE);
    slot.replaceChildren(h('section', { class: 'after-cook', 'aria-labelledby': 'after-cook-title' },
      h('h1', { id: 'after-cook-title', tabindex: -1 }, `After the cooking: ${dish}`), steps, h('div', { class: 'button-row' }, leave)));
    leave.addEventListener('click', () => resolve());

    const section = (title: string): HTMLElement => {
      const el = h('section', { class: 'after-cook-step' }, h('h2', null, title));
      steps.append(el);
      return el;
    };
    const focus = (el: HTMLElement) => { el.focus(); };
    const lineEls = (texts: readonly string[]) => texts.map((t) => contentText('p', t, { class: 'after-cook-line' }));
    const undo = (until: string, run: () => Promise<boolean>, where: HTMLElement) => { where.append(undoButton(until, deps.now, run)); };

    /** Step 1: Cooked for Someone. Signed out it is skipped without a word. */
    const whoAte = (next: () => void) => {
      if (!deps.signedIn()) { next(); return; }
      const el = section('Who ate with you?');
      let count: CookedForCount | null = null;
      let who: CookedForWho | null = null;
      const form = content.bureau.forms.cooked_for;
      const countBox = h('div');
      const whoBox = h('div');
      const draw = () => {
        countBox.replaceChildren(chipGroup('How many ate', COUNT_CHIPS, count, (v) => { count = v; if (count === 'just_me') who = null; draw(); refresh(); }));
        whoBox.replaceChildren(count === null || count === 'just_me' ? '' : chipGroup('Who (optional)', WHO_CHIPS, who, (v) => { who = v; refresh(); }, true));
      };
      const typed = h('input', { type: 'text', id: 'cooked-for-text', class: 'after-cook-text', maxlength: 120, autocomplete: 'off' });
      const read = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Read it');
      const note = h('p', { class: 'after-cook-status', role: 'status' });
      read.addEventListener('click', () => {
        const parsed = parseCookedFor(typed.value);
        typed.value = ''; // whatever was typed (a name included) goes now; only fixed values are kept below
        if (parsed === null) { note.textContent = NOT_READ; return; }
        note.textContent = '';
        count = parsed.count;
        who = parsed.who;
        draw();
        refresh();
      });
      const values = (): [string, string][] => {
        const w = count === null ? { count: 'Not chosen yet', who: 'Not said' } : cookedForWords({ count, who });
        return [[form.fields[0].label, w.count], [form.fields[1].label, w.who]];
      };
      const slip = bookSlip(form, 'cooked_for', [say('cook.who_ate')], values());
      const dd = slip.el.querySelectorAll<HTMLElement>('.bureau-value');
      const refresh = () => {
        const v = values();
        dd[0].textContent = v[0][1];
        dd[1].textContent = v[1][1];
        slip.confirm.disabled = count === null;
      };
      const pickers = h('div', { class: 'after-cook-pickers' },
        countBox, whoBox,
        h('p', null, h('label', { for: 'cooked-for-text' }, 'Or say it in a few words (no names are kept)'), ' ', typed, ' ', read), note);
      slip.readback.after(pickers);
      draw();
      refresh();
      el.append(slip.el);
      focus(slip.readback);
      slip.decline.addEventListener('click', () => { slip.close('Skipped. Nothing was kept.'); next(); });
      slip.confirm.addEventListener('click', () => {
        if (count === null) return;
        const cookedFor: CookedFor = { count, who };
        const card = { kind: 'cooked_for' as const, entry: { cookedOn: at, recipe: slug, frame: slug === null ? frame : null, cookedFor }, summary: cookedForSummary(cookedFor) };
        slip.confirm.disabled = true;
        slip.decline.disabled = true;
        void deps.writer.keep(card).then((out: KeepOutcome) => {
          if (!out.ok) {
            if (out.reason === 'busy') return;
            slip.confirm.disabled = false;
            slip.decline.disabled = false;
            note.textContent = saidText(out.items).join(' ') || NOT_DONE;
            return;
          }
          for (const p of pickers.querySelectorAll('button, input')) (p as HTMLButtonElement).disabled = true;
          slip.close('Stamped.');
          const lines = lineEls(saidText(out.items));
          el.append(...lines);
          undo(out.undoUntil, async () => (await deps.writer.unkeep('cooked_for', out.id)) === 'undone', el);
          next();
        });
      });
    };

    /** The consent card first, when it's missing; resolves true once there is consent. */
    const withConsent = async (el: HTMLElement): Promise<boolean> => {
      if (deps.healthConsent() === 'granted') return true;
      el.append(...lineEls([say('consent.health_first')]));
      const box = h('div');
      el.append(box);
      return deps.askConsent(box);
    };

    /** Step 2: a margin note. Never for a frame or a sacred dish; account-only; health data. */
    const changes = (next: () => void) => {
      if (slug === null) { next(); return; }
      const el = section('Did you change anything?');
      if (!deps.signedIn()) { el.append(...lineEls([say('margin.needs_account')])); next(); return; }
      void withConsent(el).then((granted) => {
        if (!granted) { next(); return; }
        noteFormIn(el, next);
      });
    };

    const noteFormIn = (el: HTMLElement, next: () => void) => {
      noteForm(el, { slug: slug!, recipe, at, skipLabel: 'Skip' }, { writer: deps.writer, say, rules: deps.rules, notes: deps.notes, askConsent: deps.askConsent }, {
        skip: () => { el.append(h('p', { class: 'after-cook-status' }, 'Skipped. Nothing was kept.')); next(); },
        kept: (r) => {
          undo(r.undoUntil, async () => (await deps.writer.unkeep('margin_note', r.id)) === 'undone', el);
          next();
        },
      });
    };

    /** Step 3: the one-tap log (spec §5). Account-only; health data. */
    const logIt = (next: () => void) => {
      const el = section('Log it?');
      if (!deps.signedIn()) { el.append(...lineEls([say('log.needs_account')])); next(); return; }
      void withConsent(el).then((granted) => {
        if (!granted) { next(); return; }
        logCard(el, next);
      });
    };

    const logCard = (el: HTMLElement, next: () => void) => {
      const form = content.bureau.forms.meal_log;
      const mealSlot: MealSlot = slotForTime(clock(deps.now()));
      let servings = 1;
      const build = () => (slug !== null
        ? buildMealCard({ eatenOn: at, slot: mealSlot, dish: { slug, title: recipe.meta.title, servings } })
        : buildMealCard({ eatenOn: at, slot: mealSlot, description: dish }));
      const servingsRow = chipGroup('How much', SERVINGS, servings, (v) => { servings = v ?? 1; summaryEl.textContent = build().summary; });
      const summaryEl = h('span', { class: 'bureau-value' }, build().summary);
      const field = (k: string) => form.fields.find((f) => f.key === k)?.label ?? k;
      const slip = bookSlip(form, 'meal', [say('log.dish_offer', { dish })], [
        [field('meal'), mealSlot.charAt(0).toUpperCase() + mealSlot.slice(1)],
        [field('summary'), summaryEl],
        ...(slug !== null ? [[field('servings'), servingsRow] as [string, Node]] : []),
      ], false);
      slip.decline.textContent = 'Not now';
      el.append(slip.el);
      focus(slip.readback);
      const status = h('p', { class: 'after-cook-status', role: 'status' });
      slip.el.append(status);
      slip.decline.addEventListener('click', () => { slip.close('Not logged. That costs nothing.'); next(); });
      const log = () => {
        const card = build();
        slip.confirm.disabled = true;
        slip.decline.disabled = true;
        const view = { origin: 'local' as const, localId: crypto.randomUUID(), card, issuedTurn: 0 };
        const minute = deps.now().getHours() * 60 + deps.now().getMinutes();
        void deps.writer.confirm(view, 'tap').then(async (out) => {
          if (out.ok) {
            for (const b of servingsRow.querySelectorAll('button')) b.disabled = true;
            slip.close('Logged.');
            // Core computes the nourishment from this event (Ruling 5); no number is ever shown.
            void deps.record([{ id: newEventId(), kind: 'meal_logged', at, minute, mealLogId: out.trail.id }]).catch((err: unknown) => { console.error(err); });
            el.append(...lineEls(saidText(out.items)));
            // Undo is DELETE /meals/:id only: the server erases the progress event with the log (Step 5 I1).
            undo(out.trail.undoUntil, async () => (await deps.writer.undo(out.trail)).status === 'undone', el);
            next();
            return;
          }
          if (out.reason === 'busy') return;
          if (out.reason === 'consent_required') {
            const box = h('div');
            el.append(...lineEls([say('consent.health_first')]), box);
            if (await deps.askConsent(box)) { slip.confirm.disabled = false; slip.decline.disabled = false; return; }
          }
          slip.confirm.disabled = false;
          slip.decline.disabled = false;
          status.textContent = saidText(out.items).join(' ') || NOT_DONE;
        });
      };
      slip.confirm.addEventListener('click', log);
    };

    const done = () => { leave.focus(); };
    whoAte(() => changes(() => logIt(done)));
  });
}
