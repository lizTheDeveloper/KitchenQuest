// The never rules, as properties (spec §6, §16 never rules 3, 6 and 8; Review Focus 2).
import fc from 'fast-check';
import type { RulesContext } from '../quests/alternatives';
import { describe, expect, expectTypeOf, test } from 'vitest';
import type { FreshnessThresholds } from '../toolkit/types';
import { compactHistory, deriveProgress } from './derive';
import { CAT, DATA, EMPTY, T, addDays, play } from './fixtures';
import { grantsFor, grantsForBatch } from './rewards';
import type { Catalogue, ProgressEvent, ProgressHistory, ProgressView, RewardGrant, RewardsData } from './types';

const RANK = { seen: 0, tried: 1, yours: 2 } as const;
const START = '2026-01-01';

type Draft = ProgressEvent extends infer E ? (E extends ProgressEvent ? Omit<E, 'id'> : never) : never;
const dateArb = fc.integer({ min: 0, max: 400 }).map((d) => addDays(START, d));
const recipeArb = fc.constantFrom(...CAT.recipes.keys(), 'pizza');
const questArb = fc.constantFrom(...CAT.quests.keys());
const techArb = fc.constantFrom(...CAT.techniques);
const frameArb = fc.constantFrom(...CAT.frames.keys());
const draftArb: fc.Arbitrary<Draft> = fc.oneof(
  fc.record({ kind: fc.constant('lesson' as const), at: dateArb, recipe: recipeArb }),
  fc.record({ kind: fc.constant('cooked' as const), at: dateArb, recipe: recipeArb, planned: fc.boolean() }),
  fc.record({ kind: fc.constant('drill' as const), at: dateArb, quest: questArb, step: fc.integer({ min: 0, max: 6 }), technique: techArb }),
  fc.record({ kind: fc.constant('frame_cooked' as const), at: dateArb, frame: frameArb, technique: techArb }),
  fc.record({ kind: fc.constant('quest_step' as const), at: dateArb, quest: questArb, step: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ kind: fc.constant('quest_done' as const), at: dateArb, quest: questArb }),
  fc.record({ kind: fc.constant('recognized' as const), at: dateArb, quest: questArb, technique: techArb }),
  fc.record({ kind: fc.constant('market_run' as const), at: dateArb, weekStart: dateArb }),
  fc.record({ kind: fc.constant('meal_logged' as const), at: dateArb, minute: fc.integer({ min: 0, max: 1439 }) }),
);
const withIds = (drafts: Draft[]): ProgressEvent[] => drafts.map((d, i): ProgressEvent => ({ ...d, id: `p${i}` }));
// Quest steps in order are rare at random; seed each run with the three quests so trust and requires get exercised.
const seed = (): Draft[] =>
  [...CAT.quests.keys()].flatMap((quest) => [...Array.from({ length: 5 }, (_, i) => ({ kind: 'quest_step' as const, at: START, quest, step: i + 1 })), { kind: 'quest_done' as const, at: START, quest }]);
const eventsArb = fc.tuple(fc.boolean(), fc.array(draftArb, { maxLength: 60 })).map(([seeded, ds]) => withIds(seeded ? [...seed(), ...ds] : ds));

/** a ≤ b on every value the player sees. */
function expectNoLower(a: ProgressView, b: ProgressView) {
  expect(b.xp).toBeGreaterThanOrEqual(a.xp);
  expect(b.level).toBeGreaterThanOrEqual(a.level);
  expect(b.stamps).toBeGreaterThanOrEqual(a.stamps);
  for (const [cook, t] of Object.entries(a.trust)) expect(b.trust[cook]).toBeGreaterThanOrEqual(t);
  for (const [id, r] of Object.entries(a.toolkit.techniques)) expect(RANK[b.toolkit.techniques[id].tier]).toBeGreaterThanOrEqual(RANK[r.tier]);
  for (const q of a.questsDone) expect(b.questsDone).toContain(q);
  for (const [q, n] of Object.entries(a.questSteps)) expect(b.questSteps[q]).toBeGreaterThanOrEqual(n);
}

function expectSaneGrant(g: RewardGrant, data: RewardsData) {
  if (g.kind === 'xp') expect(g.amount).toBeGreaterThan(0);
  if (g.kind === 'trust') {
    expect(g.level).toBeGreaterThanOrEqual(1);
    expect(g.level).toBeLessThan(data.trust.names.length);
  }
  if (g.kind === 'level') expect(g.level).toBeGreaterThanOrEqual(2);
}

describe('never rules', () => {
  test('property: no grant is ever negative or lowers a derived value; deriveProgress over a prefix ≤ over the whole; compaction lowers nothing', () =>
    fc.assert(
      fc.property(eventsArb, fc.nat({ max: 80 }), (events, keep) => {
        const { history, results } = play(events);
        let h: ProgressHistory = EMPTY;
        let prev = deriveProgress(h, CAT);
        const trustSeen = new Map<string, number>();
        for (const r of results) {
          for (const g of r.grants) {
            expectSaneGrant(g, DATA);
            if (g.kind === 'trust') {
              // Only ever one higher than before.
              expect(g.level).toBe((trustSeen.get(g.cook) ?? 0) + 1);
              trustSeen.set(g.cook, g.level);
            }
          }
          if (r.problems.length > 0) {
            expect(r.grants).toEqual([]);
            continue;
          }
          h = { ...h, events: [...h.events, r.event], grants: [...h.grants, ...r.grants] };
          const now = deriveProgress(h, CAT);
          expectNoLower(prev, now);
          prev = now;
        }
        const whole = deriveProgress(history, CAT);
        expect(whole).toEqual(prev);
        const compacted = compactHistory(history, keep, CAT);
        expect(deriveProgress(compacted, CAT)).toEqual(whole);
      }),
      { numRuns: 150 },
    ));

  test('property: shuffling the calendar gaps between the same events never changes total XP (no streak term)', () => {
    // The same events, one per date, every gap 7–14 days, so each falls in its own ISO week and nothing reaches Rusty
    // (8 gaps × 14 days < 120). Daily-in-a-row or spread out: the total must not care how the days line up.
    const kindArb = fc.array(draftArb, { minLength: 1, maxLength: 8 });
    const gapsArb = fc.array(fc.integer({ min: 7, max: 14 }), { minLength: 8, maxLength: 8 });
    fc.assert(
      fc.property(fc.boolean(), kindArb, gapsArb, gapsArb, (seeded, drafts, g1, g2) => {
        const total = (gaps: number[]) => {
          let day = 0;
          const dated = drafts.map((d, i) => {
            day += i === 0 ? 0 : gaps[i - 1];
            return { ...d, at: addDays(START, day + 30) };
          });
          return deriveProgress(play(withIds([...(seeded ? seed() : []), ...dated])).history, CAT).xp;
        };
        expect(total(g1)).toBe(total(g2));
        expect(total(g1)).toBe(total([...g1].reverse()));
      }),
      { numRuns: 150 },
    );
  });

  test('property: grants are independent of anything but events, catalogue and data (grantsFor has no entitlement input)', () => {
    // Type level: exactly these inputs; the optional sixth is the player's rules and content (I3 stand-in cooks).
    expectTypeOf(grantsFor).parameters.toEqualTypeOf<[ProgressEvent, ProgressHistory, Catalogue, RewardsData, FreshnessThresholds, RulesContext?]>();
    expect(grantsFor.length).toBe(6);
    // Source level (no entitlement, money, clock or run-of-days term in progress/): packages/core/test/progress-architecture.test.ts.
    // Pure: the same inputs give the same grants, and extra fields on an event are never read as an entitlement.
    fc.assert(
      fc.property(eventsArb, (events) => {
        const { history } = play(events);
        const probe = { id: 'probe', kind: 'cooked', at: '2026-06-01', recipe: 'parippu', planned: true } as const;
        const a = grantsFor(probe, history, CAT, DATA, T);
        const b = grantsFor({ ...probe, guild: true, entitlements: ['guild'] } as unknown as ProgressEvent, history, CAT, DATA, T);
        expect(b).toEqual(a);
        expect(grantsFor(probe, history, CAT, DATA, T)).toEqual(a);
      }),
      { numRuns: 50 },
    );
  });

  test('property: grantsForBatch equals grantsFor one event at a time, with or without a prior or compacted history', () =>
    fc.assert(
      fc.property(eventsArb, fc.nat({ max: 60 }), fc.nat({ max: 20 }), (events, split, keep) => {
        const cut = Math.min(split, events.length);
        const prior = play(events.slice(0, cut)).history;
        const sequential = play(events.slice(cut), prior).results;
        expect(grantsForBatch(events.slice(cut), prior, CAT, DATA, T)).toEqual(sequential);
        expect(grantsForBatch(events.slice(cut), compactHistory(prior, keep, CAT), CAT, DATA, T)).toEqual(sequential);
      }),
      { numRuns: 150 },
    ));

  test('no event kind exists for rules, consents, profile edits, reminders or pantry changes (§6)', () => {
    for (const kind of ['rule', 'rules', 'consent', 'profile', 'reminder', 'reminder_answered', 'pantry', 'allergy'])
      expect(grantsFor({ id: kind, kind, at: START } as unknown as ProgressEvent, EMPTY, CAT, DATA, T).problems).toEqual(['unknown_kind']);
  });
});
