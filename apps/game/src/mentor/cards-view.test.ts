// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { buildMealCard, buildPantryCard, buildProfileCard, buildRuleCard, UNDO_WINDOW_MS, type Severity, type TrailEntry } from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import { EXPIRED_TEXT, renderCard, renderTrail } from './cards-view';
import type { CardView } from './reply';

const T0 = new Date('2026-11-10T12:00:00Z');
let now = T0;
const forms = content.bureau.forms;
const rule = (term: string, severity: Severity | null) => {
  const r = buildRuleCard({ term, severity }, graph, content.ruleTerms);
  if (!r.ok) throw new Error(term);
  return r.card;
};
const local = (card: CardView['card']): CardView => ({ origin: 'local', localId: 'L1', card, issuedTurn: 1 });
const fields = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('.bureau-field')].map((f) => [f.querySelector('dt')!.textContent, f.querySelector('dd .bureau-value')?.textContent ?? '']));
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name);

beforeEach(() => { document.body.replaceChildren(); now = T0; });
afterEach(() => { vi.useRealTimers(); });

describe('renderCard', () => {
  test('a severe rule card shows the spelling and has no confirm on Enter in the text box', () => {
    const onConfirm = vi.fn();
    const card = renderCard(local(rule('sesame', 'allergy')), { forms, now: () => now, onConfirm, onReject: vi.fn() });
    const form = document.createElement('form');
    const box = document.createElement('textarea');
    form.append(box);
    form.addEventListener('submit', (e) => e.preventDefault());
    document.body.append(form, card);
    expect(card.textContent).toContain('27-B/ALLERGEN');
    expect(fields(card)).toMatchObject({ 'Ingredient or group': 'sesame', Spelled: 'S-E-S-A-M-E', 'How serious': 'an allergy' });
    expect(fields(card)['This covers']).toContain('sesame');
    box.focus();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    form.requestSubmit();
    expect(document.activeElement).toBe(box);
    expect(onConfirm).not.toHaveBeenCalled();
    // Every card button is type=button, so no form submit can press one.
    expect([...card.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true);
    button(card, 'Stamp it ✔')!.click();
    expect(onConfirm).toHaveBeenCalledWith(undefined);
  });

  test('a non-severe rule card has no spelling row', () => {
    const card = renderCard(local(rule('milk', 'intolerance')), { forms, now: () => now, onConfirm: vi.fn(), onReject: vi.fn() });
    expect(card.textContent).toContain('27-B/INTOLERANCE');
    expect(Object.keys(fields(card))).not.toContain('Spelled');
  });

  test('an unclear severity offers the picker, defaulting to Severe allergy', () => {
    const onConfirm = vi.fn();
    const card = renderCard(local(rule('sesame', null)), { forms, now: () => now, onConfirm, onReject: vi.fn() });
    document.body.append(card);
    const select = card.querySelector('select')!;
    expect(select.labels?.[0]?.textContent).toBe('How serious');
    expect([...select.options].map((o) => o.textContent)).toEqual(['Severe allergy', 'Allergy', 'Intolerance', 'Preference']);
    expect(select.value).toBe('anaphylactic');
    button(card, 'Stamp it ✔')!.click();
    expect(onConfirm).toHaveBeenLastCalledWith({ severity: 'anaphylactic' });
  });

  test('the picker value feeds edits.severity', () => {
    const onConfirm = vi.fn();
    const card = renderCard(local(rule('sesame', null)), { forms, now: () => now, onConfirm, onReject: vi.fn() });
    card.querySelector('select')!.value = 'intolerance';
    button(card, 'Stamp it ✔')!.click();
    expect(onConfirm).toHaveBeenLastCalledWith({ severity: 'intolerance' });
  });

  test('both buttons are disabled while the confirm is pending; a double click confirms once', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    const card = renderCard(local(buildProfileCard({ marketDays: [6] })), { forms, now: () => now, onConfirm, onReject: vi.fn() });
    const confirm = button(card, 'Ink it ✔')!;
    confirm.click();
    confirm.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    expect(button(card, 'Leave in pencil')!.disabled).toBe(true);
    finish();
    await Promise.resolve(); await Promise.resolve();
    expect(confirm.disabled).toBe(false);
  });

  test('an expired server card is disabled', () => {
    const view: CardView = { origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T11:59:00Z', card: buildProfileCard({ marketDays: [6] }), issuedTurn: 1 };
    const onConfirm = vi.fn();
    const card = renderCard(view, { forms, now: () => now, onConfirm, onReject: vi.fn() });
    expect(card.textContent).toContain(EXPIRED_TEXT);
    expect(EXPIRED_TEXT).toBe('This card has expired. Tell the Pan again.');
    expect([...card.querySelectorAll('button')].every((b) => b.disabled)).toBe(true);
  });

  test('a server card that expires while open is refused on the tap', () => {
    const view: CardView = { origin: 'server', proposalId: 'P1', expiresAt: '2026-11-10T12:30:00Z', card: buildProfileCard({ marketDays: [6] }), issuedTurn: 1 };
    const onConfirm = vi.fn();
    const card = renderCard(view, { forms, now: () => now, onConfirm, onReject: vi.fn() });
    now = new Date('2026-11-10T12:31:00Z');
    button(card, 'Ink it ✔')!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(card.textContent).toContain('This card has expired. Tell the Pan again.');
  });

  test('meal, profile and pantry cards use their forms and show only what they set; a missing decline shows "Not now"', () => {
    const meal = renderCard(local(buildMealCard({ eatenOn: '2026-11-10', slot: 'lunch', description: 'dal and rice' })), { forms, now: () => now, onConfirm: vi.fn(), onReject: vi.fn() });
    expect(meal.textContent).toContain('2-L');
    expect(fields(meal)).toMatchObject({ Meal: 'Lunch', 'What you had': 'dal and rice, lunch', 'Estimate?': 'Yes' });
    const profile = renderCard(local(buildProfileCard({ marketDays: [6] })), { forms, now: () => now, onConfirm: vi.fn(), onReject: vi.fn() });
    expect(profile.textContent).toContain('1-A/AMEND');
    expect(fields(profile)).toEqual({ 'Market day(s)': 'Saturday' });
    const pantry = renderCard(local(buildPantryCard({ add: ['rice'], remove: ['milk'] }, graph)), { forms, now: () => now, onConfirm: vi.fn(), onReject: vi.fn() });
    expect(fields(pantry)).toEqual({ Added: 'rice', Removed: 'milk' });
    expect(button(pantry, 'Not now')).toBeDefined();
  });
});

describe('renderTrail', () => {
  const entry = (kind: TrailEntry['kind']): TrailEntry => ({ id: 'w1', origin: 'local', kind, summary: 'sesame, an allergy', undoUntil: new Date(T0.getTime() + UNDO_WINDOW_MS).toISOString() });

  test('each kind has its label', () => {
    const text = (k: TrailEntry['kind']) => renderTrail(entry(k), { now: () => now, onUndo: vi.fn(), onEdit: vi.fn() }).querySelector('.trail-text')!.textContent;
    expect(text('rule')).toBe('🛡 Stamped: sesame, an allergy');
    expect(text('meal')).toBe('📒 Logged: sesame, an allergy');
    expect(text('profile')).toBe('🗓 Inked: sesame, an allergy');
    expect(text('pantry')).toBe('🫙 Pantry: sesame, an allergy');
  });

  test('trail Undo disappears at undoUntil', () => {
    vi.useFakeTimers({ now: T0 });
    const onUndo = vi.fn();
    const el = renderTrail(entry('meal'), { now: () => new Date(), onUndo, onEdit: vi.fn() });
    button(el, 'Undo')!.click();
    expect(onUndo).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(UNDO_WINDOW_MS - 1);
    expect(button(el, 'Undo')).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(button(el, 'Undo')).toBeUndefined();
    // A meal's Edit goes with the window; a rule's and a profile's stay.
    expect(button(el, 'Edit')).toBeUndefined();
    const ruleEl = renderTrail(entry('rule'), { now: () => new Date(), onUndo, onEdit: vi.fn() });
    expect(button(ruleEl, 'Undo')).toBeUndefined();
    expect(button(ruleEl, 'Edit')).toBeDefined();
    expect(button(renderTrail(entry('profile'), { now: () => new Date(), onUndo, onEdit: vi.fn() }), 'Edit')).toBeDefined();
  });

  test('a focused Undo that goes at undoUntil hands focus to the entry text (fix round 1, M3)', () => {
    vi.useFakeTimers({ now: T0 });
    const el = renderTrail(entry('meal'), { now: () => new Date(), onUndo: vi.fn(), onEdit: vi.fn() });
    document.body.append(el);
    button(el, 'Undo')!.focus();
    vi.advanceTimersByTime(UNDO_WINDOW_MS);
    expect(document.activeElement).toBe(el.querySelector('.trail-text'));
    expect(el.querySelector('.trail-text')!.getAttribute('tabindex')).toBe('-1');
  });

  test('trail Edit calls onEdit', () => {
    const onEdit = vi.fn();
    button(renderTrail(entry('meal'), { now: () => now, onUndo: vi.fn(), onEdit }), 'Edit')!.click();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});
