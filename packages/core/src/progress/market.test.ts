// M6 Step 3: stall rounds earn what core decides from the stall file (Rulings 1, 2, 4 and 17).
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { BRAM, NO_PORK, VEGETARIAN, WEN } from '../market/fixtures';
import { compactHistory, deriveProgress } from './derive';
import { CAT, DATA, EMPTY, MARKET_CAT, T, addDays, ev, last, play, rulesCtx, xpOf } from './fixtures';
import { grantsFor, grantsForBatch, isHealthRevealing, marketCatalogue, validateRewards } from './rewards';
import type { ProgressEvent, ProgressHistory, RewardGrant } from './types';
import { isoWeek } from './week';

const MON = '2026-11-09'; // a Monday: ISO week 2026-W46
const NONE = rulesCtx();
const VEG = rulesCtx([VEGETARIAN]);
const run = (events: ProgressEvent[], rules = NONE, start: ProgressHistory = EMPTY) => play(events, start, DATA, MARKET_CAT, rules);
const stampsOf = (grants: readonly RewardGrant[]) => grants.filter((g) => g.kind === 'stamp');
const marketXp = (grants: readonly RewardGrant[]) => grants.filter((g) => g.kind === 'xp' && g.reason === 'market_game');
const one = (e: ProgressEvent, h: ProgressHistory = EMPTY, rules = NONE) => grantsFor(e, h, MARKET_CAT, DATA, T, rules);

describe('stall_round grants (Ruling 1)', () => {
  test('stall_round: a correct first answer earns xp.market_game; the same question correct again earns nothing', () => {
    const p = run([ev.round('bram', MON, [['bram-thermometer', 0]]), ev.round('bram', addDays(MON, 1), [['bram-thermometer', 0]])]);
    const [first, again] = p.results;
    expect(first.problems).toEqual([]);
    expect(marketXp(first.grants)).toEqual([{ id: `${first.event.id}#0`, eventId: first.event.id, isoDay: MON, kind: 'xp', amount: 5, reason: 'market_game' }]);
    expect(again.problems).toEqual([]);
    expect(marketXp(again.grants)).toEqual([]);
    // Another week, still answered before: nothing, ever again, for that question.
    const later = one(ev.round('bram', addDays(MON, 70), [['bram-thermometer', 0]]), p.history);
    expect(marketXp(later.grants)).toEqual([]);
    // Two new questions right in one round: one grant each.
    const two = one(ev.round('bram', addDays(MON, 2), [['bram-braise-cut', 0], ['bram-curry-chicken', 0], ['bram-thermometer', 0]]), p.history);
    expect(marketXp(two.grants).map((g) => g.kind === 'xp' && g.amount)).toEqual([5, 5]);
  });

  test('a wrong answer earns nothing and lowers nothing; the round still earns the stall stamp once per ISO week', () => {
    const before = run([ev.cooked('parippu', MON)]).history;
    const wrong = one(ev.round('bram', MON, [['bram-thermometer', 1], ['bram-braise-cut', 2]]), before);
    expect(wrong.problems).toEqual([]);
    expect(marketXp(wrong.grants)).toEqual([]);
    expect(stampsOf(wrong.grants)).toEqual([{ id: `${wrong.event.id}#0`, eventId: wrong.event.id, isoDay: MON, kind: 'stamp', stamp: 'market_game' }]);
    expect(wrong.grants.every((g) => g.kind !== 'xp' || g.amount > 0)).toBe(true);
    const after = { ...before, events: [...before.events, wrong.event], grants: [...before.grants, ...wrong.grants] };
    const was = deriveProgress(before, MARKET_CAT);
    const now = deriveProgress(after, MARKET_CAT);
    expect(now.xp).toBe(was.xp);
    expect(now.stamps).toBe(was.stamps + 1);
    // A wrong first answer leaves the first correct one still to earn.
    expect(marketXp(one(ev.round('bram', addDays(MON, 1), [['bram-thermometer', 0]]), after).grants)).toHaveLength(1);
  });

  test('two rounds at one stall in one ISO week → one stamp; different stalls → one each; next ISO week → again', () => {
    const sun = addDays(MON, 6);
    const p = run([
      ev.round('bram', MON, [['bram-thermometer', 1]]),
      ev.round('bram', sun, [['bram-braise-cut', 1]]),
      ev.round('wen', sun, [['wen-garlic-store', 1]]),
      ev.round('bram', addDays(MON, 7), [['bram-thermometer', 2]]),
    ]);
    expect(isoWeek(sun)).toBe(isoWeek(MON));
    expect(p.results.map((r) => r.problems)).toEqual([[], [], [], []]);
    expect(p.results.map((r) => stampsOf(r.grants).length)).toEqual([1, 0, 1, 1]);
    // The weeks need not be in a row: a gap costs nothing and the next round still stamps.
    expect(stampsOf(one(ev.round('bram', addDays(MON, 70), [['bram-thermometer', 1]]), p.history).grants)).toHaveLength(1);
  });

  test('stamps.market_game and xp.market_game are data: a retune changes what comes next, never what was granted', () => {
    const p = run([ev.round('bram', MON, [['bram-thermometer', 0]])]);
    const xp = deriveProgress(p.history, MARKET_CAT).xp;
    const retuned = { ...DATA, xp: { ...DATA.xp, market_game: 0 }, stamps: { ...DATA.stamps, market_game: 2 } };
    const next = grantsFor(ev.round('bram', addDays(MON, 7), [['bram-braise-cut', 0]]), p.history, MARKET_CAT, retuned, T, NONE);
    expect(marketXp(next.grants)).toEqual([]);
    expect(stampsOf(next.grants)).toHaveLength(2);
    expect(deriveProgress(p.history, MARKET_CAT).xp).toBe(xp);
  });
});

describe('stall_round validation (Ruling 2, Review Focus 4)', () => {
  test('the event carries picks, never a correct flag; a forged "correct" key → bad_event; an out-of-range pick → bad_event', () => {
    const good = ev.round('bram', MON, [['bram-thermometer', 0]]);
    expect(one(good).problems).toEqual([]);
    const forgedAnswer = { ...good, answers: [{ q: 'bram-thermometer', pick: 1, correct: true }] } as unknown as ProgressEvent;
    expect(one(forgedAnswer).problems).toEqual(['bad_event']);
    for (const extra of [{ correct: true }, { score: 1 }, { shown: ['bram-thermometer'] }, { xp: 5 }]) {
      const forged = { ...good, ...extra } as unknown as ProgressEvent;
      expect(one(forged).problems, JSON.stringify(extra)).toEqual(['bad_event']);
      expect(one(forged).grants).toEqual([]);
    }
    for (const pick of [-1, 3, 1.5, Number.NaN, '0' as unknown as number, null as unknown as number]) {
      const r = one(ev.round('bram', MON, [['bram-thermometer', pick]]));
      expect(r.problems, String(pick)).toEqual(['bad_event']);
      expect(r.grants).toEqual([]);
    }
    // A pick is a FILE index: index 0 is right whatever order the options are shown in.
    expect(marketXp(one(ev.round('bram', MON, [['bram-thermometer', 0]])).grants)).toHaveLength(1);
    expect(marketXp(one(ev.round('bram', MON, [['bram-thermometer', 2]])).grants)).toHaveLength(0);
  });

  test("a question the player's rules hide → bad_event, nothing stored; without rules → rules_unknown", () => {
    const noPork = rulesCtx([NO_PORK]);
    const pork = ev.round('bram', MON, [['bram-thermometer', 0], ['bram-pork-shoulder', 0]]);
    const hidden = run([pork], noPork);
    expect(last(hidden).problems).toEqual(['bad_event']);
    expect(last(hidden).grants).toEqual([]);
    expect(hidden.history).toEqual(EMPTY);
    // The same round is fine for a player without the rule.
    expect(one(pork).problems).toEqual([]);
    // Bram's beef braise for a vegetarian, whose stall is the Protein Counter: hidden.
    expect(one(ev.round('bram', MON, [['bram-braise-cut', 0]]), EMPTY, VEG).problems).toEqual(['bad_event']);
    // A base question that names no meat is still hidden from a vegetarian: they see the Protein Counter's bank.
    expect(one(ev.round('bram', MON, [['bram-thermometer', 0]]), EMPTY, VEG).problems).toEqual(['bad_event']);
    // And the Protein Counter's questions only for a player whose rules block meat.
    expect(one(ev.round('bram', MON, [['bram-pc-lentils', 0]]), EMPTY, VEG).problems).toEqual([]);
    expect(one(ev.round('bram', MON, [['bram-pc-lentils', 0]])).problems).toEqual(['bad_event']);
    // A Protein Counter egg question under an egg rule: hidden (Review Focus 1).
    expect(one(ev.round('bram', MON, [['bram-pc-eggs', 0]]), EMPTY, rulesCtx([VEGETARIAN, { id: 'r-egg', target: { kind: 'ingredient', ids: ['egg'] }, type: 'avoid', severity: 'allergy' }])).problems).toEqual(['bad_event']);
    // A tofu question (tofu contains soy since M6 Step 4) under a soy rule: never answerable. An id the graph doesn't
    // know is ❓ and never shown either (market/bank.test.ts).
    expect(one(ev.round('bram', MON, [['bram-pc-tofu', 0]]), EMPTY, VEG).problems).toEqual([]);
    expect(one(ev.round('bram', MON, [['bram-pc-tofu', 0]]), EMPTY, rulesCtx([VEGETARIAN, { id: 'r-soy', target: { kind: 'ingredient', ids: ['soy'] }, type: 'avoid', severity: 'allergy' }])).problems).toEqual(['bad_event']);
    // Without rules: rules_unknown, nothing granted or stored, and the device retries once rules load.
    const blind = grantsFor(ev.round('bram', MON, [['bram-thermometer', 0]]), EMPTY, MARKET_CAT, DATA, T);
    expect(blind.problems).toEqual(['rules_unknown']);
    expect(blind.grants).toEqual([]);
    // A malformed round is bad_event even without rules: retrying would never help.
    expect(grantsFor(ev.round('bram', MON, [['nope', 0]]), EMPTY, MARKET_CAT, DATA, T).problems).toEqual(['bad_event']);
    // Rules the engine can't read: never stored, never "safe".
    const broken = rulesCtx([{ id: 'r-x', target: { kind: 'ingredient', ids: ['not_an_id'] }, type: 'avoid', severity: 'allergy' }]);
    expect(one(ev.round('bram', MON, [['bram-thermometer', 0]]), EMPTY, broken).problems).toEqual(['rules_unknown']);
  });

  test('a phased rule hides a question only from its start date: the round is judged on its own `at`', () => {
    const phased = rulesCtx([{ ...NO_PORK, phase: { start: '2026-11-12' } }]);
    expect(one(ev.round('bram', '2026-11-11', [['bram-pork-shoulder', 0]]), EMPTY, phased).problems).toEqual([]);
    expect(one(ev.round('bram', '2026-11-12', [['bram-pork-shoulder', 0]]), EMPTY, phased).problems).toEqual(['bad_event']);
  });

  test('more than MAX_ROUND_ANSWERS answers or a repeated q → bad_event', () => {
    const ids = ['bram-braise-cut', 'bram-curry-chicken', 'bram-pork-shoulder', 'bram-lard-pastry', 'bram-usda-label', 'bram-thermometer'];
    expect(one(ev.round('bram', MON, ids.map((q) => [q, 0]))).problems).toEqual([]);
    expect(one(ev.round('bram', MON, [['bram-thermometer', 0], ['bram-thermometer', 1]])).problems).toEqual(['bad_event']);
    expect(one(ev.round('bram', MON, [])).problems).toEqual(['bad_event']);
    // Eleven answers: over the cap even before the repeat check (only six distinct questions exist here).
    const eleven = { ...ev.round('bram', MON, []), answers: Array.from({ length: 11 }, (_, i) => ({ q: ids[i % ids.length], pick: 0 })) } as ProgressEvent;
    expect(one(eleven).problems).toEqual(['bad_event']);
    for (const answers of [null, 'bram-thermometer', [null], [{ q: '', pick: 0 }], [{ pick: 0 }], [['bram-thermometer', 0]]])
      expect(one({ ...ev.round('bram', MON, []), answers } as unknown as ProgressEvent).problems, JSON.stringify(answers)).toEqual(['bad_event']);
    // Another stall's question, or an unknown stall.
    expect(one(ev.round('wen', MON, [['bram-thermometer', 0]])).problems).toEqual(['bad_event']);
    expect(one(ev.round('fishmonger', MON, [['bram-thermometer', 0]])).problems).toEqual(['bad_event']);
    // The usual checks still apply: a duplicate id, a bad date.
    const ok = ev.round('bram', MON, [['bram-thermometer', 0]]);
    expect(one(ok, run([ok]).history).problems).toEqual(['duplicate_id']);
    expect(one({ ...ok, at: '2026-13-01' }).problems).toEqual(['bad_date']);
  });

  test("a stall_round with no cat.market → bad_event; a question kept only by a curated swap (lard under \"no pork\") → bad_event", () => {
    const round = ev.round('bram', MON, [['bram-thermometer', 0]]);
    expect(grantsFor(round, EMPTY, CAT, DATA, T, NONE).problems).toEqual(['bad_event']);
    expect(grantsFor(round, EMPTY, CAT, DATA, T).problems).toEqual(['bad_event']);
    // data/substitutions.json has lard → neutral_oil, but a question names lard itself: ⛔, never 🔁 (C3).
    expect(one(ev.round('bram', MON, [['bram-lard-pastry', 0]]), EMPTY, rulesCtx([NO_PORK])).problems).toEqual(['bad_event']);
    expect(one(ev.round('bram', MON, [['bram-lard-pastry', 0]])).problems).toEqual([]);
  });

  test('grantsForBatch ≡ grantsFor one by one, stall rounds included', () => {
    const events = [
      ev.round('bram', MON, [['bram-thermometer', 0]]),
      ev.round('bram', MON, [['bram-thermometer', 0], ['bram-braise-cut', 0]]),
      ev.round('bram', MON, [['bram-pork-shoulder', 0]]),
      ev.round('wen', addDays(MON, 7), [['wen-garlic-store', 0]]),
      ev.round('bram', addDays(MON, 7), [['bram-lard-pastry', 1]]),
    ];
    for (const rules of [NONE, rulesCtx([NO_PORK])]) {
      const oneByOne = run(events, rules).results.map(({ event, grants, problems }) => ({ event, grants, problems }));
      const batch = grantsForBatch(events, EMPTY, MARKET_CAT, DATA, T, rules).map(({ event, grants, problems }) => ({ event, grants, problems }));
      expect(batch).toEqual(oneByOne);
    }
  });
});

describe('isHealthRevealing (Ruling 17)', () => {
  test('isHealthRevealing: true for any protein_counter question, false for base and seasonal', () => {
    expect(isHealthRevealing(ev.round('bram', MON, [['bram-pc-lentils', 0]]), MARKET_CAT)).toBe(true);
    expect(isHealthRevealing(ev.round('bram', MON, [['bram-pc-lentils', 0], ['bram-pc-paneer', 1]]), MARKET_CAT)).toBe(true);
    expect(isHealthRevealing(ev.round('bram', MON, [['bram-thermometer', 0]]), MARKET_CAT)).toBe(false);
    expect(isHealthRevealing(ev.round('wen', MON, [['wen-pnw-6-strawberry', 0], ['wen-berries', 0]]), MARKET_CAT)).toBe(false);
    for (const e of [ev.cooked('parippu', MON), ev.market(MON), ev.meal(MON, 600)]) expect(isHealthRevealing(e, MARKET_CAT)).toBe(false);
    // Fail closed: what the catalogue can't classify counts as revealing.
    expect(isHealthRevealing(ev.round('bram', MON, [['bram-thermometer', 0], ['gone', 0]]), MARKET_CAT)).toBe(true);
    expect(isHealthRevealing(ev.round('bram', MON, [['bram-thermometer', 0]]), CAT)).toBe(true);
    expect(isHealthRevealing(ev.round('fishmonger', MON, [['x', 0]]), MARKET_CAT)).toBe(true);
    expect(isHealthRevealing({ ...ev.round('bram', MON, []), answers: null } as unknown as ProgressEvent, MARKET_CAT)).toBe(true);
    expect(isHealthRevealing(ev.round('bram', MON, []), MARKET_CAT)).toBe(true);
  });
});

describe('marketAnswered', () => {
  test('marketAnswered folds lastAt and ever-correct; compactHistory + snapshot keeps it (C15 property, fast-check)', () => {
    const p = run([
      ev.round('bram', addDays(MON, 3), [['bram-thermometer', 1]]),
      ev.round('bram', MON, [['bram-thermometer', 0], ['bram-braise-cut', 2]]),
      ev.round('bram', addDays(MON, 1), [['bram-thermometer', 2]]),
    ]);
    expect(deriveProgress(p.history, MARKET_CAT).marketAnswered).toEqual({
      // Correct once (on MON): ever-correct stays on after a later wrong answer. lastAt is the latest date, whatever order.
      'bram-thermometer': { correct: true, lastAt: addDays(MON, 3) },
      'bram-braise-cut': { correct: false, lastAt: MON },
    });
    expect(deriveProgress(EMPTY, MARKET_CAT).marketAnswered).toEqual({});

    const POOL: [string, string][] = [
      ['bram', 'bram-thermometer'], ['bram', 'bram-braise-cut'], ['bram', 'bram-curry-chicken'], ['bram', 'bram-usda-label'],
      ['wen', 'wen-garlic-store'], ['wen', 'wen-berries'], ['wen', 'wen-pnw-6-strawberry'],
    ];
    const roundArb = fc.record({
      day: fc.integer({ min: 0, max: 60 }),
      stall: fc.constantFrom('bram', 'wen'),
      answers: fc.uniqueArray(fc.record({ i: fc.integer({ min: 0, max: POOL.length - 1 }), pick: fc.integer({ min: 0, max: 2 }) }), { selector: (a) => a.i, minLength: 1, maxLength: 4 }),
      other: fc.boolean(),
    });
    const toEvent = (r: { day: number; stall: string; answers: { i: number; pick: number }[]; other: boolean }): ProgressEvent => {
      if (r.other) return ev.cooked('parippu', addDays(MON, r.day));
      const mine = r.answers.filter((a) => POOL[a.i][0] === r.stall).map((a): [string, number] => [POOL[a.i][1], a.pick]);
      return ev.round(r.stall, addDays(MON, r.day), mine.length > 0 ? mine : [[r.stall === 'bram' ? 'bram-thermometer' : 'wen-berries', 1]]);
    };
    fc.assert(
      fc.property(fc.array(roundArb, { minLength: 1, maxLength: 25 }), fc.array(roundArb, { minLength: 1, maxLength: 5 }), fc.nat(), (past, next, k) => {
        const h = run(past.map(toEvent)).history;
        const full = deriveProgress(h, MARKET_CAT);
        const keep = k % (h.events.length + 1);
        const c = compactHistory(h, keep, MARKET_CAT);
        const stored = JSON.parse(JSON.stringify(c)) as ProgressHistory;
        expect(deriveProgress(c, MARKET_CAT)).toEqual(full);
        expect(deriveProgress(stored, MARKET_CAT)).toEqual(full);
        for (const e of next.map(toEvent)) {
          const want = grantsFor(e, h, MARKET_CAT, DATA, T, NONE);
          expect(grantsFor(e, c, MARKET_CAT, DATA, T, NONE)).toEqual(want);
          expect(grantsFor(e, stored, MARKET_CAT, DATA, T, NONE)).toEqual(want);
        }
        // XP never drops along the way: the running total only rises.
        let prev = 0;
        for (let i = 1; i <= h.events.length; i++) {
          const ids = new Set(h.events.slice(0, i).map((e) => e.id));
          const xp = xpOf(h.grants.filter((g) => ids.has(g.eventId)));
          expect(xp).toBeGreaterThanOrEqual(prev);
          prev = xp;
        }
      }),
      { numRuns: 150 },
    );
  });

  test('a corrupt stored marketAnswered reads as empty and never throws', () => {
    for (const marketAnswered of [null, 'x', { q: null }, { q: { correct: 'yes', lastAt: 'soon' } }]) {
      const base = { view: { xp: 0, level: 1, stamps: 0, marketAnswered }, facts: {} };
      const h = { events: [], grants: [], base } as unknown as ProgressHistory;
      expect(() => deriveProgress(h, MARKET_CAT)).not.toThrow();
      expect(deriveProgress(h, MARKET_CAT).marketAnswered).toEqual({});
    }
  });
});

describe('marketCatalogue (fix round 1, M4)', () => {
  test('a question id at two stalls, a stall given twice, or an id in two banks of one stall → throws', () => {
    const shared = { ...WEN, questions: [...WEN.questions, BRAM.questions[0]] };
    expect(() => marketCatalogue([BRAM, shared])).toThrow(/bram-braise-cut.*two stalls|two stalls.*bram-braise-cut/);
    expect(() => marketCatalogue([BRAM, BRAM])).toThrow(/given twice/);
    expect(() => marketCatalogue([{ ...WEN, seasonal: { r: { '6': [WEN.questions[0]] } } }])).toThrow(/two banks/);
    expect(marketCatalogue([BRAM, WEN]).size).toBe(2);
  });
});

describe('never rules', () => {
  test('Guild and free players get identical grants for identical stall rounds (no entitlements import, architecture test)', () => {
    // grantsFor has no entitlement input (its six parameters are the event, history, catalogue, data, thresholds and
    // rules); packages/core/test/progress-architecture.test.ts pins that progress/ never names entitlements.
    expect(grantsFor.length).toBe(6);
    const events = [ev.round('bram', MON, [['bram-thermometer', 0]]), ev.round('wen', MON, [['wen-berries', 0]])];
    const free = run(events);
    const guild = run(events);
    expect(guild.results).toEqual(free.results);
    // An entitlement field on the event is outside the shape: rejected for everyone alike, never read as a perk.
    const flagged = { ...events[0], guild: true } as unknown as ProgressEvent;
    expect(one(flagged).problems).toEqual(['bad_event']);
    // Every day of the week earns the same: no market-day bonus.
    const byDay = Array.from({ length: 7 }, (_, d) => xpOf(one(ev.round('bram', addDays(MON, d), [['bram-thermometer', 0]])).grants));
    expect(new Set(byDay)).toEqual(new Set([5]));
  });

  test('validateRewards requires xp.market_game and stamps.market_game; the shipped data/rewards.yaml passes', () => {
    // The shipped file itself: packages/core/test/progress-data.test.ts (it equals DATA, checked here).
    expect(validateRewards(DATA)).toEqual([]);
    const { market_game: _x, ...xp } = DATA.xp;
    expect(validateRewards({ ...DATA, xp })).toContain('xp.market_game must be a whole number of at least 0');
    const { market_game: _s, ...stamps } = DATA.stamps;
    expect(validateRewards({ ...DATA, stamps })).toContain('stamps.market_game must be a whole number of at least 0');
    expect(validateRewards({ ...DATA, xp: { ...DATA.xp, market_game: -5 } })).toContain('xp.market_game must be a whole number of at least 0');
    expect(DATA.xp.market_game).toBe(5);
    expect(DATA.stamps.market_game).toBe(1);
  });
});
