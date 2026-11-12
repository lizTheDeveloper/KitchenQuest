// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MarginNote, Rule } from '@kitchenquest/core/engine';
import { createStore } from '../state/store';
import type { AppContext } from '../shell/app';
import { cookScreen } from './cook-screen';
import { cookWithNotes } from './with-notes';

// Cook mode speaks through the Pan; a silent stand-in is enough here.
// M6 Step 10: signed in, cook mode reads this week's run on demand (GET /market-runs/current) through the panel's client.
const runRead = vi.hoisted((): { run: unknown; calls: number; hang: boolean } => ({ run: null, calls: 0, hang: false }));
vi.mock('../mentor', () => ({
  getMentor: () => ({ say: () => ({ text: '', trigger: '', ai: 'never' }) }),
  getMentorServices: () => ({ client: { currentRun: () => { runRead.calls++; return runRead.hang ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, data: { run: runRead.run } }); } } }),
}));

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

describe('M6 Step 10: a stall swap, signed in after a reload', () => {
  test('the run is read on demand (read only); cook mode shows "swapped at the market" and checks with the swap; a new rule → refused', async () => {
    const { forgetWeek } = await import('../week/memory');
    forgetWeek();
    runRead.calls = 0;
    runRead.run = {
      id: 'run-1', weekStart: '2026-11-09', doneAt: null,
      items: [
        { key: 'shallot', name: 'shallots', ingredientId: 'shallot', stall: 'wen', forDishes: [SLUG], outOfStock: true, ticked: false },
        { key: 'stock:onion', name: 'onion', ingredientId: 'onion', stall: 'wen', forDishes: [SLUG], stockSwap: { from: 'shallot' }, ticked: true },
      ],
    };
    const t = mount([]);
    await t.run();
    expect(runRead.calls).toBe(1);
    expect(t.el.querySelector('.cook-refusal')).toBeNull();
    expect(t.el.querySelector('.stock-label')?.textContent).toBe('swapped at the market: onion for shallots');
    t.store.update((s) => ({ ...s, accountRules: [{ id: 'o1', target: { kind: 'ingredient', ids: ['onion'] }, type: 'avoid', severity: 'allergy' }] }));
    expect(t.el.querySelector('.cook-refusal')).not.toBeNull();
    t.screen.unmount?.();
  });
});

describe('Fix round 1 (I2): a stalled run read never holds cook mode', () => {
  test('GET /market-runs/current hung → cook mode draws by the 3 s limit, with the plain check and no swap label', async () => {
    const { forgetWeek } = await import('../week/memory');
    const { LOOKUP_TIMEOUT_MS } = await import('../shell/within');
    forgetWeek();
    const { rememberRun } = await import('../week/run-memory');
    rememberRun({ id: '', weekStart: '', items: [], doneAt: null }, null); // nothing remembered from the test before
    runRead.hang = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = mount([]);
      const done = t.run();
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      await done;
      expect(t.el.querySelector('.cook-step')).not.toBeNull();
      expect(t.el.querySelector('.stock-label')).toBeNull();
      t.screen.unmount?.();
    } finally { vi.useRealTimers(); runRead.hang = false; }
  });
});
