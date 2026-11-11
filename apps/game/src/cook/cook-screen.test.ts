// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MarginNote, Rule } from '@kitchenquest/core/engine';
import { createStore } from '../state/store';
import type { AppContext } from '../shell/app';
import { cookScreen } from './cook-screen';
import { cookWithNotes } from './with-notes';

// Cook mode speaks through the Pan; a silent stand-in is enough here.
vi.mock('../mentor', () => ({ getMentor: () => ({ say: () => ({ text: '', trigger: '', ai: 'never' }) }) }));

const SLUG = 'india/kerala/parippu';
const EMAIL = 'cook@example.test';
const peanut: Rule = { id: 'p1', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' };
const note = (ops: MarginNote['ops'], text: string | null = null): MarginNote => ({ recipe: SLUG, ops, text, at: '2026-11-10' });

function mount(rules: Rule[]) {
  const store = createStore(null);
  store.update((s) => ({ ...s, account: { email: EMAIL }, accountRules: rules }));
  const el = document.createElement('div');
  document.body.append(el);
  const ctx: AppContext = { store, now: () => new Date('2026-11-10T18:00:00'), navigate: () => undefined };
  const screen = cookScreen();
  return { el, store, screen, run: () => screen.mount(el, { name: 'cook', slug: SLUG }, ctx) };
}

afterEach(() => { document.body.replaceChildren(); });

describe('cook mode with my notes (M5 Step 11, fix I3)', () => {
  test('a note that clashes with the rules is refused at mount, though the canon dish is not', async () => {
    const canon = mount([peanut]);
    await canon.run();
    expect(canon.el.querySelector('.cook-refusal')).toBeNull();
    canon.screen.unmount?.();
    const t = mount([peanut]);
    cookWithNotes(SLUG, [note([{ op: 'add', name: 'peanut butter' }])], EMAIL);
    await t.run();
    expect(t.el.querySelector('.cook-refusal')).not.toBeNull();
    t.screen.unmount?.();
  });

  test('a rule filed mid-cook that blocks a note\'s ingredient refuses the dish at once', async () => {
    const t = mount([]);
    cookWithNotes(SLUG, [note([{ op: 'add', name: 'peanut butter' }])], EMAIL);
    await t.run();
    expect(t.el.querySelector('.cook-refusal')).toBeNull();
    expect(t.el.querySelector('h1')?.textContent).toContain('with your notes');
    t.store.update((s) => ({ ...s, accountRules: [peanut] }));
    expect(t.el.querySelector('.cook-refusal')).not.toBeNull();
    t.screen.unmount?.();
  });

  test('another account\'s hand-off is never cooked: the canon recipe and title', async () => {
    cookWithNotes(SLUG, [note([{ op: 'add', name: 'peanut butter' }])], 'someone@else.test');
    const t = mount([peanut]);
    await t.run();
    expect(t.el.querySelector('.cook-refusal')).toBeNull();
    expect(t.el.querySelector('h1')?.textContent).not.toContain('with your notes');
    t.screen.unmount?.();
  });
});
