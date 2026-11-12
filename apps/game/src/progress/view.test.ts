import { describe, expect, test } from 'vitest';
import { grantsForBatch, type ProgressEvent, type ProgressView } from '@kitchenquest/core/engine';
import { content } from '../content';
import { accountKey, createStore, withPartition } from '../state/store';
import { catalogueOf } from './catalogue';
import { appendEvents, deviceView, historyOf, newEventId } from './log';
import { currentProgress, maxView } from './view';

const cat = catalogueOf();
const EMPTY: ProgressView = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} };

function playedStore() {
  const store = createStore(null);
  const events: ProgressEvent[] = Array.from({ length: 12 }, (_, i) => ({
    id: newEventId(), kind: 'cooked', at: `2026-10-${String(i + 1).padStart(2, '0')}`, recipe: 'india/kerala/parippu', planned: false,
  }));
  const r = grantsForBatch(events, historyOf(store.get().progress), cat, content.rewards, content.techniques.freshness);
  appendEvents(store, null, r.map((x) => x.event), r.flatMap((x) => x.grants));
  return store;
}

describe('progress view', () => {
  test('maxView: stall answers ever correct on either side, last answered on the later date; a pre-M6 view has none (M6 Step 3)', () => {
    const a: ProgressView = { ...EMPTY, marketAnswered: { q1: { correct: true, lastAt: '2026-11-01' }, q2: { correct: false, lastAt: '2026-11-09' } } };
    const b: ProgressView = { ...EMPTY, marketAnswered: { q1: { correct: false, lastAt: '2026-11-05' }, q3: { correct: false, lastAt: '2026-10-01' } } };
    const want = { q1: { correct: true, lastAt: '2026-11-05' }, q2: { correct: false, lastAt: '2026-11-09' }, q3: { correct: false, lastAt: '2026-10-01' } };
    expect(maxView(a, b).marketAnswered).toEqual(want);
    expect(maxView(b, a).marketAnswered).toEqual(want);
    const { marketAnswered: _none, ...old } = EMPTY;
    expect(maxView(old as ProgressView, a).marketAnswered).toEqual(a.marketAnswered);
  });

  test('signed out: the device view, whatever the account says', () => {
    const store = playedStore();
    store.update((s) => withPartition(s, accountKey('a@example.test'), { events: [], grants: [], base: null, pendingUpload: [] }, { ...EMPTY, xp: 99_999, level: 9 }));
    expect(currentProgress(store.get(), cat)).toEqual(deviceView(store.get().progress, cat));
  });

  test('view: signed in, an account view lower than the device view (compacted events) shows the device values (C14, C15)', () => {
    // The account's own partition holds the played log (as if played signed in), and its cached view is lower.
    const played = playedStore().get().progress;
    const store = createStore(null);
    const account: ProgressView = { ...EMPTY, xp: 10, stamps: 0, trust: { haruka: 2 }, questsDone: ['haruka-gluey-rice'], cookedOn: { 'japan/osaka/onigiri': ['2026-09-01'] } };
    store.update((s) => withPartition({ ...s, account: { email: 'a@example.test' } }, accountKey('a@example.test'), played, account));
    const device = deviceView(played, cat);
    expect(device.level).toBeGreaterThan(1);
    const shown = currentProgress(store.get(), cat);
    expect(shown.xp).toBe(device.xp);
    expect(shown.level).toBe(device.level);
    expect(shown.toolkit.techniques.tempering.tier).toBe(device.toolkit.techniques.tempering.tier);
    // …and what only the account has is kept too: nothing shown drops, before or after the upload.
    expect(shown.trust.haruka).toBe(2);
    expect(shown.questsDone).toContain('haruka-gluey-rice');
    expect(shown.cookedOn['japan/osaka/onigiri']).toEqual(['2026-09-01']);
    expect(shown.cookedOn['india/kerala/parippu']).toEqual(device.cookedOn['india/kerala/parippu']);
  });

  test('maxView: every field is the larger, the union or the earliest start', () => {
    const a: ProgressView = {
      ...EMPTY, xp: 5, level: 3, stamps: 1, trust: { leela: 1 }, questSteps: { q: 2 }, questStartedOn: { q: '2026-05-02' },
      toolkit: { techniques: { tempering: { tier: 'yours', firstAt: '2026-02-01', lastUsedAt: '2026-03-01', recipes: ['a'] } } },
    };
    const b: ProgressView = {
      ...EMPTY, xp: 9, level: 2, stamps: 4, trust: { leela: 3, marisol: 1 }, questSteps: { q: 1 }, questStartedOn: { q: '2026-05-01' },
      toolkit: { techniques: { tempering: { tier: 'tried', firstAt: '2026-01-15', lastUsedAt: '2026-04-01', recipes: ['b'] } } },
    };
    const m = maxView(a, b);
    expect([m.xp, m.level, m.stamps]).toEqual([9, 3, 4]);
    expect(m.trust).toEqual({ leela: 3, marisol: 1 });
    expect(m.questSteps).toEqual({ q: 2 });
    expect(m.questStartedOn).toEqual({ q: '2026-05-01' });
    expect(m.toolkit.techniques.tempering).toEqual({ tier: 'yours', firstAt: '2026-01-15', lastUsedAt: '2026-04-01', recipes: ['a', 'b'] });
  });
});

// M5 final review m12: view() runs on every store change, from each subscriber. It is folded once per partition log
// (and cached account view), not once per call: an unrelated change re-uses it, a new event re-folds.
describe('m12: the view is memoised on the partition', () => {
  test('the same partition log gives the same view object; a change to it gives a new, correct one', () => {
    const store = playedStore();
    const first = currentProgress(store.get(), cat);
    store.update((s) => ({ ...s, settings: { ...s.settings, showCalories: !s.settings.showCalories } }));
    expect(currentProgress(store.get(), cat)).toBe(first);
    const e: ProgressEvent = { id: newEventId(), kind: 'cooked', at: '2026-10-20', recipe: 'india/kerala/parippu', planned: false };
    const r = grantsForBatch([e], historyOf(store.get().progress), cat, content.rewards, content.techniques.freshness);
    appendEvents(store, null, r.map((x) => x.event), r.flatMap((x) => x.grants));
    const next = currentProgress(store.get(), cat);
    expect(next).not.toBe(first);
    expect(next).toEqual(deviceView(store.get().progress, cat));
    expect(next.xp).toBeGreaterThanOrEqual(first.xp);
  });

  test('signed in: a new account view over the same log is shown at once (the cache keys on the view too)', () => {
    const played = playedStore().get().progress;
    const store = createStore(null);
    const key = accountKey('a@example.test');
    store.update((s) => withPartition({ ...s, account: { email: 'a@example.test' } }, key, played, { ...EMPTY, xp: 1 }));
    const low = currentProgress(store.get(), cat);
    store.update((s) => withPartition(s, key, played, { ...EMPTY, xp: 9_999_999 }));
    expect(currentProgress(store.get(), cat).xp).toBe(9_999_999);
    expect(low.xp).toBeLessThan(9_999_999);
  });
});
