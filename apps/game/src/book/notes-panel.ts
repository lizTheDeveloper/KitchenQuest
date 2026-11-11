import { UNDO_WINDOW_MS, type MarginNote, type ParsedRecipe } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { buildRecipeCard } from '../recipes/card-model';
import { findingItem } from '../recipes/card-view';
import { statusChip, statusLabel } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { noteText } from './book-export';
import type { BookNote } from './book-model';
import { findingWords, noteForm, type NoteFormDeps } from './note-form';
import { undoButton } from './slips';

/**
 * "Your margin notes" on a Recipe Book page (M5 Step 11): the player's notes under the canon text, which is never
 * edited (audit M-5); "Add a note" (Form 2-M, by tap); delete with an M4-style undo, which never touches XP (notes
 * feed no reward); and "Cook with my notes", checked by core `checkWithNotes`: ⛔ keeps it off with the finding,
 * ❓ is shown as ❓, never as fine. Signed out there are no notes: `margin.needs_account` says so.
 */

export interface NotesPanelDeps extends NoteFormDeps {
  signedIn: boolean;
  now: () => Date;
  today: () => string;
  /** Cook this dish with these notes applied (cook mode, by tap). */
  cook: (notes: readonly MarginNote[]) => void;
}

const NONE = 'No margin notes on this dish yet.';
const DELETED = 'Note deleted.';
const DELETE_FAILED = "That didn't go through, so the note is still here. Try again in a moment.";

export const fmtDate = (d: string): string => {
  const t = new Date(`${d.slice(0, 10)}T12:00:00`);
  return Number.isNaN(t.getTime()) ? d.slice(0, 10) : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** A Delete button's name tells notes of one day apart (M7): the date and the note's first words. */
const firstWords = (t: string): string => { const w = t.split(/\s+/).slice(0, 6).join(' '); return w.length < t.length ? `${w}…` : w; };

const DAY_MS = 86_400_000;
/** A deleted note put back by its undo keeps its date when the server still accepts it (within a day of today), else today. */
export function restoredAt(at: string, today: string): string {
  const d = Date.parse(`${at.slice(0, 10)}T00:00:00Z`), t = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(d) && Math.abs(d - t) <= DAY_MS ? at : today;
}

export function notesPanel(el: HTMLElement, input: { slug: string; recipe: ParsedRecipe; notes: readonly BookNote[] }, deps: NotesPanelDeps): void {
  const { slug, recipe } = input;
  let notes: BookNote[] = input.notes.filter((n) => n.recipe === slug);
  const form = content.bureau.forms.margin_note;
  const list = h('ul', { class: 'book-notes' });
  const status = h('div', { class: 'book-notes-status', role: 'status' });
  const cookBox = h('div', { class: 'cook-with-notes' });
  const addBox = h('div', { class: 'book-note-add' });
  const heading = h('h2', { id: 'book-notes-title', tabindex: -1 }, 'Your margin notes');
  el.replaceChildren(h('section', { class: 'book-notes-panel', 'aria-labelledby': 'book-notes-title' },
    heading,
    form.footnotes?.[0] ? contentText('p', form.footnotes[0], { class: 'bureau-footnote' }) : null,
    list, status, addBox, cookBox));

  const drawCook = () => {
    if (notes.length === 0) { cookBox.replaceChildren(); return; }
    const card = buildRecipeCard({ slug, content, graph, rules: deps.rules(), today: deps.today(), showCalories: false, notes });
    const button = h('button', { type: 'button', class: 'btn btn-primary cook-with-notes-go' }, 'Cook with my notes');
    const blocked = card.findings.filter((f) => f.status === 'blocked');
    button.disabled = !card.cookable;
    button.addEventListener('click', () => { if (card.cookable) deps.cook(notes); });
    cookBox.replaceChildren(
      h('h3', null, 'Cook with my notes'),
      h('p', { class: 'note-check', 'data-status': card.status }, statusChip(card.status), ` ${statusLabel(card.status)}`),
      card.findings.length === 0 ? '' : h('ul', { class: 'findings' }, ...card.findings.map(findingItem)),
      blocked.length === 0 ? '' : contentText('p', deps.say('margin.blocked', { finding: blocked.map(findingWords).join(', ') }), { class: 'after-cook-line' }),
      h('div', { class: 'button-row' }, button));
  };

  const drawList = () => {
    if (notes.length === 0) { list.replaceChildren(h('li', { class: 'book-note-none' }, NONE)); drawCook(); return; }
    list.replaceChildren(...notes.map((n) => {
      const del = h('button', { type: 'button', class: 'btn btn-secondary btn-small book-note-delete', 'aria-label': `Delete the note from ${fmtDate(n.at)}: ${firstWords(noteText(n))}` }, 'Delete');
      del.addEventListener('click', () => { void remove(n, del); });
      return h('li', { class: 'book-note', 'data-id': n.id, tabindex: -1 }, h('span', { class: 'book-note-date' }, `${fmtDate(n.at)}: `), h('span', { class: 'book-note-text' }, noteText(n)), ' ', del);
    }));
    drawCook();
  };

  const remove = async (n: BookNote, del: HTMLButtonElement) => {
    del.disabled = true;
    if ((await deps.writer.unkeep('margin_note', n.id)) !== 'undone') { del.disabled = false; status.replaceChildren(h('p', null, DELETE_FAILED)); return; }
    notes = notes.filter((x) => x.id !== n.id);
    drawList();
    const restore = async (): Promise<boolean> => {
      const back: MarginNote = { recipe: n.recipe, ops: n.ops, text: n.text, at: restoredAt(n.at, deps.today()) };
      const out = await deps.writer.keep({ kind: 'margin_note', note: back, summary: noteText(back) });
      if (!out.ok) return false;
      notes = [...notes, { ...back, id: out.id }].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      drawList();
      return true;
    };
    status.replaceChildren(h('p', { tabindex: -1 }, DELETED), undoButton(new Date(deps.now().getTime() + UNDO_WINDOW_MS).toISOString(), deps.now, restore));
    status.querySelector<HTMLElement>('p')?.focus();
  };

  if (!deps.signedIn) {
    addBox.replaceChildren(contentText('p', deps.say('margin.needs_account'), { class: 'after-cook-line' }));
  } else if (!recipe.meta.sacred) {
    const add = h('button', { type: 'button', class: 'btn btn-secondary book-note-new' }, 'Add a note');
    const open = () => {
      addBox.replaceChildren();
      noteForm(addBox, { slug, recipe, at: deps.today(), skipLabel: 'Cancel' }, { ...deps, notes: () => Promise.resolve(notes) }, {
        skip: () => { addBox.replaceChildren(add); add.focus(); },
        kept: (r) => {
          notes = [...notes, { ...r.note, id: r.id }];
          drawList();
          // M7: the stamp button is now disabled; focus goes to the note just written, never to the page.
          list.querySelector<HTMLElement>(`.book-note[data-id="${CSS.escape(r.id)}"]`)?.focus();
          addBox.append(undoButton(r.undoUntil, deps.now, async () => {
            const ok = (await deps.writer.unkeep('margin_note', r.id)) === 'undone';
            if (ok) { notes = notes.filter((x) => x.id !== r.id); drawList(); }
            return ok;
          }), add);
        },
      });
    };
    add.addEventListener('click', open);
    addBox.replaceChildren(add);
  }
  drawList();
}
