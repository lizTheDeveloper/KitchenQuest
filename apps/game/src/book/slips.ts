import type { CookedFor, CookedForCount, CookedForWho, NoteOp } from '@kitchenquest/core/engine';
import { content } from '../content';
import type { BureauForm } from '../content/types';
import { bureauSlip } from '../mentor/cards-view';
import { contentText, h } from '../ui/dom';
import { opText } from './book-export';

/**
 * The Recipe Book's Bureau slips (M5 Step 11): Form 2-M/MARGIN (a margin note) and Form 5-S/SHARED TABLE (Cooked for
 * Someone). They live beside the after-cook flow and the notes panel, not in the panel's cards-view.ts, so first paint
 * never carries them. Every value is code-built text. A slip opens with its read-back focused, never its Stamp
 * button (audit R2, M4's rule), so a stray Enter can't stamp it.
 */

/** The fixed count chips (Ruling 10), as the player taps them. */
export const COUNT_CHIPS: readonly { value: CookedForCount; label: string }[] = [
  { value: 'just_me', label: 'Just me' },
  { value: 'one', label: 'One more' },
  { value: 'two_to_three', label: 'Two or three' },
  { value: 'four_plus', label: 'Four or more' },
];
/** The optional fixed words. No names, ever. */
export const WHO_CHIPS: readonly { value: CookedForWho; label: string }[] = [
  { value: 'partner', label: 'Partner' },
  { value: 'family', label: 'Family' },
  { value: 'flatmate', label: 'Flatmate' },
  { value: 'friends', label: 'Friends' },
  { value: 'neighbours', label: 'Neighbours' },
  { value: 'colleagues', label: 'Colleagues' },
  { value: 'guests', label: 'Guests' },
];
const COUNT_WORDS: Readonly<Record<CookedForCount, string>> = {
  just_me: 'Just me', one: 'You and one more', two_to_three: 'You and two or three more', four_plus: 'You and four or more',
};

/** What a Shared Table slip shows: exactly what will be stored, the count and the word, and nothing else. */
export function cookedForWords(c: CookedFor): { count: string; who: string } {
  return { count: COUNT_WORDS[c.count], who: c.who === null ? 'Not said' : (WHO_CHIPS.find((w) => w.value === c.who)?.label ?? 'Not said') };
}
export const cookedForSummary = (c: CookedFor): string => {
  const w = cookedForWords(c);
  return c.who === null ? w.count : `${w.count} (${w.who.toLowerCase()})`;
};

/** A note's ingredient changes as words, for the card and the book. */
export const opsText = (ops: readonly NoteOp[]): string => (ops.length === 0 ? 'None' : ops.map(opText).join(', '));

let seq = 0;

export interface Slip {
  el: HTMLElement;
  readback: HTMLElement;
  confirm: HTMLButtonElement;
  decline: HTMLButtonElement;
  /** Close it for good with a short status line (stamped, skipped). */
  close(note: string): void;
}

/**
 * A Bureau slip with its read-back lines first, then the fields, then the form's own buttons and stamp. `fields` are
 * label → value (text or a node). Nothing happens until a button is pressed; the caller wires them.
 */
export function bookSlip(form: BureauForm, kind: string, readback: readonly string[], fields: readonly [string, string | Node][], footnote = true): Slip {
  const titleId = `book-slip-${++seq}`;
  const back = h('div', { class: 'slip-readback', tabindex: -1 }, ...readback.map((t) => contentText('p', t)));
  const dl = h('dl', { class: 'bureau-fields' },
    ...fields.map(([label, value]) => h('div', { class: 'bureau-field' }, h('dt', null, label),
      h('dd', null, typeof value === 'string' ? h('span', { class: 'bureau-value' }, value) : value))));
  const confirm = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-primary slip-confirm' });
  const decline = contentText('button', form.buttons.decline ?? 'Not now', { type: 'button', class: 'btn btn-secondary slip-decline' });
  const stamp = contentText('div', content.bureau.stamps[form.stamp] ?? form.stamp.toUpperCase(), { class: 'bureau-stamp', 'aria-hidden': 'true' });
  const foot = footnote && form.footnotes?.[0] ? contentText('p', form.footnotes[0], { class: 'bureau-footnote' }) : null;
  const el = bureauSlip(form, titleId, back, dl, foot, h('div', { class: 'bureau-buttons' }, confirm, decline), stamp);
  el.dataset.kind = kind;
  return {
    el, readback: back, confirm, decline,
    close(note) {
      for (const b of el.querySelectorAll('button')) b.disabled = true;
      el.classList.add('is-closed');
      el.append(h('p', { class: 'pan-card-note', role: 'status' }, note));
    },
  };
}

/** A chip group: buttons with aria-pressed, at most one pressed. `toggle`: a second tap on the pressed chip clears it. */
export function chipGroup<T extends string | number>(label: string, chips: readonly { value: T; label: string }[], pressed: T | null, onPick: (v: T | null) => void, toggle = false): HTMLElement {
  const buttons = chips.map((c) => {
    const b = h('button', { type: 'button', class: 'chip-choice', 'aria-pressed': String(c.value === pressed), 'data-value': String(c.value) }, c.label);
    b.addEventListener('click', () => {
      const next = b.getAttribute('aria-pressed') === 'true' && toggle ? null : c.value;
      for (const x of buttons) x.setAttribute('aria-pressed', String(x === b && next !== null));
      onPick(next);
    });
    return b;
  });
  return h('div', { class: 'chip-row', role: 'group', 'aria-label': label }, ...buttons);
}

const UNDONE_TEXT = 'Undone. Nothing was kept.';
const UNDO_FAILED = "That didn't go through. Try again in a moment.";

/**
 * An M4-style undo for a kept row: there until `until` (the undo window), then gone. `run` reverses it (true when
 * done). Focus never falls to the page when the button goes. Undoing never touches anything earned.
 */
export function undoButton(until: string, now: () => Date, run: () => Promise<boolean>): HTMLElement {
  const b = h('button', { type: 'button', class: 'btn btn-secondary book-undo' }, 'Undo');
  const status = h('p', { class: 'after-cook-status', role: 'status', tabindex: -1 });
  const wrap = h('div', { class: 'button-row' }, b, status);
  const timer = setTimeout(() => { if (b === b.ownerDocument.activeElement) status.focus(); b.remove(); }, Math.max(0, Date.parse(until) - now().getTime()));
  b.addEventListener('click', () => {
    b.disabled = true;
    void run().then((ok) => {
      if (!ok) { b.disabled = false; status.textContent = UNDO_FAILED; return; }
      clearTimeout(timer);
      b.remove();
      status.textContent = UNDONE_TEXT;
      status.focus();
    });
  });
  return wrap;
}
