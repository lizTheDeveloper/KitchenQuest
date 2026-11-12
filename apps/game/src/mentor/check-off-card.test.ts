// @vitest-environment happy-dom
// M6 Step 10: the check-off card's states (check-off-card.ts). Fix round 1 (m2): an applied card shows a row ticked only
// when that row was actually ticked; a skipped or refused row says so.
import { describe, expect, test } from 'vitest';
import { buildCheckOffCard, type MarketRunView } from '@kitchenquest/core/engine';
import { content } from '../content';
import { createStore } from '../state/store';
import { drawCheckOff } from './check-off-card';
import type { CardView, CheckOffSlot } from './reply';

const run: MarketRunView = {
  id: 'r1', weekStart: '2026-11-09', doneAt: null,
  items: ['shallot', 'moong_dal', 'rice'].map((k) => ({ key: k, name: k === 'moong_dal' ? 'split moong dal' : k, ingredientId: k, stall: 'wen' as const, forDishes: [], ticked: false })),
};
const view = (source: 'grammar' | 'model'): CardView => ({ origin: 'local', localId: 'L', card: buildCheckOffCard(run, ['shallot', 'moong_dal'], ['rice'], source)!, issuedTurn: 1 });
function draw(slot: CheckOffSlot, source: 'grammar' | 'model' = 'grammar'): HTMLElement {
  document.body.replaceChildren();
  const holder = document.createElement('div');
  document.body.append(holder);
  drawCheckOff(holder, view(source), slot, { forms: content.bureau.forms, store: createStore(null), now: () => new Date(2026, 10, 10), focus: () => undefined, tick: () => undefined, notNow: () => undefined, undo: () => undefined });
  return holder;
}
const state = (el: HTMLElement, key: string) => el.querySelector(`[data-key="${key}"] .checkoff-state`)!.textContent;
const buttons = (el: HTMLElement) => [...el.querySelectorAll('button')].map((b) => b.textContent);

describe('check-off card states', () => {
  test('pending: Tick these and Not now, nothing shown as ticked; missing rows carry Out of stock?', () => {
    const el = draw({ state: 'pending', draw() {} }, 'model');
    expect(buttons(el)).toEqual(['Out of stock?', 'Tick these', 'Not now']);
    expect(state(el, 'shallot')).toBe(' (not ticked yet)');
  });

  test('a new local grammar card is applying: no Tick these', () => {
    const el = draw({ state: 'new', draw() {} });
    expect(buttons(el)).not.toContain('Tick these');
  });

  test('m2: applied after a partial tick: only the rows actually ticked say so; Undo while any was ticked', () => {
    const el = draw({ state: 'applied', ticked: ['shallot'], draw() {} });
    expect(state(el, 'shallot')).toBe(' (ticked)');
    expect(state(el, 'moong_dal')).toBe(' (not ticked)');
    expect(el.querySelector('[data-key="moong_dal"]')!.getAttribute('data-ticked')).toBe('false');
    expect(buttons(el)).toContain('Undo');
    const none = draw({ state: 'applied', ticked: [], draw() {} });
    expect(buttons(none)).not.toContain('Undo');
    // A server card (the API ticked it in its own transaction): its got rows show ticked.
    const server = draw({ state: 'applied', draw() {} });
    expect(state(server, 'moong_dal')).toBe(' (ticked)');
  });

  test('undone: unticked, no buttons but the missing rows\' Out of stock?', () => {
    const el = draw({ state: 'undone', ticked: ['shallot'], draw() {} });
    expect(state(el, 'shallot')).toBe(' (unticked)');
    expect(buttons(el)).toEqual(['Out of stock?']);
  });
});
