import { describe, expect, it, vi } from 'vitest';
import { recordTechnique } from '@kitchenquest/core/engine';
import { createStore, deleteDeviceData, STORE_KEY } from './store';

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

  it('rotates rescue copies and keeps only the 3 most recent', () => {
    const st = memStorage();
    for (const bad of ['bad1', 'bad2', 'bad3', 'bad4']) {
      st.setItem(STORE_KEY, bad);
      createStore(st);
    }
    expect(st.getItem('kq.player.v1.corrupt')).toBe('bad4');
    expect(st.getItem('kq.player.v1.corrupt.1')).toBe('bad3');
    expect(st.getItem('kq.player.v1.corrupt.2')).toBe('bad2');
    expect(st.getItem('kq.player.v1.corrupt.3')).toBeNull();
    const corrupt = [...Array(st.length).keys()].map((i) => st.key(i)!).filter((k) => k.includes('.corrupt'));
    expect(corrupt).toHaveLength(3);
  });

  it('does not stack duplicate copies of the same unreadable data across reloads', () => {
    const st = memStorage({ [STORE_KEY]: 'bad' });
    createStore(st); createStore(st);
    expect(st.getItem('kq.player.v1.corrupt.1')).toBeNull();
  });

  it.each([
    ['localRules is not an array', { localRules: 'nope' }],
    ['toolkit has the wrong shape', { toolkit: { techniques: 5 } }],
    ['settings is not an object', { settings: 3 }],
    ['a setting has the wrong type', { settings: { showCalories: 'yes' } }],
    ['reducedMotion is unknown', { settings: { reducedMotion: 'sometimes' } }],
    ['accountRules is a string', { accountRules: 'x' }],
    ['cookProgress is malformed', { cookProgress: { slug: 1 } }],
  ])('treats a present-but-wrong-shape key as corrupt (%s)', (_n, patch) => {
    const raw = JSON.stringify({ v: 1, ...patch });
    const st = memStorage({ [STORE_KEY]: raw });
    const s = createStore(st);
    expect(s.notice).toBe('corrupt');
    expect(st.getItem('kq.player.v1.corrupt')).toBe(raw);
    expect(st.getItem(STORE_KEY)).toBe(raw); // the original is not overwritten
  });

  it('keeps the rules-unreadable flag across reloads until rules are confirmed', () => {
    const st = memStorage({ [STORE_KEY]: '{broken' });
    const s = createStore(st);
    expect(s.get().rulesUnreadable).toBe(true);
    expect(createStore(st).get().rulesUnreadable).toBe(true); // reload before any update
    s.update((x) => ({ ...x, firstOpenedAt: '2026-11-09T10:00:00.000Z' }));
    const again = createStore(st);
    expect(again.notice).toBeNull();
    expect(again.get().rulesUnreadable).toBe(true); // persisted
    again.update((x) => ({ ...x, rulesUnreadable: false }));
    expect(createStore(st).get().rulesUnreadable).toBe(false);
  });

  it('stays in memory and never overwrites the original when the backup write fails', () => {
    const st = memStorage({ [STORE_KEY]: '{broken' });
    const failing: Storage = Object.assign(Object.create(st), {
      getItem: (k: string) => st.getItem(k),
      setItem: (k: string) => { if (k.includes('corrupt')) throw new Error('quota'); st.setItem(k, 'x'); },
    });
    const s = createStore(failing);
    expect(s.notice).toBe('corrupt');
    s.update((x) => ({ ...x, firstOpenedAt: 'now' }));
    expect(st.getItem(STORE_KEY)).toBe('{broken');
    expect(s.get().firstOpenedAt).toBe('now');
    expect(s.get().rulesUnreadable).toBe(true);
  });

  it('stays in memory and never writes when getItem throws', () => {
    const writes: string[] = [];
    const bad = { getItem: () => { throw new Error('no'); }, setItem: (k: string) => { writes.push(k); } } as unknown as Storage;
    const s = createStore(bad);
    expect(s.get().rulesUnreadable).toBe(true);
    s.update((x) => x);
    expect(writes).toEqual([]);
  });

  it('two stores on one storage do not lose each other\'s toolkit data', () => {
    const st = memStorage();
    const a = createStore(st);
    const b = createStore(st);
    a.update((x) => ({ ...x, toolkit: recordTechnique(x.toolkit, { kind: 'cooked', technique: 'tadka', at: '2026-11-01', recipe: 'a/b/c' }) }));
    // b is stale: it has not seen tadka. Its own update must build on what is stored.
    b.update((x) => ({ ...x, toolkit: recordTechnique(x.toolkit, { kind: 'lesson', technique: 'dice', at: '2026-11-02' }) }));
    const t = createStore(st).get().toolkit.techniques;
    expect(Object.keys(t).sort()).toEqual(['dice', 'tadka']);
    expect(t.tadka!.tier).toBe('tried');
    // a stale lesson on tadka cannot lower the tier
    b.update((x) => ({ ...x, toolkit: { techniques: { ...x.toolkit.techniques, tadka: { ...t.tadka!, tier: 'seen', lastUsedAt: '2026-01-01' } } } }));
    expect(createStore(st).get().toolkit.techniques.tadka).toMatchObject({ tier: 'tried', lastUsedAt: '2026-11-01' });
  });

  it('follows the storage event from another tab', () => {
    const st = memStorage();
    const target = new EventTarget();
    const a = createStore(st);
    const b = createStore(st, target);
    const seen = vi.fn();
    b.subscribe(seen);
    a.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    expect(b.get().settings.showCalories).toBe(false);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: STORE_KEY }));
    expect(b.get().settings.showCalories).toBe(true);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('deleteDeviceData', () => {
  it('removes every kq.* key including rescue copies, and nothing else', () => {
    const st = memStorage({ [STORE_KEY]: '{}', 'kq.player.v1.corrupt': 'a', 'kq.player.v1.corrupt.1': 'b', other: 'keep' });
    const removed = deleteDeviceData(st);
    expect(removed.sort()).toEqual(['kq.player.v1', 'kq.player.v1.corrupt', 'kq.player.v1.corrupt.1']);
    expect(st.length).toBe(1);
    expect(st.getItem('other')).toBe('keep');
  });
});

describe('createStore (more)', () => {
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
