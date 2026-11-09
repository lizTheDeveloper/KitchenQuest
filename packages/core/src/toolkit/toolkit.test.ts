import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import * as toolkitModule from './toolkit';
import {
  EMPTY_TOOLKIT,
  freshness,
  recordTechnique,
  toolkitRows,
  validateThresholds,
  type TechniqueEvent,
  type Tier,
  type ToolkitState,
} from './toolkit';

const T = { warmAfterDays: 42, rustyAfterDays: 120 };
const rank = (t: Tier) => ['seen', 'tried', 'yours'].indexOf(t);
const lesson = (technique: string, at: string): TechniqueEvent => ({ kind: 'lesson', technique, at });
const cooked = (technique: string, at: string, recipe: string): TechniqueEvent => ({ kind: 'cooked', technique, at, recipe });
const run = (events: TechniqueEvent[], s: ToolkitState = EMPTY_TOOLKIT) => events.reduce(recordTechnique, s);

const dateArb = fc.integer({ min: 0, max: 1500 }).map((d) => new Date(Date.UTC(2024, 0, 1) + d * 86_400_000).toISOString().slice(0, 10));
const techArb = fc.constantFrom('tadka', 'tempering', 'rice-washing');
const eventArb: fc.Arbitrary<TechniqueEvent> = fc.oneof(
  fc.record({ kind: fc.constant('lesson' as const), technique: techArb, at: dateArb }),
  fc.record({ kind: fc.constant('cooked' as const), technique: techArb, at: dateArb, recipe: fc.constantFrom('a', 'b', 'c') }),
);

const deepFreeze = <V>(v: V): V => {
  if (typeof v === 'object' && v !== null) {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

describe('recordTechnique', () => {
  test('lesson → seen; cooked → tried; same recipe twice stays tried; two recipes → yours', () => {
    expect(run([lesson('tadka', '2026-01-01')]).techniques.tadka.tier).toBe('seen');
    const tried = run([cooked('tadka', '2026-01-02', 'parippu')]);
    expect(tried.techniques.tadka.tier).toBe('tried');
    const again = recordTechnique(tried, cooked('tadka', '2026-01-03', 'parippu'));
    expect(again.techniques.tadka.tier).toBe('tried');
    expect(again.techniques.tadka.recipes).toEqual(['parippu']);
    const yours = recordTechnique(again, cooked('tadka', '2026-01-04', 'sambar'));
    expect(yours.techniques.tadka.tier).toBe('yours');
    expect(yours.techniques.tadka.recipes).toEqual(['parippu', 'sambar']);
  });

  test('a lesson after yours keeps yours', () => {
    const s = run([cooked('tadka', '2026-01-01', 'a'), cooked('tadka', '2026-01-02', 'b'), lesson('tadka', '2026-01-03')]);
    expect(s.techniques.tadka.tier).toBe('yours');
  });

  test('tier never decreases (property)', () =>
    fc.assert(
      fc.property(fc.array(eventArb), (events) => {
        let s = EMPTY_TOOLKIT;
        for (const e of events) {
          const next = recordTechnique(s, e);
          for (const [id, r] of Object.entries(s.techniques))
            expect(rank(next.techniques[id].tier)).toBeGreaterThanOrEqual(rank(r.tier));
          s = next;
        }
      }),
    ));

  test('recordTechnique does not mutate its input', () => {
    const s = deepFreeze(run([cooked('tadka', '2026-01-01', 'a')]));
    expect(() => recordTechnique(s, cooked('tadka', '2026-02-01', 'b'))).not.toThrow();
    expect(() => recordTechnique(deepFreeze(EMPTY_TOOLKIT), lesson('x', '2026-01-01'))).not.toThrow();
    expect(s.techniques.tadka.recipes).toEqual(['a']);
  });

  test('late older event does not move lastUsedAt back', () => {
    const r = run([lesson('tadka', '2026-03-01'), lesson('tadka', '2026-01-01')]).techniques.tadka;
    expect(r.lastUsedAt).toBe('2026-03-01');
    expect(r.firstAt).toBe('2026-01-01');
  });

  test('invalid dates throw', () => {
    expect(() => recordTechnique(EMPTY_TOOLKIT, lesson('tadka', '2026-13-01'))).toThrow();
    expect(() => recordTechnique(EMPTY_TOOLKIT, lesson('tadka', '2026-01-01T10:00:00'))).toThrow();
    expect(() => freshness('2026-02-30', '2026-03-01', T)).toThrow();
    expect(() => freshness('2026-01-01', 'today', T)).toThrow();
  });
});

describe('freshness', () => {
  test('freshness boundaries', () => {
    expect(freshness('2026-01-01', '2026-02-11', T)).toBe('sharp'); // 41 days
    expect(freshness('2026-01-01', '2026-02-12', T)).toBe('warm'); // 42
    expect(freshness('2026-01-01', '2026-04-30', T)).toBe('warm'); // 119
    expect(freshness('2026-01-01', '2026-05-01', T)).toBe('rusty'); // 120
    expect(freshness('2026-03-10', '2026-03-01', T)).toBe('sharp'); // future lastUsed
    expect(freshness('2026-03-28', '2026-03-30', T)).toBe('sharp'); // across a DST change
  });

  test('freshness never changes tier', () => {
    const s = run([cooked('tadka', '2025-01-01', 'a'), cooked('tadka', '2025-01-02', 'b')]);
    expect(toolkitRows(s, '2026-02-05', T)).toEqual([{ technique: 'tadka', tier: 'yours', freshness: 'rusty' }]);
  });

  test('seen rows have null freshness, and rows are sorted by technique id', () => {
    const s = run([lesson('zest', '2020-01-01'), cooked('braise', '2026-01-01', 'a'), lesson('amchur', '2026-01-01')]);
    expect(toolkitRows(s, '2026-01-02', T)).toEqual([
      { technique: 'amchur', tier: 'seen', freshness: null },
      { technique: 'braise', tier: 'tried', freshness: 'sharp' },
      { technique: 'zest', tier: 'seen', freshness: null },
    ]);
  });
});

describe('validateThresholds', () => {
  test('accepts good data and gives one problem for each bad case', () => {
    expect(validateThresholds(T)).toEqual([]);
    for (const bad of [
      { warmAfterDays: 120, rustyAfterDays: 42 },
      { warmAfterDays: 0, rustyAfterDays: 10 },
      { warmAfterDays: 4.5, rustyAfterDays: 10 },
      { warmAfterDays: -1, rustyAfterDays: 10 },
    ])
      expect(validateThresholds(bad), JSON.stringify(bad)).toHaveLength(1);
  });
});

test('public surface has no removal', () => {
  expect(Object.keys(toolkitModule).sort()).toEqual(['EMPTY_TOOLKIT', 'freshness', 'recordTechnique', 'toolkitRows', 'validateThresholds']);
});
