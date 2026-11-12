// M6 Step 7 review I1: the API's progress snapshot stores a fold made by this code. Any change to the shape of the view
// or the facts must come with a FOLD_VERSION bump (which joins the snapshot hash, so stored snapshots are rebuilt).
// This test fingerprints a full fold's shape and compares it with FOLD_SHAPES[FOLD_VERSION]: a shape change without a
// new version fails here. (The fixture is fixed: changing its events can change the fingerprint, which is a test edit.)
import { describe, expect, it } from 'vitest';
import { compactHistory } from './derive';
import { addDays, ev, finishQuest, MARKET_CAT, play, rulesCtx } from './fixtures';
import { FOLD_SHAPES, FOLD_VERSION, type Facts } from './fold';
import type { ProgressView } from './types';

/** Every field of each type, checked by the compiler: a new field fails typecheck until it is listed here. */
const VIEW_KEYS: Record<keyof ProgressView, true> = {
  xp: true,
  level: true,
  stamps: true,
  trust: true,
  toolkit: true,
  questsDone: true,
  questSteps: true,
  questStartedOn: true,
  cookedOn: true,
  framesCookedOn: true,
  marketAnswered: true,
};
const FACT_KEYS: Record<keyof Facts, true> = { v: true, ids: true, perDate: true, keys: true, cookWeeks: true, nourishCount: true, nourishMinutes: true };

/** Records keyed by data (ids, dates), not by field names: their shape is that of their values. */
const DATA_KEYED = new Set([
  'view.trust',
  'view.toolkit.techniques',
  'view.questSteps',
  'view.questStartedOn',
  'view.cookedOn',
  'view.framesCookedOn',
  'view.marketAnswered',
  'facts.perDate',
  'facts.cookWeeks',
  'facts.nourishCount',
  'facts.nourishMinutes',
]);

const sortedUnique = (xs: string[]) => [...new Set(xs)].sort();

/** The shape of a JSON value: field names and value types, with data-keyed records and arrays folded to their element shape. */
export function shapeOf(v: unknown, path: string): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${sortedUnique(v.map((x) => shapeOf(x, `${path}[]`))).join('|')}]`;
  if (typeof v === 'object') {
    const entries = Object.entries(v);
    if (DATA_KEYED.has(path)) return `{*:${sortedUnique(entries.map(([, x]) => shapeOf(x, `${path}.*`))).join('|')}}`;
    return `{${entries
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, x]) => `${k}:${shapeOf(x, `${path}.${k}`)}`)
      .join(',')}}`;
  }
  return typeof v;
}

/** FNV-1a, 32 bits, as hex: a short, stable fingerprint (core has no node:crypto). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A fold that fills every field: quests, cooks over weeks (trust), a frame, meals, a market run and a stall round. */
function richSnapshot() {
  const MON = '2026-06-01';
  const events = [
    ...finishQuest('leela-tempering', MON),
    ev.lesson('parippu', MON),
    ...[0, 7, 14, 21, 28].map((d) => ev.cooked('parippu', addDays(MON, d))),
    ev.frame('fried-rice', 'stir-fry', MON),
    ev.meal(MON, 480),
    ev.meal(MON, 780),
    ev.market(MON),
    ev.round('bram', MON, [['bram-thermometer', 0]]),
  ];
  const { history, results } = play(events, undefined, undefined, MARKET_CAT, rulesCtx());
  expect(results.filter((r) => r.problems.length > 0)).toEqual([]);
  return compactHistory(history, 0, MARKET_CAT).base!;
}

describe('FOLD_VERSION pins the fold shape (M6 Step 7 review I1)', () => {
  it('the view and facts of a full fold have exactly the shape recorded for FOLD_VERSION', () => {
    const snap = richSnapshot();
    const view = snap.view;
    const facts = snap.facts as Facts;
    // Every field is present, and every data-keyed record is filled, so the fingerprint sees the inner shapes.
    expect(Object.keys(view).sort()).toEqual(Object.keys(VIEW_KEYS).sort());
    expect(Object.keys(facts).sort()).toEqual(Object.keys(FACT_KEYS).sort());
    for (const path of DATA_KEYED) {
      const [root, ...rest] = path.split('.');
      const v = rest.reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], root === 'view' ? view : facts);
      expect(Object.keys(v as object).length, path).toBeGreaterThan(0);
    }
    const shape = `view:${shapeOf(view, 'view')};facts:${shapeOf(facts, 'facts')}`;
    expect(fnv1a(shape), `the fold's shape changed: bump FOLD_VERSION and add FOLD_SHAPES[${FOLD_VERSION + 1}] (shape: ${shape})`).toBe(FOLD_SHAPES[FOLD_VERSION]);
  });

  it('versions only grow, and no two versions share a fingerprint', () => {
    expect(Number.isInteger(FOLD_VERSION) && FOLD_VERSION >= 1).toBe(true);
    expect(Object.keys(FOLD_SHAPES).map(Number).sort((a, b) => a - b).at(-1)).toBe(FOLD_VERSION);
    const prints = Object.values(FOLD_SHAPES);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it('the fingerprint bites: an added view field, or a changed value type, gives another shape', () => {
    const snap = richSnapshot();
    const base = shapeOf(snap.view, 'view');
    expect(shapeOf({ ...snap.view, newField: 1 }, 'view')).not.toBe(base);
    expect(shapeOf({ ...snap.view, level: '1' }, 'view')).not.toBe(base);
    expect(shapeOf({ ...snap.view, marketAnswered: { q: { correct: true, lastAt: '2026-06-01', extra: 1 } } }, 'view')).not.toBe(base);
    // Data keys don't: another player's ids give the same shape.
    expect(shapeOf({ ...snap.view, cookedOn: { other: ['2026-06-02'] } }, 'view')).toBe(base);
  });
});
