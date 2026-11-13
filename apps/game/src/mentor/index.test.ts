import { describe, expect, test } from 'vitest';
import { createStore } from '../state/store';
import { createDialogue } from './dialogue';
import { backendKind, historyOptions, screenOf, switchingBackend } from './index';
import type { PanReply } from './reply';

const bank = { triggers: { g: { ai: 'never' as const, lines: ['A', 'B', 'C'] } } };

test('standard mode keeps line history in the player store', () => {
  const store = createStore(null);
  createDialogue(bank, historyOptions(store)).say('g');
  expect(store.get().dialogueHistory.g).toHaveLength(1);
});

test('Family Table mode persists no dialogue history', () => {
  const store = createStore(null);
  store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
  const before = store.get();
  const opts = historyOptions(store);
  expect(opts.onHistory).toBeUndefined();
  const d = createDialogue(bank, opts);
  for (let i = 0; i < 3; i++) d.say('g');
  expect(store.get()).toBe(before); // no update at all
  expect(store.get().dialogueHistory).toEqual({});
});

describe('backend choice (M4 Step 10)', () => {
  test('Family Table → scripted; signed in with the AI mentor on → AI; otherwise scripted', () => {
    const s = createStore(null).get();
    expect(backendKind(s)).toBe('scripted');
    const signed = { ...s, account: { email: 'a@b.c' } };
    expect(backendKind(signed)).toBe('ai');
    expect(backendKind({ ...signed, settings: { ...s.settings, aiMentor: false } })).toBe('scripted');
    expect(backendKind({ ...signed, settings: { ...s.settings, familyTable: true } })).toBe('scripted');
  });

  test('the backend is rebuilt when the account or the AI setting changes, and late replies come from the current one', () => {
    const store = createStore(null);
    const built: { kind: 'scripted' | 'ai'; late?: (r: PanReply) => void }[] = [];
    const backend = switchingBackend(store, (kind) => {
      const b: { kind: 'scripted' | 'ai'; late?: (r: PanReply) => void } = { kind };
      built.push(b);
      return { kind, reply: () => Promise.reject(new Error('unused')), onLate: (fn) => { b.late = fn; return () => {}; } };
    });
    const seen: PanReply[] = [];
    backend.onLate?.((r) => seen.push(r));
    expect(backend.kind).toBe('scripted');
    store.update((s) => ({ ...s, account: { email: 'a@b.c' } }));
    expect(backend.kind).toBe('ai');
    store.update((s) => ({ ...s, dialogueHistory: { x: [1] } }));
    expect(built).toHaveLength(2);
    store.update((s) => ({ ...s, settings: { ...s.settings, aiMentor: false } }));
    expect(backend.kind).toBe('scripted');
    expect(built.map((b) => b.kind)).toEqual(['scripted', 'ai', 'scripted']);
    const r: PanReply = { items: [], cards: [], intents: [], actions: [], notice: null };
    built[1].late!(r); // an old backend's late reply is not shown
    built[2].late!(r);
    expect(seen).toEqual([r]);
  });

  test('the screen sent with a turn is the route, with the slug on a dish', () => {
    expect(screenOf('#/recipe/india/kerala/parippu')).toEqual({ route: 'recipe', slug: 'india/kerala/parippu' });
    expect(screenOf('#/settings')).toEqual({ route: 'settings' });
    expect(screenOf('#/nowhere')).toBeNull();
  });
});

test('N4: after a sign-out, the next Pan line leaves no earlier line history in localStorage', () => {
  const m = new Map<string, string>();
  const storage = {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, removeItem: (k: string) => { m.delete(k); }, setItem: (k: string, v: string) => { m.set(k, v); },
  } as Storage;
  const store = createStore(storage);
  store.update((s) => ({ ...s, account: { email: 'cook@example.test' } }));
  const dialogue = createDialogue(bank, historyOptions(store)); // mounted once, for the page's life
  dialogue.say('g');
  dialogue.say('g');
  // Sign-out: the account leaves, and its session's history is cleared from the store (progress/index.ts).
  store.update((s) => ({ ...s, account: null, dialogueHistory: {} }));
  dialogue.say('g');
  const saved = (JSON.parse(storage.getItem('kq.player.v1')!) as { dialogueHistory: Record<string, number[]> }).dialogueHistory;
  expect(saved).toEqual({ g: [expect.any(Number)] });
  // And a new account starts fresh too.
  store.update((s) => ({ ...s, account: { email: 'other@example.test' } }));
  dialogue.say('g');
  expect((JSON.parse(storage.getItem('kq.player.v1')!) as { dialogueHistory: Record<string, number[]> }).dialogueHistory.g).toHaveLength(1);
});

describe('M7 Ruling 17: the Family Table report', () => {
  test('a signed-in start reports it, then every change and every sign-in; signed out, or an unrelated change, sends nothing', async () => {
    const { reportFamilyTable } = await import('./family-report');
    const store = createStore(null);
    const sent: boolean[] = [];
    const client = { setFamilyTable: (on: boolean) => { sent.push(on); return Promise.resolve({ ok: true as const, status: 204, data: null }); } };
    const stop = reportFamilyTable(store, client);
    expect(sent).toEqual([]); // signed out
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    expect(sent).toEqual([]);
    store.update((s) => ({ ...s, account: { email: 'a@b.c' } }));
    expect(sent).toEqual([true]); // signing in reports it
    store.update((s) => ({ ...s, dialogueHistory: { x: [1] } }));
    expect(sent).toEqual([true]);
    // Each report settles before the next goes (fix round 3, N-5).
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    await new Promise((r) => setTimeout(r, 0));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual([true, false, true]);
    stop();
    // At every signed-in start, whatever it was before.
    const again: boolean[] = [];
    reportFamilyTable(store, { setFamilyTable: (on) => { again.push(on); return Promise.resolve({ ok: true as const, status: 204, data: null }); } });
    expect(again).toEqual([true]);
  });
});

describe('fix round 1 (I-4): the Family Table report is confirmed only by a 2xx and retried until it is', () => {
  const failed = { ok: false as const, status: 503, error: { code: 'http_503', message: '' } };
  const done = { ok: true as const, status: 204, data: null };
  function rig(answers: ('ok' | 'fail' | 'throw')[]) {
    const store = createStore(null);
    store.update((s) => ({ ...s, account: { email: 'a@b.c' }, settings: { ...s.settings, familyTable: true } }));
    const sent: boolean[] = [];
    const timers: { ms: number; fn: () => void }[] = [];
    const events = new EventTarget();
    const client = {
      setFamilyTable: (on: boolean) => {
        sent.push(on);
        const a = answers.shift() ?? 'ok';
        return a === 'throw' ? Promise.reject(new Error('x')) : Promise.resolve(a === 'ok' ? done : failed);
      },
    };
    const opts = { setTimer: (fn: () => void, ms: number) => { const t = { ms, fn }; timers.push(t); return t; }, clearTimer: (t: unknown) => { const i = timers.indexOf(t as never); if (i >= 0) timers.splice(i, 1); }, events };
    const fire = async () => { const t = timers.shift(); t?.fn(); await new Promise((r) => setTimeout(r, 0)); return t?.ms; };
    return { store, sent, timers, events, client, opts, fire };
  }

  test('a failed {on:true} is sent again after a growing backoff, and on `online`, until a 2xx; then nothing more', async () => {
    const { reportFamilyTable } = await import('./family-report');
    const r = rig(['fail', 'throw', 'fail', 'ok']);
    reportFamilyTable(r.store, r.client, r.opts);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent).toEqual([true]);
    const first = await r.fire();
    const second = await r.fire();
    expect(r.sent).toEqual([true, true, true]);
    expect(second!).toBeGreaterThan(first!);
    r.events.dispatchEvent(new Event('online'));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent).toEqual([true, true, true, true]);
    // Confirmed: no timer left, and an unrelated change sends nothing.
    expect(r.timers).toEqual([]);
    r.store.update((s) => ({ ...s, dialogueHistory: { x: [1] } }));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent).toHaveLength(4);
  });

  test('retrying stops on sign-out; a change to Family Table off sends {on:false} instead', async () => {
    const { reportFamilyTable } = await import('./family-report');
    const r = rig(['fail', 'ok']);
    reportFamilyTable(r.store, r.client, r.opts);
    await new Promise((res) => setTimeout(res, 0));
    r.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    await new Promise((res) => setTimeout(res, 0));
    expect(r.sent).toEqual([true, false]);
    expect(r.timers).toEqual([]);
    const o = rig(['fail']);
    reportFamilyTable(o.store, o.client, o.opts);
    await new Promise((res) => setTimeout(res, 0));
    expect(o.timers).toHaveLength(1);
    o.store.update((s) => ({ ...s, account: null }));
    expect(o.timers).toEqual([]);
    o.events.dispatchEvent(new Event('online'));
    await new Promise((res) => setTimeout(res, 0));
    expect(o.sent).toEqual([true]);
  });
});

describe('fix round 2: the report names this install, so another device\'s start-up report clears nothing', () => {
  test('A in Family Table and B not: B\'s start-up {on:false} leaves A\'s block; A\'s id is the same after a reload', async () => {
    const { reportFamilyTable } = await import('./family-report');
    const { deviceId } = await import('../state/device-id');
    // A fake of the API's per-device set (apps/api voice/family-devices.ts and family-routes.ts).
    const set = new Set<string>();
    let blocked = false;
    const server = {
      setFamilyTable: (on: boolean, id: string) => {
        if (on) { set.add(id); blocked = true; } else if (set.delete(id) && set.size === 0) blocked = false;
        return Promise.resolve({ ok: true as const, status: 204, data: null });
      },
    };
    const mem = () => { const m = new Map<string, string>(); return { get length() { return m.size; }, key: (i: number) => [...m.keys()][i] ?? null, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => { m.clear(); } } as Storage; };
    const deviceA = mem();
    const deviceB = mem();
    const signed = (ft: boolean) => { const s = createStore(null); s.update((x) => ({ ...x, account: { email: 'a@b.c' }, settings: { ...x.settings, familyTable: ft } })); return s; };
    const stopA = reportFamilyTable(signed(true), server, { deviceId: () => deviceId(deviceA) });
    await new Promise((r) => setTimeout(r, 0));
    expect(blocked).toBe(true);
    reportFamilyTable(signed(false), server, { deviceId: () => deviceId(deviceB) });
    await new Promise((r) => setTimeout(r, 0));
    expect(blocked).toBe(true);
    // A reloads: same id, reports on again; then turns Family Table off: the block lifts.
    stopA();
    const a2 = signed(true);
    reportFamilyTable(a2, server, { deviceId: () => deviceId(deviceA) });
    await new Promise((r) => setTimeout(r, 0));
    expect(set.size).toBe(1);
    a2.update((x) => ({ ...x, settings: { ...x.settings, familyTable: false } }));
    await new Promise((r) => setTimeout(r, 0));
    expect(blocked).toBe(false);
  });
});

describe('fix round 3: the Family Table report (N-4, N-5)', () => {
  const flushAll = () => new Promise((r) => setTimeout(r, 0));
  const opts = (timers: unknown[]) => ({ setTimer: (fn: () => void) => { timers.push(fn); return fn; }, clearTimer: (t: unknown) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }, events: new EventTarget(), deviceId: () => '0f1e2d3c-4b5a-4968-8776-655443322110' });
  const ft = () => { const s = createStore(null); s.update((x) => ({ ...x, account: { email: 'a@b.c' }, settings: { ...x.settings, familyTable: true } })); return s; };

  test('N-4: a 400 or a 404 (voice not offered) is final: no retry; 0, 429 and 5xx are retried', async () => {
    const { reportFamilyTable } = await import('./family-report');
    for (const status of [400, 404]) {
      const timers: unknown[] = [];
      let sent = 0;
      reportFamilyTable(ft(), { setFamilyTable: () => { sent++; return Promise.resolve({ ok: false as const, status, error: { code: 'x', message: '' } }); } }, opts(timers));
      await flushAll();
      expect(sent, String(status)).toBe(1);
      expect(timers, String(status)).toEqual([]);
    }
    for (const status of [0, 429, 502]) {
      const timers: unknown[] = [];
      reportFamilyTable(ft(), { setFamilyTable: () => Promise.resolve({ ok: false as const, status, error: { code: 'x', message: '' } }) }, opts(timers));
      await flushAll();
      expect(timers, String(status)).toHaveLength(1);
    }
  });

  test('N-5: reports go one at a time, in order: quick toggles on→off→on end with the server told on, last', async () => {
    const { reportFamilyTable } = await import('./family-report');
    const store = ft();
    const calls: { on: boolean; done: () => void }[] = [];
    let inFlight = 0;
    let most = 0;
    const client = {
      setFamilyTable: (on: boolean) => new Promise<{ ok: true; status: number; data: null }>((res) => {
        inFlight++;
        most = Math.max(most, inFlight);
        calls.push({ on, done: () => { inFlight--; res({ ok: true, status: 204, data: null }); } });
      }),
    };
    reportFamilyTable(store, client, opts([]));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    expect(calls.map((c) => c.on)).toEqual([true]);
    calls[0].done();
    await flushAll();
    // The first answered while the setting was on again: nothing left to say.
    expect(calls.map((c) => c.on)).toEqual([true]);
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: false } }));
    expect(calls.map((c) => c.on)).toEqual([true, false]);
    calls[1].done();
    await flushAll();
    expect(calls.map((c) => c.on)).toEqual([true, false]); // still off: confirmed
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    calls[2].done();
    await flushAll();
    expect(calls.map((c) => c.on)).toEqual([true, false, true]);
    expect(most).toBe(1);
  });
});
