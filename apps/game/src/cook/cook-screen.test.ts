// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MarginNote, Rule } from '@kitchenquest/core/engine';
import { createStore, type PlayerState } from '../state/store';
import type { AppContext } from '../shell/app';
import { cookScreen } from './cook-screen';
import { cookWithNotes } from './with-notes';

// Cook mode speaks through the Pan; a silent stand-in is enough here.
// M6 Step 10: signed in, cook mode reads this week's run on demand (GET /market-runs/current) through the panel's client.
const runRead = vi.hoisted((): { run: unknown; calls: number; hang: boolean } => ({ run: null, calls: 0, hang: false }));
// M7 Step 10: the panel's hands-free port and the lines said, when a test gives them.
const hfMock = vi.hoisted(() => ({
  port: null as null | { conversationId(): string | null; childOn(): boolean; onChild(fn: () => void): () => void; spoken(text: string, id: number): Promise<unknown> },
  lines: [] as string[],
  opened: 0,
}));
vi.mock('../mentor', () => ({
  getMentor: () => ({
    say: (t: string) => { hfMock.lines.push(t); return { text: '', trigger: t, ai: 'never' }; },
    cookVoice: () => hfMock.port,
    isOpen: () => false,
    open: () => { hfMock.opened++; },
  }),
  getMentorServices: () => ({ client: { currentRun: () => { runRead.calls++; return runRead.hang ? new Promise(() => {}) : Promise.resolve({ ok: true, status: 200, data: { run: runRead.run } }); } } }),
}));

// M7 Step 10: the voice client, faked: a controller double the test speaks for (never a microphone or a socket).
interface FakeCtl {
  calls: string[]; said: unknown[]; timer: boolean[]; handsFree: boolean; closedReason: string | null; timerSounding(on: boolean): void;
  hear(text: string): void; mic(open: boolean): void;
}
const voiceMock = vi.hoisted(() => ({ controllers: [] as FakeCtl[], providers: 0 }));
vi.mock('../voice', () => ({
  providerKind: () => 'service',
  serviceProvider: () => { voiceMock.providers++; return { close: () => undefined }; },
  devBrowserProvider: () => { throw new Error('not in tests'); },
  createVoiceController: () => {
    const transcripts = new Set<(t: string, tooLong: boolean, id: number) => void>();
    const off = new Set<(w: string) => void>();
    const mics = new Set<(open: boolean) => void>();
    let id = 0;
    const c = {
      calls: [] as string[], said: [] as unknown[], timer: [] as boolean[], handsFree: false, closedReason: null as string | null, phase: 'idle', state: null,
      startHandsFree() { c.calls.push('startHandsFree'); c.handsFree = true; },
      stopHandsFree() { c.calls.push('stopHandsFree'); c.handsFree = false; c.mic(false); },
      timerSounding(on: boolean) { c.timer.push(on); },
      say(plan: unknown) { c.said.push(plan); },
      onTranscript(fn: (t: string, tooLong: boolean, id: number) => void) { transcripts.add(fn); return () => { transcripts.delete(fn); }; },
      onHandsFreeOff(fn: (w: string) => void) { off.add(fn); return () => { off.delete(fn); }; },
      onMic(fn: (open: boolean) => void) { mics.add(fn); return () => { mics.delete(fn); }; },
      onProblem() { return () => undefined; },
      onPhase() { return () => undefined; },
      close(reason = 'off') {
        if (c.closedReason !== null) return;
        c.closedReason = reason;
        c.calls.push(`close:${reason}`);
        c.mic(false);
        if (c.handsFree) { c.handsFree = false; for (const fn of [...off]) fn('closed'); }
      },
      hear(text: string) { for (const fn of [...transcripts]) fn(text, false, ++id); },
      mic(open: boolean) { for (const fn of [...mics]) fn(open); },
    };
    voiceMock.controllers.push(c);
    return c;
  },
}));

// M6 final: the progress service, when a test gives one (else it is not initialised, as in a bare mount).
const progressMock = vi.hoisted((): { p: Promise<unknown> | null } => ({ p: null }));
vi.mock('../progress', () => ({
  progressService: () => progressMock.p ?? Promise.reject(new Error('progress is not initialised')),
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

describe('Fix round 1 (m1, Ruling 16): the drill-first hint on the cook screen too', () => {
  test('parippu with heat control below Seen: the hint and its chip beside the steps; none in Family Table; Cook mode runs either way', async () => {
    const { setToolkitSource } = await import('../week/memory');
    setToolkitSource(() => ({ techniques: {} }));
    const t = mount([]);
    await t.run();
    expect(t.el.querySelector('.cook-refusal')).toBeNull();
    expect(t.el.querySelector('.drill-first a')?.getAttribute('href')).toBe('#/visit/marisol');
    t.screen.unmount?.();
    const ft = mount([]);
    ft.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    await ft.run();
    expect(ft.el.querySelector('.drill-first')).toBeNull();
    ft.screen.unmount?.();
  });
});

describe('M6 final: a direct #/cook load', () => {
  test('M9: while the run read waits, cook mode says so (a status line), then draws', async () => {
    const { forgetWeek } = await import('../week/memory');
    const { LOOKUP_TIMEOUT_MS } = await import('../shell/within');
    forgetWeek();
    const { rememberRun } = await import('../week/run-memory');
    rememberRun({ id: '', weekStart: '', items: [], doneAt: null }, null); // nothing remembered from the tests before
    runRead.hang = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = mount([]);
      const done = t.run();
      await vi.advanceTimersByTimeAsync(10);
      const wait = t.el.querySelector('[role="status"].cook-wait');
      expect(wait?.textContent).toBe("Reading this week's market run…");
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
      await done;
      expect(t.el.querySelector('.cook-wait')).toBeNull();
      expect(t.el.querySelector('.cook-step')).not.toBeNull();
      t.screen.unmount?.();
    } finally { vi.useRealTimers(); runRead.hang = false; }
  });

  test('the drill-first hint appears once progress loads, though the toolkit was not in memory at mount', async () => {
    const { setToolkitSource } = await import('../week/memory');
    setToolkitSource(() => undefined as never); // a cold load: progress has not loaded yet
    let release: () => void = () => undefined;
    progressMock.p = new Promise((r) => { release = () => { r({ view: () => ({ toolkit: { techniques: {} } }) }); }; });
    try {
      const t = mount([]);
      await t.run();
      expect(t.el.querySelector('.cook-step')).not.toBeNull();
      expect(t.el.querySelector('.drill-first')).toBeNull();
      release();
      await new Promise((r) => setTimeout(r, 0));
      expect(t.el.querySelector('.drill-first a')?.getAttribute('href')).toBe('#/visit/marisol');
      expect(t.el.querySelector('.cook-step')).not.toBeNull(); // cook mode runs on, the strip redrawn in place
      t.screen.unmount?.();
    } finally { progressMock.p = null; }
  });
});


describe('M7 Step 10: hands-free cook mode', () => {
  const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
  let child = false;
  const childFns = new Set<() => void>();
  const spoken: string[] = [];
  const setUp = (voice: Partial<{ on: boolean; handsFree: boolean; readAloud: boolean }> = {}) => {
    hfMock.port = {
      conversationId: () => null, childOn: () => child,
      onChild: (fn) => { childFns.add(fn); return () => { childFns.delete(fn); }; },
      spoken: (text) => { spoken.push(text); return Promise.resolve(null); },
    };
    const t = mount([]);
    t.store.update((s) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true, ...voice } } }));
    return t;
  };
  const toggle = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('.hands-free-toggle')!;
  const shown = (el: HTMLElement) => { const b = el.querySelector<HTMLButtonElement>('.hands-free-toggle'); return b !== null && !b.hidden; };
  const pill = (el: HTMLElement) => el.querySelector('.listening-region .listening-pill');
  const on = async (t: ReturnType<typeof setUp>) => { toggle(t.el).click(); await flush(); return voiceMock.controllers.at(-1)!; };

  beforeEach(() => {
    vi.stubEnv('VITE_HANDS_FREE', 'on');
    voiceMock.controllers.length = 0;
    hfMock.lines.length = 0;
    spoken.length = 0;
    child = false;
    childFns.clear();
  });
  afterEach(() => { vi.unstubAllEnvs(); hfMock.port = null; });

  test('the Hands-free toggle shows only with VITE_HANDS_FREE on, voice on, handsFree on, signed in, standard mode; never in Family Table', async () => {
    const t = setUp();
    await t.run();
    expect(shown(t.el)).toBe(true);
    expect(toggle(t.el).getAttribute('aria-pressed')).toBe('false');
    expect(t.el.querySelector('#hands-free-hint')!.textContent).toContain('Hands-free is off');
    // Off by default (Ruling 7): nothing loaded, no controller, until the player turns it on.
    expect(voiceMock.controllers).toHaveLength(0);
    for (const change of [
      (s: PlayerState) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, on: false } } }),
      (s: PlayerState) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, handsFree: false } } }),
      (s: PlayerState) => ({ ...s, account: null }),
      (s: PlayerState) => ({ ...s, settings: { ...s.settings, familyTable: true } }),
    ]) {
      const before = t.store.get();
      t.store.update(change);
      expect(shown(t.el)).toBe(false);
      t.store.update(() => before);
      expect(shown(t.el)).toBe(true);
    }
    t.screen.unmount?.();
    // A child spoke in the conversation (§19): no control.
    child = true;
    const c = setUp();
    await c.run();
    expect(shown(c.el)).toBe(false);
    c.screen.unmount?.();
    child = false;
    // Family Table from the start: no control, and nothing of the voice client loads.
    const ft = setUp();
    ft.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    await ft.run();
    expect(shown(ft.el)).toBe(false);
    ft.screen.unmount?.();
    // Not a hands-free build (C9): never, whatever the settings say.
    vi.unstubAllEnvs();
    const off = setUp();
    await off.run();
    expect(shown(off.el)).toBe(false);
    off.screen.unmount?.();
    expect(voiceMock.controllers).toHaveLength(0);
  });

  test('the Listening pill is visible exactly while the mic is open, is announced politely once, and has no timer or countdown', async () => {
    const t = setUp();
    await t.run();
    const region = t.el.querySelector('.listening-region')!;
    expect(region.getAttribute('role')).toBe('status'); // a polite live region, present before anything is said in it
    const c = await on(t);
    expect(c.calls).toEqual(['startHandsFree']);
    expect(toggle(t.el).getAttribute('aria-pressed')).toBe('true');
    expect(t.el.querySelector('#hands-free-hint')!.textContent).toContain('Hands-free is on');
    expect(hfMock.lines).toEqual(['cook.start', 'voice.hands_free_on']);
    expect(pill(t.el)).toBeNull(); // on, but the microphone isn't open yet
    let changes = 0;
    const obs = new MutationObserver((m) => { changes += m.length; });
    obs.observe(region, { childList: true, subtree: true, characterData: true });
    c.mic(true);
    c.mic(true);
    await flush();
    expect(pill(t.el)!.textContent).toBe('Listening');
    expect(changes).toBe(1); // said once, not again while it stays open
    expect(region.textContent).not.toMatch(/\d/);
    expect(region.querySelector('progress, meter, time, [role="timer"], [role="progressbar"]')).toBeNull();
    c.mic(false);
    expect(pill(t.el)).toBeNull();
    c.mic(true);
    expect(pill(t.el)).not.toBeNull();
    obs.disconnect();
    // Off by the toggle: the microphone closes, the pill goes, and the off line is said.
    toggle(t.el).click();
    expect(pill(t.el)).toBeNull();
    expect(c.closedReason).toBe('off');
    expect(hfMock.lines.at(-1)).toBe('voice.hands_free_off');
    expect(toggle(t.el).getAttribute('aria-pressed')).toBe('false');
    t.screen.unmount?.();
  });

  test('keyboard and touch controls keep working while hands-free is on; spoken commands drive the same runner', async () => {
    const t = setUp();
    await t.run();
    const c = await on(t);
    const progress = () => t.el.querySelector('.cook-progress')!.textContent;
    expect(progress()).toBe('Step 1 of 7');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(progress()).toBe('Step 2 of 7');
    t.el.querySelector<HTMLButtonElement>('.cook-controls .btn-primary')!.click();
    expect(progress()).toBe('Step 3 of 7');
    t.el.querySelector<HTMLButtonElement>('.cook-controls .btn-secondary')!.click();
    expect(progress()).toBe('Step 2 of 7');
    // A spoken "next": the canon step on screen is asked for by slug, 0-based (P12); the API decides whether to read it.
    c.hear('next step');
    expect(progress()).toBe('Step 3 of 7');
    expect(c.said.at(-1)).toEqual({ items: [{ kind: 'step', slug: SLUG, step: 2, localDate: '2026-11-10' }], said: [] });
    c.hear('back');
    expect(progress()).toBe('Step 2 of 7');
    // "start the timer" starts this step's timer, as its button would; "stop the timer" stops it.
    // To the first step with a timer, by voice.
    for (let i = 0; t.el.querySelector('[data-timer-start]') === null && i < 7; i++) c.hear('next');
    const timerBtn = t.el.querySelector<HTMLButtonElement>('[data-timer-start]')!;
    expect(timerBtn).not.toBeNull();
    const tray = () => t.el.querySelector('.timer-tray')!.hasAttribute('hidden');
    expect(tray()).toBe(true);
    c.hear('start the timer');
    expect(tray()).toBe(false);
    c.hear('stop the timer');
    expect(tray()).toBe(true);
    // The touch button still starts it with hands-free on.
    timerBtn.click();
    expect(tray()).toBe(false);
    // A question goes to the Pan (the panel opens to show its reply and any heard card).
    c.hear('how long do I keep stirring');
    expect(spoken).toEqual(['how long do I keep stirring']);
    expect(hfMock.opened).toBe(1);
    // The toggle is a native button: Enter or Space on it is a click.
    expect(toggle(t.el).tagName).toBe('BUTTON');
    t.screen.unmount?.();
    // Leaving cook mode turns it off (and closes the microphone).
    expect(c.closedReason).toBe('off');
    expect(c.calls).toContain('stopHandsFree');
  });

  test('a canon dish cooked with notes is never read aloud (Ruling 11): "next" moves, and nothing is asked of the API', async () => {
    const t = setUp();
    cookWithNotes(SLUG, [note([{ op: 'add', name: 'lime' }])], EMAIL);
    await t.run();
    expect(t.el.querySelector('h1')?.textContent).toContain('with your notes');
    const c = await on(t);
    c.hear('next');
    expect(t.el.querySelector('.cook-progress')!.textContent).toBe('Step 2 of 7');
    expect(c.said).toEqual([{ items: [], said: [] }]);
    t.screen.unmount?.();
  });

  test('carry 1 (B9): a finished timer marks the alarm sounding before its beep starts, and clears it when the beep ends', async () => {
    const order: string[] = [];
    let ended: (() => void) | null = null;
    class RecordingContext {
      currentTime = 0; destination = {};
      createOscillator() {
        const osc = { frequency: { value: 0 }, connect() {}, start() { order.push('beep'); }, stop() {}, set onended(fn: () => void) { ended = fn; } };
        return osc;
      }
      close() { return Promise.resolve(); }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = RecordingContext;
    try {
      let now = new Date('2026-11-10T18:00:00').getTime();
      hfMock.port = { conversationId: () => null, childOn: () => false, onChild: () => () => undefined, spoken: () => Promise.resolve(null) };
      const store = createStore(null);
      store.update((s) => ({ ...s, account: { email: EMAIL }, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true } } }));
      const el = document.createElement('div');
      document.body.append(el);
      const screen = cookScreen();
      await screen.mount(el, { name: 'cook', slug: SLUG }, { store, now: () => new Date(now), navigate: () => undefined });
      toggle(el).click();
      await flush();
      const c = voiceMock.controllers.at(-1)!;
      const orig = c.timerSounding.bind(c);
      c.timerSounding = (v: boolean) => { order.push(`sounding:${v}`); orig(v); };
      // To a step with a timer, and start it.
      let btn = el.querySelector<HTMLButtonElement>('[data-timer-start]');
      for (let i = 0; btn === null && i < 6; i++) { el.querySelector<HTMLButtonElement>('.cook-controls .btn-primary')!.click(); btn = el.querySelector('[data-timer-start]'); }
      btn!.click();
      now += 60 * 60 * 1000;
      document.dispatchEvent(new Event('visibilitychange')); // cook mode ticks its timers on this
      expect(order).toEqual(['sounding:true', 'beep']);
      ended!();
      expect(order).toEqual(['sounding:true', 'beep', 'sounding:false']);
      expect(c.timer).toEqual([true, false]);
      screen.unmount?.();
    } finally {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    }
  });

  test('Family Table on, a child speaking, or signed out mid-cook → the microphone closes at once, without a word; the control goes', async () => {
    const cases: [string, (t: ReturnType<typeof setUp>) => void, string][] = [
      ['family table', (t) => t.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } })), 'family_table'],
      ['child', () => { child = true; for (const fn of [...childFns]) fn(); }, 'child'],
      ['signed out', (t) => t.store.update((s) => ({ ...s, account: null })), 'signed_out'],
    ];
    for (const [, act, reason] of cases) {
      child = false;
      const t = setUp();
      await t.run();
      const c = await on(t);
      c.mic(true);
      hfMock.lines.length = 0;
      act(t);
      expect(c.closedReason).toBe(reason);
      expect(pill(t.el)).toBeNull();
      expect(hfMock.lines).toEqual([]);
      if (reason !== 'child') expect(shown(t.el)).toBe(false);
      t.screen.unmount?.();
    }
  });

  test('the wake lock is held while hands-free is on, even if the player turns "Keep screen awake" off', async () => {
    const sentinels: { released: boolean }[] = [];
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { const x = { released: false, release: async () => { x.released = true; }, addEventListener() {} }; sentinels.push(x); return x; } } });
    try {
      const t = setUp();
      await t.run();
      await flush();
      const wake = t.el.querySelector<HTMLButtonElement>('.wake-toggle')!;
      await on(t);
      await flush();
      wake.click(); // the player's off
      await flush();
      expect(wake.getAttribute('aria-pressed')).toBe('true');
      expect(sentinels.some((x) => !x.released)).toBe(true);
      toggle(t.el).click(); // hands-free off: nothing holds it now
      await flush();
      expect(wake.getAttribute('aria-pressed')).toBe('false');
      expect(sentinels.every((x) => x.released)).toBe(true);
      t.screen.unmount?.();
    } finally {
      delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
    }
  });
});
