// Fix round 1, I1 and I2 (ruling in progress.md): grants are self-contained, and erasing an event never lowers XP.
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compactHistory, deriveProgress, eraseEvents } from './derive';
import { CAT, DATA, EMPTY, T, addDays, ev, finishQuest, last, play, xpOf } from './fixtures';
import { grantsFor, grantsForBatch } from './rewards';
import type { ProgressEvent, ProgressHistory } from './types';

const MON = '2026-01-05';
const nourishOn = (h: ProgressHistory, day: string) => h.grants.filter((g) => g.kind === 'xp' && g.reason === 'nourishment' && g.isoDay === day).length;

describe('self-contained grants', () => {
  test('every grant carries its own id, eventId and isoDay, and no event content', () => {
    const p = play([...finishQuest('leela-tempering', MON), ev.cooked('parippu', addDays(MON, 1)), ev.meal(MON, 600)]);
    const ids = new Set<string>();
    for (const g of p.history.grants) {
      const e = p.history.events.find((x) => x.id === g.eventId);
      expect(e).toBeDefined();
      expect(g.isoDay).toBe(e?.at);
      expect(typeof g.id).toBe('string');
      ids.add(g.id);
      // No event content: never a recipe, a quest, a minute or a week start on a grant.
      for (const k of ['recipe', 'quest', 'minute', 'weekStart', 'frame', 'step', 'planned']) expect(Object.hasOwn(g, k), k).toBe(false);
    }
    expect(ids.size).toBe(p.history.grants.length);
  });
});

describe('I1: a grant whose event is gone still marks its id as seen', () => {
  test('replaying an erased event id is a duplicate and earns nothing again', () => {
    const p = play(finishQuest('leela-tempering', MON));
    const done = p.history.events[p.history.events.length - 1];
    const erased = eraseEvents(p.history, [done.id]);
    expect(deriveProgress(erased, CAT).xp).toBe(40);
    expect(grantsFor(done, erased, CAT, DATA, T)).toMatchObject({ grants: [], problems: ['duplicate_id'], warnings: [] });
    const meal = ev.meal(MON, 600);
    const m = eraseEvents(play([meal]).history, [meal.id]);
    expect(grantsFor(meal, m, CAT, DATA, T).problems).toEqual(['duplicate_id']);
  });
});

describe('I2: erasure keeps XP and the nourishment cap', () => {
  test('the 3-a-day cap counts grants by their own isoDay, even when every meal event is erased', () => {
    const meals = [ev.meal(MON, 480), ev.meal(MON, 600), ev.meal(MON, 720)];
    const p = play(meals);
    const erased = eraseEvents(p.history, meals.map((e) => e.id));
    expect(erased.events).toEqual([]);
    expect(deriveProgress(erased, CAT).xp).toBe(15);
    expect(xpOf(last(play([ev.meal(MON, 1000)], erased)).grants)).toBe(0);
    expect(xpOf(last(play([ev.meal(addDays(MON, 1), 1000)], erased)).grants)).toBe(5);
  });

  test('the 2 h gap compares surviving meal-log events only', () => {
    const a = ev.meal(MON, 480);
    const p = play([a]);
    expect(xpOf(last(play([ev.meal(MON, 540)], p.history)).grants)).toBe(0); // 1 h after a surviving log
    expect(xpOf(last(play([ev.meal(MON, 540)], eraseEvents(p.history, [a.id]))).grants)).toBe(5); // the 480 log is gone
  });

  test('eraseEvents keeps every grant and leaves an unknown id alone', () => {
    const p = play([ev.meal(MON, 480), ev.cooked('parippu', MON)]);
    const e = eraseEvents(p.history, ['nope', p.history.events[0].id]);
    expect(e.grants).toEqual(p.history.grants);
    expect(e.events).toEqual([p.history.events[1]]);
    expect(e.base).toBe(p.history.base);
  });
});

// ---- properties -----------------------------------------------------------------------------------------------

const START = '2026-01-01';
const dateArb = fc.integer({ min: 0, max: 60 }).map((d) => addDays(START, d));
const draftArb = fc.oneof(
  fc.record({ kind: fc.constant('meal_logged' as const), at: dateArb, minute: fc.integer({ min: 0, max: 1439 }) }),
  fc.record({ kind: fc.constant('cooked' as const), at: dateArb, recipe: fc.constantFrom('parippu', 'onigiri', 'frijoles-de-olla', 'sambar'), planned: fc.boolean() }),
  fc.record({ kind: fc.constant('lesson' as const), at: dateArb, recipe: fc.constantFrom('parippu', 'onigiri') }),
  fc.record({ kind: fc.constant('market_run' as const), at: dateArb, weekStart: dateArb }),
  fc.record({ kind: fc.constant('frame_cooked' as const), at: dateArb, frame: fc.constant('fried-rice'), technique: fc.constant('stir-fry') }),
);
let n = 0;
const withIds = (ds: Omit<ProgressEvent, 'id'>[]): ProgressEvent[] => ds.map((d) => ({ ...d, id: `x${++n}` }) as ProgressEvent);
const seeded = () => withIds(finishQuest('leela-tempering', START).map(({ id: _id, ...rest }) => rest));

describe('erasure properties', () => {
  test('property: XP (and level, stamps, trust) are unchanged after erasing any subset of events', () =>
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 40 }), fc.array(fc.boolean(), { maxLength: 60 }), (drafts, mask) => {
        const { history } = play([...seeded(), ...withIds(drafts)]);
        const gone = history.events.filter((_, i) => mask[i] === true).map((e) => e.id);
        const before = deriveProgress(history, CAT);
        const after = deriveProgress(eraseEvents(history, gone), CAT);
        expect(after.xp).toBe(before.xp);
        expect(after.level).toBe(before.level);
        expect(after.stamps).toBe(before.stamps);
        expect(after.trust).toEqual(before.trust);
      }),
      { numRuns: 150 },
    ));

  test('property: the nourishment cap still holds after an erase plus a re-log', () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 1439 }), { maxLength: 8 }),
        fc.array(fc.boolean(), { maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 1439 }), { maxLength: 8 }),
        (first, mask, again) => {
          const p = play(withIds(first.map((minute) => ({ kind: 'meal_logged' as const, at: MON, minute }))));
          const gone = p.history.events.filter((_, i) => mask[i] === true).map((e) => e.id);
          const q = play(withIds(again.map((minute) => ({ kind: 'meal_logged' as const, at: MON, minute }))), eraseEvents(p.history, gone));
          expect(nourishOn(q.history, MON)).toBeLessThanOrEqual(DATA.xp.nourishment.max_per_day);
          expect(deriveProgress(q.history, CAT).xp).toBe(nourishOn(q.history, MON) * DATA.xp.nourishment.per_log);
        },
      ),
      { numRuns: 200 },
    ));

  test('property: grantsForBatch ≡ grantsFor one at a time, also when grants have lost their events (and after compaction)', () =>
    fc.assert(
      fc.property(fc.array(draftArb, { maxLength: 30 }), fc.array(fc.boolean(), { maxLength: 40 }), fc.array(draftArb, { maxLength: 20 }), fc.nat({ max: 15 }), fc.boolean(), (drafts, mask, nextDrafts, keep, replay) => {
        const { history } = play([...seeded(), ...withIds(drafts)]);
        const gone = history.events.filter((_, i) => mask[i] === true);
        const erased = eraseEvents(history, gone.map((e) => e.id));
        // Replays of erased events are mixed into the batch: they must be duplicates both ways.
        const next = [...(replay ? gone.slice(0, 3) : []), ...withIds(nextDrafts)];
        const sequential = play(next, erased).results;
        // A replayed erased event that earned anything is a duplicate (I1). One that earned nothing left no trace.
        const earned = new Set(history.grants.map((g) => g.eventId));
        for (const r of sequential.slice(0, replay ? Math.min(3, gone.length) : 0))
          if (earned.has(r.event.id)) expect(r.problems).toContain('duplicate_id');
        expect(grantsForBatch(next, erased, CAT, DATA, T)).toEqual(sequential);
        const compacted = compactHistory(erased, keep, CAT);
        expect(grantsForBatch(next, compacted, CAT, DATA, T)).toEqual(sequential);
        expect(play(next, compacted).results).toEqual(sequential);
      }),
      { numRuns: 200 },
    ));
});

test('account delete: an empty history earns as new (both ledgers gone, outside core)', () => {
  expect(grantsFor(ev.meal(MON, 600), EMPTY, CAT, DATA, T).grants).toHaveLength(1);
});
