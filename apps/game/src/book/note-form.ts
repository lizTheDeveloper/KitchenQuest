import { NOTE_TEXT_MAX, parseMarginNote, type MarginNote, type NoteOp, type ParsedRecipe } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { buildRecipeCard, type CardFinding } from '../recipes/card-model';
import { findingItem } from '../recipes/card-view';
import type { RulesState } from '../recipes/rules';
import type { PanItem } from '../mentor/reply';
import type { CardWriter } from '../mentor/writer';
import { statusChip, statusLabel } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { opText } from './book-export';
import { bookSlip, opsText } from './slips';

/**
 * Writing a margin note (M5 Step 11), for the after-cook question and the Recipe Book's "Add a note": structured
 * add / swap / leave-out chips over the recipe's own lines, a short text in the player's words (at most NOTE_TEXT_MAX),
 * then Form 2-M/MARGIN with `margin.readback` and the rules check of "cook with my notes" with this note included.
 * A clash shows `margin.blocked` with the finding before the stamp, so the player knows "cook with my notes" will
 * show ⛔. Only the tap on the slip's own button keeps anything (POST /notes, through the card writer). The draft
 * lives in this page's memory only and is never stored on the device. The canon recipe is never changed.
 */

export interface NoteFormDeps {
  writer: CardWriter;
  say(trigger: string, vars?: Record<string, string>): string;
  rules(): RulesState;
  /** The player's notes so far (any recipe: filtered here by slug, C32). */
  notes(): Promise<readonly MarginNote[]>;
  /** The 3-C card in `box`, for a 403 `consent_required` on the stamp; true once granted. */
  askConsent(box: HTMLElement): Promise<boolean>;
}

export const NOTE_EMPTY = 'There is nothing in the note yet. Add a change or a few words, or skip it.';
export const NOTE_FULL = "This dish's margin is full. Delete an older note in the Recipe Book to make room.";
export const NOT_DONE = "That didn't go through, so nothing was kept. Try again in a moment.";

/** "peanut butter contains peanut": the engine's finding in words, for `margin.blocked`. */
export function findingWords(f: Pick<CardFinding, 'ingredient' | 'path'>): string {
  const end = f.path?.split(' → ').at(-1);
  return end !== undefined && end !== f.ingredient ? `${f.ingredient} contains ${end}` : f.ingredient;
}

export const saidText = (items: readonly PanItem[]): string[] => items.flatMap((i) => (i.kind === 'said' ? [i.said.text] : []));
export const noteSummary = (n: Pick<MarginNote, 'ops' | 'text'>): string => [...n.ops.map(opText), ...(n.text === null ? [] : [n.text])].join('; ');

let seq = 0;

/**
 * The note form in `el`. `onKept` hears the stored row (its id, its undo deadline and the note); `onSkip` the player's
 * Skip. `skipLabel` names the way out.
 */
export function noteForm(el: HTMLElement, input: { slug: string; recipe: ParsedRecipe; at: string; skipLabel: string }, deps: NoteFormDeps, on: {
  kept(r: { id: string; undoUntil: string; note: MarginNote }): void; skip(): void;
}): void {
  const { slug, recipe, at } = input;
  const n = ++seq;
  const ops: NoteOp[] = [];
  const ask = contentText('p', deps.say('cook.changes_ask'), { class: 'after-cook-ask slip-readback', tabindex: -1 });
  const opList = h('ul', { class: 'note-ops' });
  const drawOps = () => {
    opList.replaceChildren(...ops.map((op, i) => {
      const rm = h('button', { type: 'button', class: 'btn btn-secondary btn-small', 'aria-label': `Remove: ${opText(op)}` }, 'Remove');
      rm.addEventListener('click', () => { ops.splice(i, 1); drawOps(); });
      return h('li', null, opText(op), ' ', rm);
    }));
  };
  const lines = recipe.ingredients.map((l) => ({ value: l.name, label: l.displayName ?? l.name }));
  const picker = h('div', { class: 'note-picker' });
  const pick = (kind: NoteOp['op']) => {
    const name = h('input', { type: 'text', id: `note-name-${n}`, maxlength: 80, autocomplete: 'off' });
    const from = h('select', { id: `note-from-${n}` }, ...lines.map((l) => h('option', { value: l.value }, l.label)));
    const go = h('button', { type: 'button', class: 'btn btn-secondary' }, kind === 'add' ? 'Add it' : kind === 'swap' ? 'Swap it' : 'Leave it out');
    go.addEventListener('click', () => {
      const v = name.value.trim();
      if (kind === 'add' && v !== '') ops.push({ op: 'add', name: v });
      else if (kind === 'swap' && v !== '') ops.push({ op: 'swap', from: from.value, to: v });
      else if (kind === 'remove') ops.push({ op: 'remove', name: from.value });
      else return;
      picker.replaceChildren();
      drawOps();
      ask.focus();
    });
    picker.replaceChildren(
      kind === 'add' ? '' : h('p', null, h('label', { for: `note-from-${n}` }, kind === 'swap' ? 'Instead of' : 'Left out'), ' ', from),
      kind === 'remove' ? '' : h('p', null, h('label', { for: `note-name-${n}` }, kind === 'add' ? 'What you added' : 'What you used'), ' ', name),
      go);
    (kind === 'remove' ? from : name).focus();
  };
  const chip = (label: string, kind: NoteOp['op']) => {
    const b = h('button', { type: 'button', class: 'chip-choice', 'data-op': kind }, label);
    b.addEventListener('click', () => pick(kind));
    return b;
  };
  const text = h('textarea', { id: `note-text-${n}`, class: 'after-cook-text note-text', maxlength: NOTE_TEXT_MAX, rows: 3 });
  const readBack = h('button', { type: 'button', class: 'btn btn-primary note-readback' }, 'Read it back');
  const skip = h('button', { type: 'button', class: 'btn btn-secondary note-skip' }, input.skipLabel);
  const status = h('p', { class: 'after-cook-status', role: 'status' });
  const box = h('div', { class: 'note-form' },
    ask,
    h('div', { class: 'chip-row', role: 'group', 'aria-label': 'Ingredient changes' }, chip('Added something', 'add'), chip('Swapped something', 'swap'), chip('Left something out', 'remove')),
    picker, opList,
    h('p', null, h('label', { for: `note-text-${n}` }, 'Or in your own words'), h('br'), text),
    h('div', { class: 'button-row' }, readBack, skip), status);
  el.append(box);
  ask.focus();
  skip.addEventListener('click', () => { box.remove(); on.skip(); });
  readBack.addEventListener('click', () => {
    const parsed = parseMarginNote(text.value, recipe, graph);
    const all = [...ops, ...parsed.ops];
    if (all.length === 0 && parsed.rest === null) { status.textContent = NOTE_EMPTY; return; }
    status.textContent = '';
    const draft: MarginNote = { recipe: slug, ops: all, text: parsed.rest, at };
    readBack.disabled = true;
    void deps.notes().catch(() => [] as MarginNote[]).then((before) => {
      readBack.disabled = false;
      box.hidden = true;
      noteCard(el, draft, before.filter((x) => x.recipe === slug), recipe, deps, {
        back: () => { box.hidden = false; ask.focus(); },
        kept: (r) => { box.remove(); on.kept(r); },
      });
    });
  });
}

/** Form 2-M: the read-back, the changes and their check, and `margin.blocked` before the stamp on a clash. */
function noteCard(el: HTMLElement, draft: MarginNote, before: readonly MarginNote[], recipe: ParsedRecipe, deps: NoteFormDeps, on: {
  back(): void; kept(r: { id: string; undoUntil: string; note: MarginNote }): void;
}): void {
  const form = content.bureau.forms.margin_note;
  const card = buildRecipeCard({ slug: draft.recipe, content, graph, rules: deps.rules(), today: draft.at.slice(0, 10), showCalories: false, notes: [...before, draft] });
  const summary = noteSummary(draft);
  const blocked = card.findings.filter((f) => f.status === 'blocked');
  const readback = [deps.say('margin.readback', { summary }), ...(blocked.length > 0 ? [deps.say('margin.blocked', { finding: blocked.map(findingWords).join(', ') })] : [])];
  const checks = h('div', { class: 'note-check' }, statusChip(card.status), ` ${statusLabel(card.status)}`,
    card.findings.length === 0 ? null : h('ul', { class: 'findings' }, ...card.findings.map(findingItem)));
  const slip = bookSlip(form, 'margin_note', readback, [
    [form.fields[0].label, recipe.meta.title],
    [form.fields[1].label, draft.text ?? '—'],
    [form.fields[2].label, opsText(draft.ops)],
    [form.fields[3].label, checks],
  ]);
  slip.el.dataset.status = card.status;
  const status = h('p', { class: 'after-cook-status', role: 'status' });
  slip.el.append(status);
  el.append(slip.el);
  slip.readback.focus();
  slip.decline.addEventListener('click', () => { slip.el.remove(); on.back(); });
  const keep = () => {
    slip.confirm.disabled = true;
    slip.decline.disabled = true;
    void deps.writer.keep({ kind: 'margin_note', note: draft, summary }).then(async (out) => {
      if (out.ok) {
        slip.close('Written in your margin.');
        // The server checks every note on the dish: an earlier note can keep "cook with my notes" ⛔ when this one doesn't.
        if (out.check?.status === 'blocked' && blocked.length === 0) {
          const words = out.check.findings.filter((f) => f.status === 'blocked').map((f) => f.ingredient).join(', ');
          slip.el.append(contentText('p', deps.say('margin.blocked', { finding: words }), { class: 'after-cook-line' }));
        }
        on.kept({ id: out.id, undoUntil: out.undoUntil, note: draft });
        return;
      }
      if (out.reason === 'busy') return;
      if (out.reason === 'consent_required') {
        const box = h('div');
        slip.el.append(contentText('p', deps.say('consent.health_first'), { class: 'after-cook-line' }), box);
        if (await deps.askConsent(box)) { keep(); return; }
      }
      slip.confirm.disabled = false;
      slip.decline.disabled = false;
      status.textContent = out.reason === 'too_many' ? NOTE_FULL : (saidText(out.items).join(' ') || NOT_DONE);
    });
  };
  slip.confirm.addEventListener('click', keep);
}
