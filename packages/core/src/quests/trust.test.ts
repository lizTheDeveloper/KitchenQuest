// I3 ruling: trust cook-weeks for cook C count weeks with a cook of C's own dish and, when C's dish is ⛔ for the
// player that week, a cook of an alternativesFor(C's dish) dish or frame. One level a week at most; lessons never.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deriveProgress } from '../progress/derive';
import { DATA, T, addDays } from '../progress/fixtures';
import { grantsFor, grantsForBatch } from '../progress/rewards';
import { isoWeek } from '../progress/week';
import type { ProgressEvent, ProgressHistory } from '../progress/types';
import type { ParsedRecipe } from '../recipe/types';
import type { Rule } from '../rules/types';
import { standInCooks, type RulesContext } from './alternatives';
import { catalogueOf, EMPTY_HISTORY, graph, newId, quests, recipes, record, subs } from './fixtures';

const ALLIUM: Rule = { id: 'r-allium', target: { kind: 'category', ids: ['allium'] }, type: 'avoid', severity: 'allergy' };
const PARIPPU = 'india/kerala/parippu';
const p0 = recipes.get(PARIPPU)!;
const line = (name: string) => ({ name, displayName: null, quantity: 100, unit: 'g', note: null });
/** A legumes dish with nothing allium in it: ✅ under an allium rule, and an alternative to parippu. */
const plainDal: ParsedRecipe = { ...p0, meta: { ...p0.meta, cook: 'marisol', skills: ['legumes'] }, ingredients: [line('split moong dal'), line('salt')] };
const rs = new Map([...recipes, ['test/plain-dal', plainDal]]);
const all = Object.values(quests);
const cat = catalogueOf(all, rs);
const ctx = (rules: Rule[], frames?: RulesContext['frames']): RulesContext => ({ rules, graph, subs, recipes: rs, ...(frames ? { frames } : {}) });

const MON = '2026-11-09';
const leelaDone = (at: string): ProgressEvent[] => [
  ...Array.from({ length: 5 }, (_, i): ProgressEvent => ({ id: newId(), kind: 'quest_step', at, quest: 'leela-tempering', step: i + 1 })),
  { id: newId(), kind: 'quest_done', at, quest: 'leela-tempering' },
];
const dal = (at: string, standsInFor?: string[]): ProgressEvent => ({ id: newId(), kind: 'cooked', at, recipe: 'test/plain-dal', planned: false, ...(standsInFor ? { standsInFor } : {}) });
const trustOf = (h: ProgressHistory, cook: string) => deriveProgress(h, cat).trust[cook] ?? 0;

describe('trust through a stand-in dish (I3)', () => {
  it('standInCooks: under an allium rule the plain dal stands in for Leela (parippu ⛔); without rules for no one', () => {
    expect(standInCooks({ kind: 'recipe', slug: 'test/plain-dal' }, MON, cat, ctx([ALLIUM]))).toEqual(['leela']);
    expect(standInCooks({ kind: 'recipe', slug: 'test/plain-dal' }, MON, cat, ctx([]))).toEqual([]);
    // A rule that starts later in the week: not ⛔ yet on Monday.
    expect(standInCooks({ kind: 'recipe', slug: 'test/plain-dal' }, MON, cat, ctx([{ ...ALLIUM, phase: { start: '2026-11-11' } }]))).toEqual([]);
  });

  it('an allium player reaches trust above Guest through an alternative', () => {
    const c = ctx([ALLIUM]);
    let h = record(EMPTY_HISTORY, [dal(MON, ['leela']), ...leelaDone(MON)], cat, c);
    expect(trustOf(h, 'leela')).toBe(1);
    h = record(h, [dal(addDays(MON, 7), ['leela'])], cat, c);
    expect(trustOf(h, 'leela')).toBe(2); // 2 cook-weeks → Acquainted
    for (let w = 2; w < 7; w++) h = record(h, [dal(addDays(MON, 7 * w), ['leela'])], cat, c);
    expect(trustOf(h, 'leela')).toBe(4); // 7 cook-weeks → Family friend
  });

  it('the pace is the same: at most one level a week, however many stand-in cooks', () => {
    const c = ctx([ALLIUM]);
    let h = record(EMPTY_HISTORY, [dal(MON, ['leela']), ...leelaDone(MON)], cat, c);
    for (let d = 1; d < 7; d++) h = record(h, [dal(addDays(MON, d), ['leela'])], cat, c);
    expect(trustOf(h, 'leela')).toBe(1);
  });

  it('a ⛔-dish player gains no trust from lessons', () => {
    const c = ctx([ALLIUM]);
    let h = record(EMPTY_HISTORY, [{ id: newId(), kind: 'lesson', at: MON, recipe: PARIPPU }, ...leelaDone(MON)], cat, c);
    for (let w = 1; w < 12; w++) h = record(h, [{ id: newId(), kind: 'lesson', at: addDays(MON, 7 * w), recipe: PARIPPU }], cat, c);
    expect(trustOf(h, 'leela')).toBe(1);
    // A lesson carrying a stand-in claim is not a stand-in either.
    const forged = { id: newId(), kind: 'lesson', at: addDays(MON, 100), recipe: PARIPPU, standsInFor: ['leela'] } as unknown as ProgressEvent;
    const r = grantsFor(forged, h, cat, DATA, T, c);
    expect(r).toMatchObject({ problems: [], warnings: ['stand_in_dropped'] });
    expect(r.event).not.toHaveProperty('standsInFor');
    expect(r.grants.some((g) => g.kind === 'trust')).toBe(false);
    const h2 = record(h, [forged], cat, c);
    expect(trustOf(h2, 'leela')).toBe(1);
  });

  it('an invalid or unverifiable claim is dropped, never the event: normal cook grants, no stand-in week, a warning', () => {
    const base = record(EMPTY_HISTORY, [dal(MON, ['leela']), ...leelaDone(MON)], cat, ctx([ALLIUM])); // one Leela week
    const plain = grantsFor(dal(addDays(MON, 7)), base, cat, DATA, T);
    const kinds = (gs: readonly { kind: string }[]) => gs.map((g) => g.kind);
    const cases: [ProgressEvent, RulesContext | undefined][] = [
      [dal(addDays(MON, 7), ['leela'])], // no rules context
      [dal(addDays(MON, 7), ['leela']), ctx([])], // parippu is not ⛔ without rules
      [dal(addDays(MON, 7), ['marisol']), ctx([ALLIUM])], // the dal's own cook
      [dal(addDays(MON, 7), ['nobody']), ctx([ALLIUM])],
      [dal(addDays(MON, 7), ['leela', 'leela']), ctx([ALLIUM])],
      [dal(addDays(MON, 7), ['leela', 'haruka']), ctx([ALLIUM])], // one cook that doesn't hold drops the claim
      [dal(addDays(MON, 7), 'leela' as unknown as string[]), ctx([ALLIUM])],
      [dal(addDays(MON, 7), [] as string[]), ctx([ALLIUM])],
    ].map(([e, c]) => [e as ProgressEvent, c as RulesContext | undefined]);
    for (const [e, c] of cases) {
      const r = grantsFor(e, base, cat, DATA, T, c);
      expect(r.problems).toEqual([]);
      expect(r.warnings).toEqual(['stand_in_dropped']);
      expect(r.event).not.toHaveProperty('standsInFor');
      expect(r.event).toEqual(Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'standsInFor')));
      expect(kinds(r.grants)).toEqual(kinds(plain.grants)); // cook XP (and its own cook-week), nothing for Leela
      expect(r.grants.some((g) => g.kind === 'trust' && g.cook === 'leela')).toBe(false);
      // Stored as accepted, the event credits no Leela week.
      const h = { ...base, events: [...base.events, r.event], grants: [...base.grants, ...r.grants] };
      expect(deriveProgress(h, cat).trust.leela).toBe(1);
    }
    // A claim that holds is kept, with no warning.
    const ok = grantsFor(dal(addDays(MON, 7), ['leela']), base, cat, DATA, T, ctx([ALLIUM]));
    expect(ok).toMatchObject({ problems: [], warnings: [], event: { standsInFor: ['leela'] } });
    expect(ok.grants.some((g) => g.kind === 'trust' && g.cook === 'leela')).toBe(true);
    // No claim, no context needed: an ordinary cook is unchanged.
    expect(grantsFor(dal(addDays(MON, 7)), base, cat, DATA, T)).toMatchObject({ problems: [], warnings: [] });
    // grantsForBatch reports the drop too, and returns the event as accepted.
    const [b] = grantsForBatch([dal(addDays(MON, 7), ['leela'])], base, cat, DATA, T);
    expect(b.warnings).toEqual(['stand_in_dropped']);
    expect(b.event).not.toHaveProperty('standsInFor');
    expect(b.grants.length).toBeGreaterThan(0);
  });

  it('a frame stands in too, when its technique is one of the dish\'s and it passes the rules', () => {
    const c = ctx([ALLIUM], [{ id: 'quick-tomato', technique: 'tempering', status: 'ok' }]);
    const catF = { ...cat, frames: new Map([['quick-tomato', { technique: 'tempering' }]]) };
    expect(standInCooks({ kind: 'frame', id: 'quick-tomato' }, MON, catF, c)).toEqual(['leela']);
    const frame = (at: string): ProgressEvent => ({ id: newId(), kind: 'frame_cooked', at, frame: 'quick-tomato', technique: 'tempering', standsInFor: ['leela'] });
    let h = record(EMPTY_HISTORY, [frame(MON), ...leelaDone(MON)], catF, c);
    h = record(h, [frame(addDays(MON, 7))], catF, c);
    expect(deriveProgress(h, catF).trust.leela).toBe(2);
    // A ⛔ or ❓ frame never stands in.
    for (const status of ['blocked', 'unverified'] as const) {
      const bad = ctx([ALLIUM], [{ id: 'quick-tomato', technique: 'tempering', status }]);
      expect(standInCooks({ kind: 'frame', id: 'quick-tomato' }, MON, catF, bad)).toEqual([]);
      expect(grantsFor(frame(addDays(MON, 14)), h, catF, DATA, T, bad)).toMatchObject({ problems: [], warnings: ['stand_in_dropped'] });
    }
  });

  it('grantsForBatch ≡ grantsFor with a rules context', () => {
    const c = ctx([ALLIUM]);
    const events = [dal(MON, ['leela']), ...leelaDone(MON), ...Array.from({ length: 5 }, (_, w) => dal(addDays(MON, 7 * (w + 1)), ['leela'])), dal(MON, ['marisol'])];
    const batch = grantsForBatch(events, EMPTY_HISTORY, cat, DATA, T, c);
    let h = EMPTY_HISTORY;
    const seq = events.map((e) => {
      const r = grantsFor(e, h, cat, DATA, T, c);
      if (r.problems.length === 0) h = { ...h, events: [...h.events, r.event], grants: [...h.grants, ...r.grants] };
      return r;
    });
    expect(batch).toEqual(seq);
  });

  it('property: with stand-in claims, grantsForBatch ≡ grantsFor and trust, XP and stamps never go down', () => {
    const c = ctx([ALLIUM]);
    const evArb = fc.tuple(fc.integer({ min: 0, max: 60 }), fc.constantFrom('dal', 'dal-claim', 'dal-bad-claim', 'lesson', 'parippu')).map(
      ([d, k]): ProgressEvent => {
        const at = addDays(MON, d);
        if (k === 'dal') return dal(at);
        if (k === 'dal-claim') return dal(at, ['leela']);
        if (k === 'dal-bad-claim') return dal(at, ['marisol']);
        if (k === 'lesson') return { id: newId(), kind: 'lesson', at, recipe: PARIPPU };
        return { id: newId(), kind: 'cooked', at, recipe: PARIPPU, planned: false };
      },
    );
    fc.assert(
      fc.property(fc.array(evArb, { maxLength: 25 }), (tail) => {
        const events = [...leelaDone(MON), ...tail];
        const batch = grantsForBatch(events, EMPTY_HISTORY, cat, DATA, T, c);
        let h = EMPTY_HISTORY;
        let prev = deriveProgress(h, cat);
        events.forEach((e, i) => {
          const r = grantsFor(e, h, cat, DATA, T, c);
          expect(batch[i]).toEqual({ ...r, event: r.event });
          if (r.problems.length === 0) h = { ...h, events: [...h.events, r.event], grants: [...h.grants, ...r.grants] };
          const v = deriveProgress(h, cat);
          expect(v.xp).toBeGreaterThanOrEqual(prev.xp);
          expect(v.stamps).toBeGreaterThanOrEqual(prev.stamps);
          for (const [cook, l] of Object.entries(prev.trust)) expect(v.trust[cook]).toBeGreaterThanOrEqual(l);
          prev = v;
        });
        // One level a week at most: above Guest, no ISO week holds two trust grants for one cook.
        const perWeek = new Map<string, number>();
        for (const g of h.grants) if (g.kind === 'trust' && g.level >= 2) {
          const k = `${g.cook} ${isoWeek(g.isoDay)}`;
          perWeek.set(k, (perWeek.get(k) ?? 0) + 1);
        }
        for (const n of perWeek.values()) expect(n).toBe(1);
      }),
      { numRuns: 60 },
    );
  });
});
