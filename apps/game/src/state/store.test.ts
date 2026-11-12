import { describe, expect, it, vi } from 'vitest';
import { recordTechnique } from '@kitchenquest/core/engine';
import { accountKey, accountViewOf, applyServerErasure, createStore, eraseHealthEvents, prunePartition, deleteDeviceData, importM3Toolkit, mergePartitions, mergeProgress, partitionKey, partitionOf, STORE_KEY, withPartition } from './store';

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
    expect(s.get().settings).toEqual({ showCalories: true, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: true, rescueNudges: true });
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

describe('stopSaving', () => {
  it('after stopSaving, updates stay in memory and storage events are ignored: deleted data is never written back', () => {
    const st = memStorage();
    const events = new EventTarget();
    const s = createStore(st, events);
    s.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    s.stopSaving();
    deleteDeviceData(st);
    s.update((x) => ({ ...x, account: { email: 'cook@example.com' }, accountRules: [] }));
    expect(st.getItem(STORE_KEY)).toBeNull();
    expect(s.get().account).toEqual({ email: 'cook@example.com' });
    st.setItem(STORE_KEY, JSON.stringify({ v: 1, signOutPending: true }));
    events.dispatchEvent(Object.assign(new Event('storage'), { key: STORE_KEY }));
    expect(s.get().signOutPending).toBe(false);
    expect(JSON.parse(st.getItem(STORE_KEY)!)).toEqual({ v: 1, signOutPending: true });
  });
});

describe('M4 Step 9: new keys and confirmRules', () => {
  const rule = (id: string, ids = ['kiwi']) => ({ id, target: { kind: 'ingredient' as const, ids }, type: 'avoid' as const, severity: 'allergy' as const });

  it('confirmRules clears rulesUnreadable in one update even with conflicting versions in memory', () => {
    const storage = memStorage();
    const a = createStore(storage), b = createStore(storage);
    a.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi'])] }));
    b.update((x) => x); // b holds r1 = kiwi
    b.update((x) => ({ ...x, localRules: [rule('r1', ['kiwi', 'banana'])] })); // b rewrites r1
    // a still holds the old r1: its next update rebases into a conflict.
    expect(a.update((x) => x).rulesUnreadable).toBe(true);
    const ruleX = rule('rx', ['peanut']);
    const s = a.confirmRules([ruleX]);
    expect(s.rulesUnreadable).toBe(false);
    expect(s.localRules).toEqual([ruleX]);
    expect(JSON.parse(storage.getItem(STORE_KEY)!).rulesUnreadable).toBe(false);
    expect(JSON.parse(storage.getItem(STORE_KEY)!).localRules).toEqual([ruleX]);
    // The other tab, stale, cannot bring a conflict back by merging its in-memory r1.
    const later = b.update((x) => x);
    expect(later.localRules.map((r) => r.id).sort()).toEqual(['r1', 'rx']);
    expect(later.rulesUnreadable).toBe(false);
  });

  it('confirmRules still merges the toolkit and keeps other keys from storage', () => {
    const storage = memStorage();
    const a = createStore(storage), b = createStore(storage);
    b.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    const s = a.confirmRules([]);
    expect(s.settings.showCalories).toBe(true);
    expect(s.localRules).toEqual([]);
  });

  it('new keys default when absent', () => {
    const s = createStore(memStorage({ [STORE_KEY]: JSON.stringify({ v: 1 }) })).get();
    expect(s.localProfile).toBeNull();
    expect(s.localPantry).toEqual([]);
    expect(s.intake).toEqual({ step: null });
    expect(s.aiDisclosureSeen).toBe(false);
    expect(s.aiHealthOffered).toBe(false);
    expect(s.settings.aiMentor).toBe(true);
  });

  it('new keys round-trip', () => {
    const st = memStorage();
    const profile = { marketDays: [6], mealsPerWeek: 5, country: null, region: 'Kerala', mealWindows: [{ name: 'lunch' as const, start: '12:30', end: '13:30' }] };
    createStore(st).update((x) => ({
      ...x, localProfile: profile, localPantry: [{ id: 'p1', name: 'rice', ingredientId: 'rice' }], intake: { step: 'allergies' },
      aiDisclosureSeen: true, aiHealthOffered: true, settings: { ...x.settings, aiMentor: false },
    }));
    const s = createStore(st).get();
    expect(s.localProfile).toEqual(profile);
    expect(s.localPantry).toEqual([{ id: 'p1', name: 'rice', ingredientId: 'rice' }]);
    expect(s.intake).toEqual({ step: 'allergies' });
    for (const step of [null, 'done', 'market_day'] as const) {
      const st2 = memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, intake: { step } }) });
      expect(createStore(st2).get().intake).toEqual({ step });
    }
    expect([s.aiDisclosureSeen, s.aiHealthOffered, s.settings.aiMentor]).toEqual([true, true, false]);
  });

  it.each([
    [{ localPantry: 'x' }],
    [{ localPantry: [{ id: 'p1', name: 3, ingredientId: null }] }],
    [{ localProfile: { marketDays: 'sat' } }],
    [{ localProfile: { marketDays: [6], mealsPerWeek: null, country: null, region: null, mealWindows: [{ name: 'brunch', start: '10:00', end: '11:00' }] } }],
    [{ intake: { step: 'nope' } }],
    [{ intake: 'done' }],
    [{ intake: {} }],
    [{ intake: { step: 'toString' } }],
    [{ aiDisclosureSeen: 'yes' }],
    [{ aiHealthOffered: 1 }],
    [{ settings: { aiMentor: 'on' } }],
  ])('%j marks the data corrupt', (bad) => {
    const st = memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, ...bad }) });
    const s = createStore(st);
    expect(s.notice).toBe('corrupt');
    expect(s.get().rulesUnreadable).toBe(true);
  });
});

describe('progress (M5 Step 9)', () => {
  const m3 = {
    v: 1,
    toolkit: { techniques: { tempering: { tier: 'tried', firstAt: '2026-03-01', lastUsedAt: '2026-04-01', recipes: ['india/kerala/parippu'] } } },
  };

  it('store: M3 toolkit records become imported events once; a reload does not import twice', () => {
    const st = memStorage({ [STORE_KEY]: JSON.stringify(m3) });
    const s = createStore(st);
    const events = s.get().progress.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'imported', technique: 'tempering', tier: 'tried', firstAt: '2026-03-01', lastUsedAt: '2026-04-01', at: '2026-04-01', recipes: ['india/kerala/parippu'] });
    expect(events[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(s.get().progress.pendingUpload).toEqual([events[0].id]);
    // Saved at once: a reload (and a second tab) reads the import back instead of making another.
    const again = createStore(st);
    expect(again.get().progress.events.map((e) => e.id)).toEqual([events[0].id]);
    again.update((x) => x);
    expect(createStore(st).get().progress.events.filter((e) => e.kind === 'imported')).toHaveLength(1);
  });

  it('store: two tabs importing at once keep one imported event per technique', () => {
    const a = importM3Toolkit({ ...createStore(null).get(), toolkit: m3.toolkit as never });
    const b = importM3Toolkit({ ...createStore(null).get(), toolkit: m3.toolkit as never });
    const merged = mergeProgress(a.progress, b.progress);
    expect(merged.events.filter((e) => e.kind === 'imported')).toHaveLength(1);
  });

  it('store: a technique already folded into a compacted base is not imported again', () => {
    const base = { view: { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: m3.toolkit, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} }, facts: { v: 1, ids: ['x'] } };
    const s = importM3Toolkit({ ...createStore(null).get(), toolkit: m3.toolkit as never, progress: { events: [], grants: [], base: base as never, pendingUpload: [] } });
    expect(s.progress.events).toEqual([]);
  });

  it('store: a progress field of the wrong shape is unreadable, never silently dropped', () => {
    const st = memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, progress: { events: 'nope' } }) });
    expect(createStore(st).notice).toBe('corrupt');
  });

  it('store: mergeProgress unions by id and never drops a held event; the higher base wins', () => {
    const e = (id: string) => ({ id, kind: 'lesson' as const, at: '2026-11-09', recipe: 'india/kerala/parippu' });
    const g = (id: string) => ({ id: `${id}#0`, eventId: id, isoDay: '2026-11-09', kind: 'xp' as const, amount: 10, reason: 'lesson' as const });
    const a = { events: [e('a'), e('b')], grants: [g('a')], base: null, pendingUpload: ['a', 'b'] };
    const b = { events: [e('b'), e('c')], grants: [g('c')], base: null, pendingUpload: ['c'] };
    const m = mergeProgress(a, b);
    expect(m.events.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(m.grants.map((x) => x.id)).toEqual(['a#0', 'c#0']);
    expect(m.pendingUpload).toEqual(['a', 'b', 'c']);
    // A base covering 'a' (a compaction in one tab): 'a' is held by the base, every other event stays.
    const base = { view: { xp: 10, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} }, facts: { v: 1, ids: ['a'] } };
    const c = mergeProgress(a, { events: [e('b'), e('c')], grants: [], base, pendingUpload: [] });
    expect(c.base).toBe(base);
    expect(c.events.map((x) => x.id)).toEqual(['b', 'c']);
    expect(c.grants.map((x) => x.id)).toEqual([]);
    expect(mergeProgress({ ...a, base }, b).base).toBe(base); // never a lower (null) base
    // An update marking uploads done keeps them done.
    expect(mergeProgress(a, { ...a, pendingUpload: [] }, { pendingFrom: 'b' }).pendingUpload).toEqual([]);
  });

  it('store: an update can never drop a held progress event', () => {
    const s = createStore(memStorage());
    const e = { id: 'e1', kind: 'lesson' as const, at: '2026-11-09', recipe: 'india/kerala/parippu' };
    s.update((x) => ({ ...x, progress: { ...x.progress, events: [e] } }));
    s.update((x) => ({ ...x, progress: { ...x.progress, events: [] } }));
    expect(s.get().progress.events.map((x) => x.id)).toEqual(['e1']);
  });
});

describe('progress partitions (C1 ruling)', () => {
  const e = (id: string) => ({ id, kind: 'lesson' as const, at: '2026-11-09', recipe: 'india/kerala/parippu' });
  const log = (...ids: string[]) => ({ events: ids.map(e), grants: [], base: null, pendingUpload: ids });

  it('a store reload keeps the partitions, each with its own log and cached view', () => {
    const st = memStorage();
    const s = createStore(st);
    const view = { xp: 7, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} };
    s.update((x) => withPartition(withPartition(withPartition(x, null, log('g')), 'a@x.test', log('a'), view), 'b@x.test', log('b')));
    const again = createStore(st).get();
    expect(partitionOf(again, null).events.map((x) => x.id)).toEqual(['g']);
    expect(partitionOf(again, 'a@x.test').events.map((x) => x.id)).toEqual(['a']);
    expect(partitionOf(again, 'b@x.test').events.map((x) => x.id)).toEqual(['b']);
    expect(accountViewOf(again, 'a@x.test')).toEqual(view);
    expect(accountViewOf(again, 'b@x.test')).toBeNull();
  });

  it('mergePartitions never mixes partitions (another tab\'s A events stay A\'s, the guest\'s stay the guest\'s)', () => {
    const tab1 = { progress: log('g1'), accountProgress: { 'a@x.test': { progress: log('a1'), view: null } } };
    const tab2 = { progress: log('g2'), accountProgress: { 'a@x.test': { progress: log('a2'), view: null }, 'b@x.test': { progress: log('b1'), view: null } } };
    const m = mergePartitions(tab1, tab2);
    expect(m.progress.events.map((x) => x.id)).toEqual(['g1', 'g2']);
    expect(m.accountProgress['a@x.test'].progress.events.map((x) => x.id)).toEqual(['a1', 'a2']);
    expect(m.accountProgress['b@x.test'].progress.events.map((x) => x.id)).toEqual(['b1']);
  });

  it('the live partition follows the account: guest signed out, the account\'s own signed in', () => {
    const s = createStore(null);
    s.update((x) => withPartition(withPartition(x, null, log('g')), accountKey('a@x.test'), log('a')));
    expect(partitionOf(s.get(), partitionKey(s.get())).events.map((x) => x.id)).toEqual(['g']);
    s.update((x) => ({ ...x, account: { email: 'a@x.test' } }));
    expect(partitionOf(s.get(), partitionKey(s.get())).events.map((x) => x.id)).toEqual(['a']);
    s.update((x) => ({ ...x, account: { email: 'b@x.test' } }));
    expect(partitionOf(s.get(), partitionKey(s.get())).events).toEqual([]);
  });

  it('prunePartition keeps only the unsynced events (and their grants), drops the view, and a stale copy can\'t bring the rest back', () => {
    const key = accountKey('a@x.test');
    const view = { xp: 7, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} };
    const before = withPartition(createStore(null).get(), key, { ...log('a', 'b', 'c'), pendingUpload: ['c'], grants: [{ id: 'c#0', eventId: 'c', isoDay: '2026-11-09', kind: 'xp', amount: 10, reason: 'lesson' }, { id: 'a#0', eventId: 'a', isoDay: '2026-11-09', kind: 'xp', amount: 10, reason: 'lesson' }] }, view);
    const after = prunePartition(before, key);
    expect(partitionOf(after, key).events.map((x) => x.id)).toEqual(['c']);
    expect(partitionOf(after, key).grants.map((x) => x.id)).toEqual(['c#0']);
    expect(accountViewOf(after, key)).toBeNull();
    // Another tab still holding the old copy: the pruned one (a higher epoch) wins, both ways round.
    expect(mergePartitions(after, before).accountProgress[key].progress.events.map((x) => x.id)).toEqual(['c']);
    expect(mergePartitions(before, after).accountProgress[key].progress.events.map((x) => x.id)).toEqual(['c']);
    // And through the store: an update over a stale stored copy keeps the prune.
    const st = memStorage();
    const s1 = createStore(st);
    s1.update(() => before);
    s1.update((x) => prunePartition(x, key));
    expect(partitionOf(createStore(st).get(), key).events.map((x) => x.id)).toEqual(['c']);
    expect(st.getItem(STORE_KEY)).not.toContain('a@x.test');
  });
});


// M5 final I3: device weeks are kept PLAN_RETENTION_WEEKS (8) after they end, as H-11, also when nothing is saved:
// an old week leaves the device when the store loads, and on each sign-in and sign-out.
describe('I3: on-device retention for week data', () => {
  const NOW = new Date(2026, 10, 11, 12); // local Wed 11 Nov 2026
  const week = (weekStart: string) => ({ weekStart, items: [{ day: 0, kind: 'dish' as const, slug: 'india/kerala/parippu', servings: 2 }], hard: false, slot: 'unanswered' as const });
  const run = (weekStart: string) => ({ id: `r-${weekStart}`, weekStart, items: [], doneAt: null, pantryIds: {} });
  // The week of 2026-08-03 ended 2026-08-10, more than 8 weeks before today; 2026-09-14 ended inside the 8 weeks.
  const OLD = '2026-08-03', KEPT = '2026-09-14';
  const seeded = (account: { email: string } | null) =>
    memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, account, localWeek: { plans: [week(OLD), week(KEPT)], runs: [run(OLD), run(KEPT)] } }) });

  it.each([null, { email: 'cook@example.com' }])('an old device week vanishes at load (account %j), and storage is rewritten', (account) => {
    const st = seeded(account);
    const s = createStore(st, undefined, undefined, () => NOW);
    expect(s.get().localWeek.plans.map((p) => p.weekStart)).toEqual([KEPT]);
    expect(s.get().localWeek.runs.map((r) => r.weekStart)).toEqual([KEPT]);
    expect(JSON.parse(st.getItem(STORE_KEY)!).localWeek.plans.map((p: { weekStart: string }) => p.weekStart)).toEqual([KEPT]);
  });

  it('an old week is pruned again on sign-in and on sign-out', () => {
    let now = new Date(2026, 8, 20, 12); // 20 Sep: both weeks still inside retention at load
    const s = createStore(seeded(null), undefined, undefined, () => now);
    expect(s.get().localWeek.plans).toHaveLength(2);
    now = NOW;
    s.update((x) => ({ ...x, settings: { ...x.settings, showCalories: true } }));
    expect(s.get().localWeek.plans).toHaveLength(2); // an ordinary update is no retention point
    s.update((x) => ({ ...x, account: { email: 'cook@example.com' } })); // sign-in
    expect(s.get().localWeek.plans.map((p) => p.weekStart)).toEqual([KEPT]);
    now = new Date(2027, 0, 20, 12);
    s.update((x) => ({ ...x, account: null })); // sign-out
    expect(s.get().localWeek).toEqual({ plans: [], runs: [] });
  });
});

describe('M5 final m11: rescue nudges are kept per partition', () => {
  it("reads Step 10's single record as its partition's entry, and null as none", () => {
    const old = { key: 'guest', on: '2026-11-11', itemId: 'spinach', answered: true };
    expect(createStore(memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, rescue: old }) })).get().rescue).toEqual({ guest: { on: '2026-11-11', itemId: 'spinach', answered: true } });
    expect(createStore(memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, rescue: null }) })).get().rescue).toEqual({});
    expect(createStore(memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, rescue: { guest: { on: 'x' } } }) })).notice).toBe('corrupt');
  });
});

describe('M6 final review I1: a health_data withdraw-with-delete erases the device stall rounds', () => {
  const key = accountKey('cook@example.test');
  const at = '2026-11-09';
  const round = { id: 'r1', kind: 'stall_round' as const, at, stall: 'bram', answers: [{ q: 'bram-pc-most-protein', pick: 2 }] };
  const meal = { id: 'm1', kind: 'meal_logged' as const, at, minute: 600 };
  const lesson = { id: 'l1', kind: 'lesson' as const, at, recipe: 'india/kerala/parippu' };
  const grants = [
    { id: 'r1#0', eventId: 'r1', isoDay: at, kind: 'xp' as const, amount: 5, reason: 'market_game' as const },
    { id: 'r1#1', eventId: 'r1', isoDay: at, kind: 'stamp' as const, stamp: 'market_game' as const },
    { id: 'l1#0', eventId: 'l1', isoDay: at, kind: 'xp' as const, amount: 10, reason: 'lesson' as const },
  ];
  const answered = { 'bram-pc-cheapest': { correct: true, lastAt: '2026-11-02' } };
  const view = { xp: 15, level: 1, stamps: 1, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: answered };
  const seeded = () => withPartition({ ...createStore(null).get(), account: { email: 'cook@example.test' } }, key, {
    events: [round, meal, lesson], grants, pendingUpload: ['m1'],
    base: { view, facts: { v: 1, ids: ['old'], keys: ['["stall","bram","2026-W45"]', '["lesson","x","2026-W45"]'] } },
  }, view);

  it('drops every stall_round and meal_logged event, the answered ids in the base and the cached view; grants stay', () => {
    const s = eraseHealthEvents(seeded(), key);
    const p = partitionOf(s, key);
    expect(p.events.map((e) => e.id)).toEqual(['l1']);
    expect(p.pendingUpload).toEqual([]);
    expect(p.grants).toEqual(grants);
    expect(p.base?.view.marketAnswered).toEqual({});
    expect((p.base?.facts as { keys: string[] }).keys).toEqual(['["lesson","x","2026-W45"]']);
    expect(accountViewOf(s, key)?.marketAnswered).toEqual({});
    expect(accountViewOf(s, key)?.xp).toBe(15);
    expect(JSON.stringify(s.accountProgress)).not.toContain('bram-pc');
    expect(p.epoch).toBe(1);
  });

  it('the grants of erased events survive a merge with a copy of the same epoch (XP never drops), and the older copy loses', () => {
    const erased = partitionOf(eraseHealthEvents(seeded(), key), key);
    expect(mergeProgress(erased, { ...erased }).grants).toEqual(grants);
    expect(mergeProgress(partitionOf(seeded(), key), erased).events.map((e) => e.id)).toEqual(['l1']);
    // A grant whose event one copy still lists is kept only with that event (a skipped repeat import's grant goes).
    const imp = (id: string) => ({ id, kind: 'imported' as const, at, technique: 't1', tier: 'tried' as const, firstAt: at, lastUsedAt: at, recipes: [] });
    const g2 = { id: 'i2#0', eventId: 'i2', isoDay: at, kind: 'xp' as const, amount: 5, reason: 'lesson' as const };
    expect(mergeProgress({ events: [imp('i1')], grants: [], base: null, pendingUpload: [] }, { events: [imp('i2')], grants: [g2], base: null, pendingUpload: [] }).grants).toEqual([]);
  });

  it('leaves an account with no partition alone', () => {
    const s = createStore(null).get();
    expect(eraseHealthEvents(s, key)).toBe(s);
  });
});

describe('M7 Step 7 (M6 fix review N1): the server erase signal', () => {
  const key = accountKey('cook@example.test');
  const at = '2026-11-09';
  const round = { id: 'r1', kind: 'stall_round' as const, at, stall: 'bram', answers: [{ q: 'bram-pc-most-protein', pick: 2 }] };
  const lesson = { id: 'l1', kind: 'lesson' as const, at, recipe: 'india/kerala/parippu' };
  const grants = [{ id: 'r1#0', eventId: 'r1', isoDay: at, kind: 'xp' as const, amount: 5, reason: 'market_game' as const }];
  const view = { xp: 5, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: { 'bram-pc-most-protein': { correct: true, lastAt: at } } };
  const seeded = () => withPartition({ ...createStore(null).get(), account: { email: 'cook@example.test' } }, key, { events: [round, lesson], grants, pendingUpload: [], base: null }, view);
  const E1 = '11111111-1111-4111-8111-111111111111';
  const E2 = '22222222-2222-4222-8222-222222222222';

  it('a new erasure id erases the partition\'s stall rounds as the deleting device did (grants stay) and is kept; the same id again changes nothing', () => {
    const s = applyServerErasure(seeded(), key, E1);
    expect(partitionOf(s, key).events.map((e) => e.id)).toEqual(['l1']);
    expect(partitionOf(s, key).grants).toEqual(grants);
    expect(accountViewOf(s, key)?.marketAnswered).toEqual({});
    expect(s.accountProgress[key].erasure).toBe(E1);
    expect(JSON.stringify(s.accountProgress)).not.toContain('bram-pc');
    // Acted on once: a round recorded since stays when the same id comes back.
    const later = withPartition(s, key, { ...partitionOf(s, key), events: [...partitionOf(s, key).events, { ...round, id: 'r2' }] });
    expect(applyServerErasure(later, key, E1)).toBe(later);
    // A newer erasure (another delete) erases again.
    const again = applyServerErasure(later, key, E2);
    expect(partitionOf(again, key).events.map((e) => e.id)).toEqual(['l1']);
    expect(again.accountProgress[key].erasure).toBe(E2);
  });

  it('the id survives a sign-out prune, a merge with an older copy and a reload, so it is never acted on twice', () => {
    const s = applyServerErasure(seeded(), key, E1);
    expect(prunePartition(s, key).accountProgress[key].erasure).toBe(E1);
    const merged = mergePartitions(seeded(), s);
    expect(merged.accountProgress[key].erasure).toBe(E1);
    expect(merged.accountProgress[key].progress.events.map((e) => e.id)).toEqual(['l1']);
    const storage = memStorage();
    const st = createStore(storage);
    st.update(() => s);
    expect(createStore(storage).get().accountProgress[key].erasure).toBe(E1);
    // A stored erasure that is not a string is corrupt, never silently dropped.
    expect(createStore(memStorage({ [STORE_KEY]: JSON.stringify({ v: 1, accountProgress: { [key]: { progress: { events: [], grants: [], base: null, pendingUpload: [] }, view: null, erasure: 7 } } }) })).notice).toBe('corrupt');
  });

  it('with no partition for the account: the id is recorded, nothing else changes', () => {
    const s = { ...createStore(null).get(), account: { email: 'cook@example.test' } };
    const t = applyServerErasure(s, key, E1);
    expect(t.accountProgress[key]).toMatchObject({ erasure: E1, view: null });
    expect(partitionOf(t, key).events).toEqual([]);
  });
});
