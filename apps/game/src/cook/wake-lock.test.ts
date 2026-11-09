import { describe, expect, test } from 'vitest';
import { createWakeLock } from './wake-lock';

function fakeDoc() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: (_t: string, fn: () => void) => { listeners.add(fn); },
    removeEventListener: (_t: string, fn: () => void) => { listeners.delete(fn); },
    fire(state: 'visible' | 'hidden') { doc.visibilityState = state; for (const fn of [...listeners]) fn(); },
    listenerCount: () => listeners.size,
  };
  return doc;
}
function fakeNav(opts: { reject?: boolean } = {}) {
  const calls: string[] = [];
  const sentinels: { released: boolean; release(): Promise<void>; drop(): void }[] = [];
  const nav = {
    wakeLock: {
      request: async (type: string) => {
        calls.push(type);
        if (opts.reject) throw new Error('nope');
        let onRelease: () => void = () => {};
        const s = { released: false, release: async () => { s.released = true; }, addEventListener: (_t: string, fn: () => void) => { onRelease = fn; }, drop: () => { s.released = true; onRelease(); } };
        sentinels.push(s);
        return s;
      },
    },
  };
  return { nav, calls, sentinels };
}
const asNav = (n: unknown) => n as Navigator;
const asDoc = (d: unknown) => d as Document;

describe('wake lock', () => {
  test('unsupported without navigator.wakeLock', async () => {
    const wl = createWakeLock(asNav({}), asDoc(fakeDoc()));
    expect(await wl.enable()).toBe('unsupported');
    expect(wl.state).toBe('unsupported');
  });
  test('denied when request rejects', async () => {
    const { nav } = fakeNav({ reject: true });
    const wl = createWakeLock(asNav(nav), asDoc(fakeDoc()));
    expect(await wl.enable()).toBe('denied');
    expect(wl.state).toBe('denied');
  });
  test('on after enable, off after disable (released)', async () => {
    const { nav, calls, sentinels } = fakeNav();
    const wl = createWakeLock(asNav(nav), asDoc(fakeDoc()));
    expect(await wl.enable()).toBe('on');
    expect(calls).toEqual(['screen']);
    await wl.disable();
    expect(sentinels[0].released).toBe(true);
    expect(wl.state).toBe('off');
  });
  test('re-acquires on visible while enabled, not after disable', async () => {
    const { nav, calls, sentinels } = fakeNav();
    const doc = fakeDoc();
    const wl = createWakeLock(asNav(nav), asDoc(doc));
    await wl.enable();
    // the browser drops the lock when the tab is hidden
    doc.fire('hidden');
    sentinels[0].drop();
    doc.fire('visible');
    await Promise.resolve(); await Promise.resolve();
    expect(calls.length).toBe(2);
    await wl.disable();
    doc.fire('hidden'); doc.fire('visible');
    await Promise.resolve();
    expect(calls.length).toBe(2);
    expect(doc.listenerCount()).toBe(0);
  });
  test('disable while the request is pending releases it', async () => {
    const { nav, sentinels } = fakeNav();
    const wl = createWakeLock(asNav(nav), asDoc(fakeDoc()));
    const p = wl.enable();
    await wl.disable();
    await p;
    expect(sentinels[0].released).toBe(true);
    expect(wl.state).toBe('off');
  });
  test('two enables while a request is pending, then disable: every sentinel is released', async () => {
    const { nav, sentinels } = fakeNav();
    const wl = createWakeLock(asNav(nav), asDoc(fakeDoc()));
    const a = wl.enable(), b = wl.enable();
    await wl.disable();
    await Promise.all([a, b]);
    expect(sentinels.length).toBeGreaterThan(0);
    expect(sentinels.every((x) => x.released)).toBe(true);
  });
});
