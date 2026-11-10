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
    ['signOutPending is not a boolean', { signOutPending: 'yes' }],
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
    expect(t.tadka.tier).toBe('tried');
    // a stale lesson on tadka cannot lower the tier
    b.update((x) => ({ ...x, toolkit: { techniques: { ...x.toolkit.techniques, tadka: { ...t.tadka, tier: 'seen', lastUsedAt: '2026-01-01' } } } }));
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

describe('rebasing and failures', () => {
  const rule = (id: string, ids = ['kiwi']) => ({ id, target: { kind: 'ingredient' as const, ids }, type: 'avoid' as const, severity: 'allergy' as const });

  it('a failed write goes memory-only with a notice, and the next update keeps the rule', () => {
    const st = memStorage();
    let fail = false;
    const flaky: Storage = Object.assign(Object.create(st), {
      getItem: (k: string) => st.getItem(k),
      setItem: (k: string, v: string) => { if (fail) throw new Error('quota'); st.setItem(k, v); },
    });
    const s = createStore(flaky);
    s.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    fail = true;
    s.update((x) => ({ ...x, localRules: [rule('r1')] }));
    expect(s.notice).toBe('unsaved');
    fail = false;
    s.update((x) => ({ ...x, cookProgress: { slug: 'a/b', step: 2 } }));
    expect(s.get().localRules.map((r) => r.id)).toEqual(['r1']);
    expect(s.get().cookProgress).toEqual({ slug: 'a/b', step: 2 });
    expect(JSON.parse(st.getItem(STORE_KEY)!).localRules).toEqual([]); // still memory-only: storage untouched
  });

  it('two stores adding different rules keep both', () => {
    const st = memStorage();
    const a = createStore(st), b = createStore(st);
    a.update((x) => ({ ...x, localRules: [rule('r1')] }));
    b.update((x) => ({ ...x, localRules: [...x.localRules, rule('r2', ['peanut'])] }));
    const got = createStore(st).get();
    expect(got.localRules.map((r) => r.id).sort()).toEqual(['r1', 'r2']);
    expect(got.rulesUnreadable).toBe(false);
  });

  it('a conflicting edit to the same id keeps both versions and sets rulesUnreadable', () => {
    const st = memStorage();
    const a = createStore(st), b = createStore(st);
    a.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi'])] }));
    b.update((x) => x); // b now holds r1 = kiwi
    a.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi', 'banana'])] }));
    b.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } })); // b is stale
    const got = createStore(st).get();
    expect(got.localRules.filter((r) => r.id === 'r1')).toHaveLength(2);
    expect(got.rulesUnreadable).toBe(true);
  });

  it('does not resurrect data another tab deleted: resets and reloads', () => {
    const st = memStorage();
    const wiped = vi.fn();
    const a = createStore(st, undefined, wiped);
    a.update((x) => ({ ...x, localRules: [rule('r1')] }));
    deleteDeviceData(st);
    a.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(a.get().localRules).toEqual([]);
    expect(st.getItem(STORE_KEY)).toBeNull();
  });

  it('an update cannot clear rulesUnreadable when its own rebase finds a conflict', () => {
    const st = memStorage();
    const a = createStore(st), b = createStore(st);
    a.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi'])] }));
    b.update((x) => x); // b now holds r1 = kiwi
    a.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi', 'banana'])] }));
    // b, stale, "confirms" its rules: the conflict only appears inside this update's rebase.
    const got = b.update((x) => ({ ...x, rulesUnreadable: false }));
    expect(got.rulesUnreadable).toBe(true);
    expect(createStore(st).get().rulesUnreadable).toBe(true);
    // With no conflict in the rebase, clearing works.
    const c = createStore(st);
    c.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi', 'banana'])], rulesUnreadable: false }));
    expect(createStore(st).get().rulesUnreadable).toBe(false);
  });

  it('a rule added in a stale tab after another tab deleted the data is kept on a fresh state, then reloads', () => {
    const st = memStorage();
    const wiped = vi.fn();
    const a = createStore(st, undefined, wiped);
    a.update((x) => ({ ...x, localRules: [rule('r1')], settings: { ...x.settings, showCalories: true } }));
    deleteDeviceData(st); // another tab
    a.update((x) => ({ ...x, localRules: [...x.localRules, rule('r2', ['peanut'])] }));
    expect(wiped).toHaveBeenCalledTimes(1);
    const saved = createStore(st).get();
    expect(saved.localRules.map((r) => r.id)).toEqual(['r2']); // the new rule survives; deleted r1 does not return
    expect(saved.settings.showCalories).toBe(false); // nothing else is resurrected
    expect(a.get().localRules.map((r) => r.id)).toEqual(['r2']);
  });

  it('a stale-tab rule whose save fails stays in memory with a notice rather than reloading', () => {
    const st = memStorage();
    let fail = false;
    const failing: Storage = Object.assign(Object.create(st) as Storage, {
      setItem: (k: string, v: string) => { if (fail) throw new Error('quota'); st.setItem(k, v); },
      getItem: (k: string) => st.getItem(k),
    });
    const wiped = vi.fn();
    const a = createStore(failing, undefined, wiped);
    a.update((x) => ({ ...x, localRules: [rule('r1')] }));
    deleteDeviceData(st);
    fail = true;
    a.update((x) => ({ ...x, localRules: [...x.localRules, rule('r2', ['peanut'])] }));
    expect(wiped).not.toHaveBeenCalled();
    expect(a.notice).toBe('unsaved');
    expect(a.get().localRules.map((r) => r.id)).toEqual(['r2']);
  });

  it('a storage event for a deleted key also resets and reloads', () => {
    const st = memStorage();
    const target = new EventTarget();
    const wiped = vi.fn();
    const a = createStore(st, target, wiped);
    a.update((x) => x);
    deleteDeviceData(st);
    target.dispatchEvent(Object.assign(new Event('storage'), { key: STORE_KEY }));
    expect(wiped).toHaveBeenCalledTimes(1);
    expect(st.getItem(STORE_KEY)).toBeNull();
  });

  it.each([
    ['bad tier', { tadka: { tier: 'master', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: [] } }],
    ['bad date', { tadka: { tier: 'seen', firstAt: 'yesterday', lastUsedAt: '2026-11-01', recipes: [] } }],
    ['recipes not an array', { tadka: { tier: 'seen', firstAt: '2026-11-01', lastUsedAt: '2026-11-01', recipes: 'x' } }],
    ['record is null', { tadka: null }],
  ])('a malformed toolkit record takes the corrupt path (%s)', (_n, techniques) => {
    const raw = JSON.stringify({ v: 1, toolkit: { techniques } });
    const st = memStorage({ [STORE_KEY]: raw });
    const s = createStore(st);
    expect(s.notice).toBe('corrupt');
    expect(st.getItem('kq.player.v1.corrupt')).toBe(raw);
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

describe('prototype-named technique keys in stored data', () => {
  const rec = (tier: string, at: string) => ({ tier, firstAt: at, lastUsedAt: at, recipes: ['r'] });
  it('a stored "__proto__" technique is kept as data and merged, never as a prototype', () => {
    const raw = `{"v":1,"toolkit":{"techniques":{"__proto__":${JSON.stringify(rec('tried', '2026-01-01'))},"constructor":${JSON.stringify(rec('seen', '2026-01-01'))}}}}`;
    const st = memStorage({ [STORE_KEY]: raw });
    const s = createStore(st);
    expect(s.notice).toBeNull();
    s.update((x) => ({ ...x, toolkit: recordTechnique(x.toolkit, { kind: 'cooked', technique: 'constructor', at: '2026-02-01', recipe: 'q' }) }));
    const t = s.get().toolkit.techniques;
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect(Object.hasOwn(t, '__proto__')).toBe(true);
    expect(t['__proto__']).toEqual(rec('tried', '2026-01-01'));
    expect(t.constructor).toMatchObject({ tier: 'yours', recipes: ['r', 'q'] });
    const saved = JSON.parse(st.getItem(STORE_KEY)!) as { toolkit: { techniques: Record<string, unknown> } };
    expect(Object.keys(saved.toolkit.techniques).sort()).toEqual(['__proto__', 'constructor']);
    expect(({} as Record<string, unknown>).tier).toBeUndefined();
  });

  it('merging in a "__proto__" technique that storage lacks keeps it as an own key', () => {
    const raw = `{"v":1,"toolkit":{"techniques":{"__proto__":${JSON.stringify(rec('tried', '2026-01-01'))}}}}`;
    const st = memStorage({ [STORE_KEY]: raw });
    const events = new EventTarget();
    const s = createStore(st, events);
    st.setItem(STORE_KEY, `{"v":1,"toolkit":{"techniques":{"boil":${JSON.stringify(rec('seen', '2026-01-02'))}}}}`); // another tab, without it
    events.dispatchEvent(Object.assign(new Event('storage'), { key: STORE_KEY }));
    const t = s.get().toolkit.techniques;
    expect(Object.getPrototypeOf(t)).toBe(Object.prototype);
    expect(Object.hasOwn(t, '__proto__')).toBe(true);
    expect(Object.keys(t).sort()).toEqual(['__proto__', 'boil']);
    expect(t['__proto__']).toEqual(rec('tried', '2026-01-01'));
  });
});
