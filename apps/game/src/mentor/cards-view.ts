import { WEEKDAY_NAMES, type ProposalCard, type Severity, type TrailEntry } from '@kitchenquest/core/engine';
import { content } from '../content';
import type { BureauForm } from '../content/types';
import { contentText, h } from '../ui/dom';
import type { CardView } from './reply';

/**
 * Proposal cards and trail entries in the Pan panel (M4 Step 10). "The on-screen card is the record" (§7.6b.3):
 * every value is the card's own code-built field, as a text node. Card buttons are `type="button"` outside the
 * panel's form and never take focus on their own, so Enter in the text box can't press one.
 */

export const EXPIRED_TEXT = 'This card has expired. Tell the Pan again.';
export const CLOSED_TEXT = 'This card is closed. Tell the Pan again.';
const NOT_NOW = 'Not now';

/** The severity picker for a card whose severity the player didn't say (Severe allergy first: the safe default). */
const SEVERITY_OPTIONS: readonly { value: Severity; label: string }[] = [
  { value: 'anaphylactic', label: 'Severe allergy' },
  { value: 'allergy', label: 'Allergy' },
  { value: 'intolerance', label: 'Intolerance' },
  { value: 'preference', label: 'Preference' },
];

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const join = (xs: readonly string[]) => xs.join(', ');

/** Which Bureau form a card is filed on (pre-flight C38: profile cards use `profile`). */
function formIdFor(card: ProposalCard): string {
  switch (card.kind) {
    case 'rule': return card.form;
    case 'meal': return 'meal_log';
    case 'profile': return 'profile';
    case 'pantry': return 'pantry';
    case 'plan': return 'plan'; // Form 7-W (M5 Step 8; Step 10 completes the view)
  }
}

/** The card's values by form field key. A key with no value is left out (a profile card shows only what its patch sets). */
function valuesFor(card: ProposalCard): Partial<Record<string, string>> {
  switch (card.kind) {
    case 'rule': {
      const d = card.display;
      return { ingredient: d.ingredient, name: d.ingredient, ...(card.severe ? { spelled: d.spelled } : {}), severity: d.severity, covers: d.covers };
    }
    case 'meal': {
      const item = card.meal.item;
      return {
        meal: cap(card.meal.slot), summary: card.summary,
        ...(item.kind === 'dish' ? { servings: String(item.servings) } : {}),
        estimate: card.estimate ? 'Yes' : 'No',
      };
    }
    case 'profile': {
      const p = card.patch;
      const out: Record<string, string> = {};
      if (p.marketDays !== undefined) out.market_days = p.marketDays.length === 0 ? 'None' : join(p.marketDays.map((d) => cap(WEEKDAY_NAMES[d] ?? String(d))));
      if (p.mealsPerWeek !== undefined) out.meals_per_week = p.mealsPerWeek === null ? 'Not set' : String(p.mealsPerWeek);
      if (p.country !== undefined || p.region !== undefined) out.region = [p.region, p.country].filter((x) => typeof x === 'string' && x !== '').join(', ') || 'None';
      if (p.mealWindows !== undefined) out.meal_windows = join(p.mealWindows.map((w) => `${cap(w.name)} ${w.start}–${w.end}`));
      return out;
    }
    case 'pantry': {
      const out: Record<string, string> = {};
      if (card.add.length > 0) out.added = join(card.add.map((a) => a.name));
      if (card.remove.length > 0) out.removed = join(card.remove);
      return out;
    }
    case 'plan':
      // The day rows are drawn by plan-view.ts (below); the form's fields keep the summary and the hard week.
      return { dishes: card.summary, hard_week: card.hard ? 'Yes' : 'No' };
  }
}

export function bureauSlip(form: BureauForm, titleId: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'pan-card bureau-slip', 'aria-labelledby': titleId },
    h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`),
    contentText('h3', form.title, { id: titleId, class: 'bureau-title' }),
    ...children);
}

function bureauFieldRow(label: string, value: Node | string): HTMLElement {
  return h('div', { class: 'bureau-field' }, contentText('dt', label), h('dd', null, typeof value === 'string' ? h('span', { class: 'bureau-value' }, value) : value));
}

/** Disables a card for good, with why. */
export function closeCard(el: HTMLElement, why: string): void {
  for (const b of el.querySelectorAll('button')) b.disabled = true;
  for (const s of el.querySelectorAll('select')) s.disabled = true;
  el.classList.add('is-closed');
  setCardNote(el, why);
}

/** A short status line on the card (closed, expired, not saved yet). Empty text clears it. */
export function setCardNote(el: HTMLElement, text: string): void {
  let note = el.querySelector<HTMLElement>('.pan-card-note');
  if (text === '') { note?.remove(); return; }
  if (!note) { note = h('p', { class: 'pan-card-note', role: 'status' }); el.append(note); }
  note.textContent = text;
}

export function renderCard(view: CardView, opts: {
  forms: Record<string, BureauForm>; now: () => Date;
  onConfirm(edits?: { severity?: Severity }): void | Promise<void>; onReject(): void | Promise<void>;
  /** A plain note under the fields (Step 11: "*Kept on this device only." on a signed-out rule card). */
  footnote?: string;
  /**
   * A plan card's Form 7-W day rows, drawn by the week's own code (week-turn.ts `planCardBody`, loaded on first use:
   * Ruling 1). A plan card without it is never drawn.
   */
  planBody?: HTMLElement;
}): HTMLElement {
  const { card } = view;
  const form = opts.forms[formIdFor(card)] as BureauForm | undefined;
  if (form === undefined) throw new Error(`renderCard: no Bureau form "${formIdFor(card)}"`);
  const values = valuesFor(card);
  const dl = h('dl', { class: 'bureau-fields' });
  let picker: HTMLSelectElement | null = null;
  for (const f of form.fields) {
    if (card.kind === 'rule' && card.severityUnclear && f.key === 'severity') {
      const id = uid('pan-severity');
      picker = h('select', { id, class: 'pan-severity' },
        ...SEVERITY_OPTIONS.map((o) => h('option', { value: o.value }, o.label)));
      picker.value = 'anaphylactic';
      dl.append(h('div', { class: 'bureau-field' }, h('dt', null, contentText('label', f.label, { for: id })), h('dd', null, picker)));
      continue;
    }
    if (card.kind === 'plan' && f.key === 'days') {
      if (opts.planBody === undefined) throw new Error('renderCard: a plan card needs its day rows');
      dl.append(bureauFieldRow(f.label, opts.planBody));
      continue;
    }
    const v = values[f.key];
    if (v !== undefined) dl.append(bureauFieldRow(f.label, v));
  }

  const confirmBtn = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-primary pan-card-confirm' });
  const rejectBtn = form.buttons.decline
    ? contentText('button', form.buttons.decline, { type: 'button', class: 'btn btn-secondary pan-card-reject' })
    : h('button', { type: 'button', class: 'btn btn-secondary pan-card-reject' }, NOT_NOW);
  const stamp = contentText('div', content.bureau.stamps[form.stamp] ?? form.stamp.toUpperCase(), { class: 'bureau-stamp', 'aria-hidden': 'true' });
  const footnote = opts.footnote ? h('p', { class: 'bureau-footnote pan-card-footnote' }, opts.footnote) : null;
  const el = bureauSlip(form, uid('pan-card-title'), dl, footnote, h('div', { class: 'bureau-buttons' }, confirmBtn, rejectBtn), stamp);
  el.dataset.origin = view.origin;
  el.dataset.kind = card.kind;

  const expired = () => view.origin === 'server' && opts.now().getTime() > Date.parse(view.expiresAt);
  let busy = false;
  const run = async (fn: () => void | Promise<void>) => {
    if (busy || el.classList.contains('is-closed')) return;
    if (expired()) { closeCard(el, EXPIRED_TEXT); return; }
    busy = true;
    confirmBtn.disabled = true;
    rejectBtn.disabled = true;
    try {
      await fn();
    } finally {
      busy = false;
      if (!el.classList.contains('is-closed')) { confirmBtn.disabled = false; rejectBtn.disabled = false; }
    }
  };
  confirmBtn.addEventListener('click', () => {
    const edits = picker ? { severity: picker.value as Severity } : undefined;
    void run(() => opts.onConfirm(edits));
  });
  rejectBtn.addEventListener('click', () => { void run(() => opts.onReject()); });
  if (expired()) closeCard(el, EXPIRED_TEXT);
  return el;
}

const TRAIL_LABEL: Readonly<Record<TrailEntry['kind'], string>> = { rule: '🛡 Stamped', meal: '📒 Logged', profile: '🗓 Inked', pantry: '🫙 Pantry', plan: '🗓 Planned' };

/**
 * A write in the trail (§7.0 "tap it to edit or undo", pre-flight C24). Undo lives until `undoUntil`. Edit stays
 * for rules (Your rules) and profiles (Settings); for meals and pantry changes it goes with the undo window.
 */
export function renderTrail(entry: TrailEntry, opts: { now: () => Date; onUndo(): void | Promise<void>; onEdit(): void | Promise<void> }): HTMLElement {
  const textId = uid('trail-text');
  const undoBtn = h('button', { type: 'button', class: 'btn btn-secondary trail-undo', 'aria-describedby': textId }, 'Undo');
  const editBtn = h('button', { type: 'button', class: 'btn btn-secondary trail-edit', 'aria-describedby': textId }, 'Edit');
  const el = h('div', { class: 'trail-entry', 'data-kind': entry.kind },
    h('p', { class: 'trail-text', id: textId, tabindex: -1 }, `${TRAIL_LABEL[entry.kind]}: ${entry.summary}`),
    h('div', { class: 'button-row' }, undoBtn, editBtn));
  const text = el.querySelector<HTMLElement>('.trail-text')!;
  const editOutlivesWindow = entry.kind === 'rule' || entry.kind === 'profile';
  const closeWindow = () => {
    const going = editOutlivesWindow ? [undoBtn] : [undoBtn, editBtn];
    // Focus never falls to the page: a focused button that goes hands it to the entry text first (fix round 1, M3).
    if (going.some((b) => b === b.ownerDocument.activeElement)) text.focus();
    for (const b of going) b.remove();
  };
  const left = Date.parse(entry.undoUntil) - opts.now().getTime();
  if (left <= 0) closeWindow();
  else setTimeout(closeWindow, left);

  let busy = false;
  const run = async (fn: () => void | Promise<void>) => {
    if (busy) return;
    busy = true;
    undoBtn.disabled = true;
    editBtn.disabled = true;
    try { await fn(); } finally { busy = false; undoBtn.disabled = false; editBtn.disabled = false; }
  };
  undoBtn.addEventListener('click', () => { void run(() => opts.onUndo()); });
  editBtn.addEventListener('click', () => { void run(() => opts.onEdit()); });
  return el;
}
