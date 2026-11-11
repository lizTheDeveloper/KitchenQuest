import { describe, expect, test } from 'vitest';
import { compactHistory, deriveProgress, levelFor, trustLevel } from './derive';
import { CAT, DATA, EMPTY, T, addDays, ev, finishQuest, play } from './fixtures';
import { grantsFor } from './rewards';
import type { ProgressEvent, ProgressHistory, RewardsData } from './types';

const MON = '2026-01-05';

/** A varied history: quests, cooks across weeks, Yours, refreshes, meals, markets, frames, lessons, drills. */
function richHistory(): ProgressHistory {
  const events: ProgressEvent[] = [...finishQuest('leela-tempering', MON), ...finishQuest('marisol-salt-question', addDays(MON, 1))];
  for (let w = 0; w < 12; w++) {
    const d = addDays(MON, 7 * w);
    events.push(ev.cooked(w % 3 === 0 ? 'frijoles-de-olla' : 'parippu', d), ev.meal(d, 480), ev.meal(d, 540), ev.meal(d, 700), ev.market(addDays(d, 5)), ev.lesson('onigiri', d));
    if (w % 4 === 0) events.push(ev.frame('fried-rice', 'stir-fry', d), ev.drill('leela-tempering', 3, 'knife', d));
  }
  events.push(ev.cooked('parippu', addDays(MON, 300)), ev.cooked('sambar', addDays(MON, 300)));
  return play(events).history;
}

const nextEvents = (): ProgressEvent[] => [
  ev.cooked('parippu', addDays(MON, 301)),
  ev.cooked('parippu', addDays(MON, 300)),
  ev.cooked('sambar', addDays(MON, 700)),
  ev.meal(addDays(MON, 77), 900),
  ev.meal(addDays(MON, 300), 600),
  ev.market(addDays(MON, 82)),
  ev.lesson('onigiri', addDays(MON, 70)),
  ev.step('haruka-gluey-rice', 1, addDays(MON, 302)),
  ev.done('leela-tempering', addDays(MON, 302)),
  ev.cooked('frijoles-de-olla', addDays(MON, 300)),
  { ...ev.cooked('parippu', addDays(MON, 303)) },
];

describe('levelFor', () => {
  test('1 below the first threshold, one more per threshold reached', () => {
    expect(levelFor(0, DATA.levels)).toBe(1);
    expect(levelFor(99, DATA.levels)).toBe(1);
    expect(levelFor(100, DATA.levels)).toBe(2);
    expect(levelFor(2499, DATA.levels)).toBe(8);
    expect(levelFor(1e9, DATA.levels)).toBe(9);
  });

  test('raising a level threshold in data after the fact keeps every level already granted', () => {
    const p = play([...finishQuest('leela-tempering', MON), ev.cooked('parippu', MON), ev.cooked('frijoles-de-olla', MON)]);
    expect(deriveProgress(p.history, CAT).level).toBe(2);
    const steeper: RewardsData = { ...DATA, levels: [1000, 5000] };
    expect(deriveProgress(p.history, CAT).level).toBe(2); // the view reads grants, never the curve
    const next = grantsFor(ev.cooked('onigiri', MON), p.history, CAT, steeper, T);
    expect(next.problems).toEqual([]);
    expect(next.grants.filter((g) => g.kind === 'level')).toEqual([]);
    const after = play([ev.cooked('onigiri', MON)], p.history, steeper);
    expect(deriveProgress(after.history, CAT).level).toBe(2);
    // A gentler curve later grants the levels now reached, one grant per level crossed.
    const gentler: RewardsData = { ...DATA, levels: [10, 20, 30, 40] };
    const g = grantsFor(ev.lesson('onigiri', MON), after.history, CAT, gentler, T);
    expect(g.grants.filter((x) => x.kind === 'level').map((x) => x.kind === 'level' && x.level)).toEqual([3, 4, 5]);
  });
});

describe('trustLevel', () => {
  test('Stranger without the quest; Guest with it; then the cook-week thresholds', () => {
    expect(trustLevel(50, false, DATA)).toBe(0);
    expect([0, 1, 2, 3, 4, 6, 7, 9, 10, 99].map((w) => trustLevel(w, true, DATA))).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('deriveProgress', () => {
  test('empty history', () => {
    expect(deriveProgress(EMPTY, CAT)).toEqual({ xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {} });
  });

  test('sums grants and folds events', () => {
    const h = richHistory();
    const v = deriveProgress(h, CAT);
    const xp = h.grants.reduce((s, g) => s + (g.kind === 'xp' ? g.amount : 0), 0);
    expect(v.xp).toBe(xp);
    expect(v.stamps).toBe(h.grants.filter((g) => g.kind === 'stamp').length);
    expect(v.questsDone).toEqual(['leela-tempering', 'marisol-salt-question']);
    expect(v.trust.leela).toBeGreaterThanOrEqual(2);
    expect(v.framesCookedOn['fried-rice']).toHaveLength(3);
  });
});

describe('compactHistory', () => {
  test('compactHistory: derived view and the grants of a next event are identical before and after; nothing lowers (C15)', () => {
    const h = richHistory();
    const full = deriveProgress(h, CAT);
    for (const keep of [0, 1, 5, 17, h.events.length - 1, h.events.length, h.events.length + 10]) {
      const c = compactHistory(h, keep, CAT);
      expect(c.events.length).toBe(Math.min(keep, h.events.length));
      // Stored as JSON on the device: the round trip must change nothing.
      const stored = JSON.parse(JSON.stringify(c)) as ProgressHistory;
      for (const view of [deriveProgress(c, CAT), deriveProgress(stored, CAT)]) expect(view, `keep ${keep}`).toEqual(full);
      for (const e of nextEvents()) {
        const want = grantsFor(e, h, CAT, DATA, T);
        expect(grantsFor(e, c, CAT, DATA, T), `keep ${keep} ${e.kind}`).toEqual(want);
        expect(grantsFor(e, stored, CAT, DATA, T)).toEqual(want);
      }
      // A replay of a folded event is still a duplicate.
      expect(grantsFor(h.events[0], c, CAT, DATA, T).problems).toContain('duplicate_id');
    }
  });

  test('compacting twice, and playing on after compaction, matches the uncompacted history', () => {
    const h = richHistory();
    const once = compactHistory(h, 20, CAT);
    const twice = compactHistory(once, 5, CAT);
    expect(deriveProgress(twice, CAT)).toEqual(deriveProgress(h, CAT));
    const more = nextEvents();
    expect(deriveProgress(play(more, twice).history, CAT)).toEqual(deriveProgress(play(more, h).history, CAT));
  });

  test('a corrupt stored base reads as empty and never throws', () => {
    for (const base of [{ view: null, facts: null }, { view: { xp: -5, level: 'x' }, facts: { ids: 'no', perDate: [], keys: [1] } }]) {
      const h = { events: [], grants: [], base } as unknown as ProgressHistory;
      expect(() => deriveProgress(h, CAT)).not.toThrow();
      expect(deriveProgress(h, CAT)).toMatchObject({ xp: 0, level: 1 });
      expect(grantsFor(ev.cooked('parippu', MON), h, CAT, DATA, T).problems).toEqual([]);
    }
  });
});

test('I3: compaction keeps the nourishment facts of a folded date: a 4th qualifying meal there earns nothing', () => {
  const day = MON;
  const h = play([ev.meal(day, 480), ev.meal(day, 600), ev.meal(day, 720), ev.cooked('parippu', addDays(day, 1))]).history;
  const c = compactHistory(h, 1, CAT); // all three meals are in the base now
  expect(c.events).toHaveLength(1);
  const late = ev.meal(day, 1000);
  expect(grantsFor(late, h, CAT, DATA, T).grants).toEqual([]);
  expect(grantsFor(late, c, CAT, DATA, T).grants).toEqual([]);
  expect(grantsFor(late, JSON.parse(JSON.stringify(c)) as ProgressHistory, CAT, DATA, T).grants).toEqual([]);
  // And the 2 h gap against a folded meal still holds.
  const h2 = play([ev.meal(day, 480), ev.cooked('parippu', addDays(day, 1))]).history;
  expect(grantsFor(ev.meal(day, 540), compactHistory(h2, 1, CAT), CAT, DATA, T).grants).toEqual([]);
});
