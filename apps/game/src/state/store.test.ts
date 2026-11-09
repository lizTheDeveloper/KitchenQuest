import { describe, expect, it, vi } from 'vitest';
import { createStore, STORE_KEY } from './store';

function memStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() { return m.size; },
    clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

describe('createStore', () => {
  it('works in memory with null storage', () => {
    const s = createStore(null);
    expect(s.get().settings.showCalories).toBe(false);
    s.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    expect(s.get().settings.showCalories).toBe(true);
    expect(s.notice).toBeNull();
  });

  it('falls back to defaults when storage throws', () => {
    const bad = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } } as unknown as Storage;
    const s = createStore(bad);
    expect(s.get().localRules).toEqual([]);
    expect(() => s.update((x) => x)).not.toThrow();
    expect(s.notice).toBeNull();
  });

  it('keeps a copy of corrupt JSON and starts fresh', () => {
    const st = memStorage({ [STORE_KEY]: '{not json' });
    const s = createStore(st);
    expect(s.notice).toBe('corrupt');
    expect(st.getItem('kq.player.v1.corrupt')).toBe('{not json');
    expect(s.get().firstOpenedAt).toBeNull();
  });

  it('treats an unknown version as corrupt', () => {
    const raw = JSON.stringify({ v: 2, toolkit: { techniques: {} } });
    const st = memStorage({ [STORE_KEY]: raw });
    const s = createStore(st);
    expect(s.notice).toBe('corrupt');
    expect(st.getItem('kq.player.v1.corrupt')).toBe(raw);
  });

  it('does not overwrite an earlier rescue copy', () => {
    const st = memStorage({ [STORE_KEY]: 'bad2', 'kq.player.v1.corrupt': 'bad1' });
    createStore(st);
    expect(st.getItem('kq.player.v1.corrupt')).toBe('bad1');
    const copies = [...Array(st.length).keys()].map((i) => st.getItem(st.key(i)!));
    expect(copies).toContain('bad2');
  });

  it('merges a partial object over defaults', () => {
    const st = memStorage({ [STORE_KEY]: JSON.stringify({ settings: { showCalories: true } }) });
    const s = createStore(st);
    expect(s.notice).toBeNull();
    expect(s.get().settings).toEqual({ showCalories: true, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false });
    expect(s.get().v).toBe(1);
    expect(s.get().toolkit).toEqual({ techniques: {} });
  });

  it('persists updates and notifies subscribers; unsubscribe stops it', () => {
    const st = memStorage();
    const s = createStore(st);
    const fn = vi.fn();
    const off = s.subscribe(fn);
    s.update((x) => ({ ...x, firstOpenedAt: '2026-11-09T10:00:00.000Z' }));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(st.getItem(STORE_KEY)!).firstOpenedAt).toBe('2026-11-09T10:00:00.000Z');
    expect(createStore(st).get().firstOpenedAt).toBe('2026-11-09T10:00:00.000Z');
    off();
    s.update((x) => x);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
