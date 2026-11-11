import { describe, expect, test } from 'vitest';
import { EMPTY_TOOLKIT, recordTechnique, toolkitFromEvents } from '../toolkit/toolkit';
import type { TechniqueRecord, ToolkitState } from '../toolkit/types';
import { deriveProgress } from './derive';
import { CAT, DATA, EMPTY, T, addDays, ev, finishQuest, last, play, xpOf } from './fixtures';
import { MAX_PROGRESS_EVENTS_PER_DAY, grantsFor, validateRewards } from './rewards';
import type { ProgressEvent, RewardGrant, RewardsData } from './types';

const MON = '2026-01-05'; // a Monday, ISO week 2026-W02
const kinds = (gs: readonly RewardGrant[]) => gs.map((g) => (g.kind === 'xp' ? `xp:${g.reason}:${g.amount}` : g.kind === 'stamp' ? `stamp:${g.stamp}` : g.kind === 'trust' ? `trust:${g.cook}:${g.level}` : g.kind === 'level' ? `level:${g.level}` : `certificate:${g.technique}`));
const tierOf = (p: ReturnType<typeof play>, technique: string) => deriveProgress(p.history, CAT).toolkit.techniques[technique]?.tier;

describe('cooked', () => {
  test('a cooked event grants cook XP, Tried, and the level crossing; a second distinct recipe gives Yours + certificate + stamp', () => {
    // 40 (quest) + 10 (drill) + 10 (lesson) + 20 (market) = 80 XP before the cook.
    const before = [...finishQuest('leela-tempering', MON), ev.drill('leela-tempering', 3, 'knife', MON), ev.lesson('parippu', MON), ev.market(MON)];
    const p = play([...before, ev.cooked('parippu', MON)]);
    expect(p.results.every((r) => r.problems.length === 0)).toBe(true);
    expect(kinds(last(p).grants)).toEqual(['xp:cook:30', 'level:2']);
    expect(tierOf(p, 'tempering')).toBe('tried');
    expect(deriveProgress(p.history, CAT)).toMatchObject({ xp: 110, level: 2 });

    const q = play([ev.cooked('frijoles-de-olla', addDays(MON, 1))], p.history);
    expect(kinds(last(q).grants)).toEqual(['xp:cook:30', 'certificate:legumes', 'stamp:certificate', 'certificate:heat-control', 'stamp:certificate']);
    expect(tierOf(q, 'legumes')).toBe('yours');
    expect(tierOf(q, 'patience')).toBe('tried');
    // Yours again from a third dish: no second certificate.
    const r = play([ev.cooked('onigiri', addDays(MON, 2))], q.history);
    expect(kinds(last(r).grants)).toEqual(['xp:cook:30']);
  });

  test('cook XP once per recipe per day; a re-cook next day earns again', () => {
    const p = play([ev.cooked('parippu', MON), ev.cooked('parippu', MON), ev.cooked('parippu', addDays(MON, 1))]);
    expect(p.results.map((r) => xpOf(r.grants))).toEqual([30, 0, 30]);
    expect(p.results.every((r) => r.problems.length === 0)).toBe(true);
    expect(deriveProgress(p.history, CAT).cookedOn.parippu).toEqual([MON, addDays(MON, 1)]);
  });

  test('refresh XP only when the technique was Rusty before the event, once per refresh', () => {
    // 119 days later is Warm: no refresh. 120 days is Rusty: one refresh per technique. The next day it is Sharp.
    const warm = play([ev.cooked('parippu', MON), ev.cooked('parippu', addDays(MON, 119))]);
    expect(kinds(last(warm).grants)).toEqual(['xp:cook:30']);
    const rusty = play([ev.cooked('parippu', MON), ev.cooked('parippu', addDays(MON, 120)), ev.cooked('parippu', addDays(MON, 121))]);
    expect(kinds(rusty.results[1].grants)).toEqual(['xp:cook:30', 'xp:refresh:15', 'xp:refresh:15', 'xp:refresh:15', 'level:2']);
    expect(kinds(rusty.results[2].grants)).toEqual(['xp:cook:30']);
    // Frijoles in between keeps legumes and heat-control used: only tempering has gone Rusty.
    const some = play([ev.cooked('parippu', MON), ev.cooked('frijoles-de-olla', addDays(MON, 60)), ev.cooked('parippu', addDays(MON, 130))]);
    expect(kinds(some.results[2].grants)).toEqual(['xp:cook:30', 'xp:refresh:15', 'level:2']);
    // A Seen technique has nothing to fade.
    const seen = play([ev.lesson('parippu', MON), ev.cooked('parippu', addDays(MON, 400))]);
    expect(kinds(last(seen).grants)).toEqual(['xp:cook:30']);
  });

  test('sacred recipe: zero grants, event still in deriveProgress().cookedOn', () => {
    const p = play([ev.lesson('ofrenda', MON), ev.cooked('ofrenda', MON), ev.cooked('ofrenda', addDays(MON, 8))]);
    for (const r of p.results) expect(r).toMatchObject({ grants: [], problems: [] });
    const view = deriveProgress(p.history, CAT);
    expect(view.cookedOn.ofrenda).toEqual([MON, addDays(MON, 8)]);
    expect(view.toolkit).toEqual(EMPTY_TOOLKIT);
    expect(view.xp).toBe(0);
  });
});

describe('nourishment', () => {
  test('nourishment: 3 logs ≥ 2 h apart earn 5 each; a 4th earns 0; a log 1 h after the last earns 0', () => {
    const p = play([ev.meal(MON, 480), ev.meal(MON, 600), ev.meal(MON, 720), ev.meal(MON, 900)]);
    expect(p.results.map((r) => xpOf(r.grants))).toEqual([5, 5, 5, 0]);
    const q = play([ev.meal(MON, 480), ev.meal(MON, 540)]);
    expect(q.results.map((r) => xpOf(r.grants))).toEqual([5, 0]);
    // A new day starts fresh; the amount never depends on anything eaten (the event has no meal content).
    expect(xpOf(last(play([ev.meal(addDays(MON, 1), 480)], p.history)).grants)).toBe(5);
  });

  test('nourishment counts grants, not events: a deleted/undone meal never re-opens the cap (Ruling 6)', () => {
    // Three earning logs, then the player undoes them all: the meal rows go, the progress ledger keeps its grants.
    const p = play([ev.meal(MON, 480), ev.meal(MON, 600), ev.meal(MON, 720)]);
    expect(xpOf(last(play([ev.meal(MON, 1000)], p.history)).grants)).toBe(0);
    // The gap is measured from logs that earned, not from every log: 540 earned nothing, so 600 is 2 h after 480.
    const q = play([ev.meal(MON, 480), ev.meal(MON, 540), ev.meal(MON, 600)]);
    expect(q.results.map((r) => xpOf(r.grants))).toEqual([5, 0, 5]);
    // And a non-earning log never uses up the cap: five logs, three earn.
    const r = play([480, 500, 600, 610, 720].map((m) => ev.meal(MON, m)));
    expect(r.results.map((x) => xpOf(x.grants))).toEqual([5, 0, 5, 0, 5]);
  });
});

describe('trust', () => {
  test('trust: quest_done → 1; cook-weeks 2/4/7/10 → 2..5; two cooks the same week → one rise; a 6-week gap loses nothing', () => {
    let p = play(finishQuest('leela-tempering', MON));
    expect(kinds(last(p).grants)).toEqual(['xp:quest:40', 'stamp:quest_done', 'trust:leela:1']);
    const rises: Record<number, string[]> = {};
    // Weeks 0–6 in a row, then a six-week gap, then weeks 13–16. Two cooks in week 1 (parippu and sambar).
    for (const w of [0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16]) {
      const events = w === 1 ? [ev.cooked('parippu', addDays(MON, 7)), ev.cooked('sambar', addDays(MON, 9))] : [ev.cooked('parippu', addDays(MON, 7 * w))];
      p = play(events, p.history);
      rises[w] = p.results.flatMap((r) => r.grants.filter((g) => g.kind === 'trust').map((g) => `${g.kind === 'trust' && g.level}`));
    }
    expect(rises).toEqual({ 0: [], 1: ['2'], 2: [], 3: ['3'], 4: [], 5: [], 6: ['4'], 13: [], 14: [], 15: ['5'], 16: [] });
    expect(deriveProgress(p.history, CAT).trust).toEqual({ leela: 5 });
  });

  test('trust rises at most one level per event and never to a level the data has no name for', () => {
    // Ten cook-weeks as a Stranger (no quest yet): trust is earned through the cook's quest first.
    let p = play(Array.from({ length: 10 }, (_, w) => ev.cooked('parippu', addDays(MON, 7 * w))));
    expect(p.history.grants.filter((g) => g.kind === 'trust')).toEqual([]);
    p = play(finishQuest('leela-tempering', addDays(MON, 70)), p.history);
    expect(deriveProgress(p.history, CAT).trust).toEqual({ leela: 1 });
    const levels: number[] = [];
    for (let w = 11; w < 18; w++) {
      p = play([ev.cooked('parippu', addDays(MON, 7 * w))], p.history);
      const t = last(p).grants.filter((g) => g.kind === 'trust');
      expect(t.length).toBeLessThanOrEqual(1);
      levels.push(deriveProgress(p.history, CAT).trust.leela);
    }
    expect(levels).toEqual([2, 3, 4, 5, 5, 5, 5]);
    // Data with fewer names caps there.
    const short: RewardsData = { ...DATA, trust: { names: ['Stranger', 'Guest', 'Acquainted'], weeks_for_level: [1] } };
    let s = play(finishQuest('leela-tempering', MON), EMPTY, short);
    for (let w = 0; w < 5; w++) s = play([ev.cooked('parippu', addDays(MON, 7 * w))], s.history, short);
    expect(Math.max(...s.history.grants.map((g) => (g.kind === 'trust' ? g.level : 0)))).toBe(2);
  });

  test('trust is per cook: cooking two cooks the same week raises each by its own weeks', () => {
    const p = play([
      ...finishQuest('leela-tempering', MON),
      ...finishQuest('marisol-salt-question', MON),
      ev.cooked('parippu', MON),
      ev.cooked('frijoles-de-olla', MON),
      ev.cooked('parippu', addDays(MON, 7)),
      ev.cooked('frijoles-de-olla', addDays(MON, 7)),
    ]);
    expect(deriveProgress(p.history, CAT).trust).toEqual({ leela: 2, marisol: 2 });
  });
});

describe('recognized', () => {
  test('recognized: Tried from another cook → Yours; same cook or Seen only → recorded, no grant', () => {
    const setup = play([...finishQuest('leela-tempering', MON), ...finishQuest('marisol-salt-question', MON), ...finishQuest('haruka-gluey-rice', MON), ev.cooked('parippu', MON)]);
    // heat-control is Tried from parippu (Leela's); Haruka recognizes it.
    const yes = play([ev.recognized('haruka-gluey-rice', 'heat-control', addDays(MON, 1))], setup.history);
    expect(last(yes)).toMatchObject({ problems: [] });
    expect(kinds(last(yes).grants)).toEqual(['certificate:heat-control', 'stamp:certificate']);
    expect(tierOf(yes, 'heat-control')).toBe('yours');
    // Tempering is Tried from Leela's own dish: Leela's quest recognizing it gives nothing.
    const same = play([ev.recognized('leela-tempering', 'tempering', addDays(MON, 1))], setup.history);
    expect(last(same)).toMatchObject({ grants: [], problems: [] });
    expect(tierOf(same, 'tempering')).toBe('tried');
    // Knife is only Seen (from the quest): nothing.
    const seen = play([ev.recognized('haruka-gluey-rice', 'knife', addDays(MON, 1))], setup.history);
    expect(last(seen)).toMatchObject({ grants: [], problems: [] });
    expect(tierOf(seen, 'knife')).toBe('seen');
    expect(seen.history.events).toHaveLength(setup.history.events.length + 1);
  });
});

describe('quests', () => {
  test('quest_done grants once, ever, only with every step done', () => {
    const p = play([ev.step('leela-tempering', 1, MON), ev.done('leela-tempering', MON)]);
    expect(last(p).problems).toEqual(['quest_not_finished']);
    const q = play([...finishQuest('leela-tempering', MON), ev.done('leela-tempering', MON)]);
    expect(last(q)).toMatchObject({ grants: [], problems: ['quest_already_done'] });
    expect(deriveProgress(q.history, CAT)).toMatchObject({ questsDone: ['leela-tempering'], questSteps: { 'leela-tempering': 5 }, stamps: 1 });
  });

  test('quest_step out of order, unknown quest, unknown recipe, bad date, duplicate id → problems, no grants', () => {
    const base = play([ev.step('leela-tempering', 1, MON)]).history;
    const dup: ProgressEvent = { ...ev.cooked('parippu', MON), id: base.events[0].id };
    const cases: [ProgressEvent, string][] = [
      [ev.step('leela-tempering', 3, MON), 'step_out_of_order'],
      [ev.step('leela-tempering', 1, MON), 'step_out_of_order'],
      [ev.step('leela-tempering', 6, MON), 'unknown_step'],
      [ev.step('nobody-quest', 1, MON), 'unknown_quest'],
      [ev.cooked('pizza', MON), 'unknown_recipe'],
      [ev.lesson('pizza', MON), 'unknown_recipe'],
      [ev.cooked('parippu', '2026-02-30'), 'bad_date'],
      [ev.cooked('parippu', 'yesterday'), 'bad_date'],
      [dup, 'duplicate_id'],
      [ev.drill('leela-tempering', 3, 'juggling', MON), 'unknown_technique'],
      [ev.frame('nothing', 'stir-fry', MON), 'unknown_frame'],
      [ev.frame('fried-rice', 'emulsion', MON), 'technique_mismatch'],
      [ev.meal(MON, 1440), 'bad_field'],
      [ev.market(MON, 'soon'), 'bad_field'],
    ];
    for (const [event, problem] of cases) {
      const r = grantsFor(event, base, CAT, DATA, T);
      expect(r, JSON.stringify(event)).toEqual({ grants: [], problems: [problem] });
    }
  });

  test('a quest_step of a quest whose unlock.requires is not done → problems, no grants (C4)', () => {
    expect(grantsFor(ev.step('marisol-salt-question', 1, MON), EMPTY, CAT, DATA, T)).toEqual({ grants: [], problems: ['quest_waiting'] });
    expect(grantsFor(ev.drill('marisol-salt-question', 2, 'legumes', MON), EMPTY, CAT, DATA, T).problems).toEqual(['quest_waiting']);
    const p = play(finishQuest('leela-tempering', MON));
    expect(grantsFor(ev.step('marisol-salt-question', 1, MON), p.history, CAT, DATA, T).problems).toEqual([]);
  });

  test('quest_done makes each rewards.skills key Seen in toolkitFromEvents, with no extra event or grant (Ruling 4)', () => {
    const events = finishQuest('leela-tempering', MON);
    const p = play(events);
    expect(p.history.events).toEqual(events);
    expect(kinds(p.history.grants)).toEqual(['xp:quest:40', 'stamp:quest_done', 'trust:leela:1']);
    const tk = toolkitFromEvents(p.history.events, CAT);
    expect(Object.fromEntries(Object.entries(tk.techniques).map(([k, r]) => [k, r.tier]))).toEqual({ tempering: 'seen', legumes: 'seen', knife: 'seen' });
    expect(deriveProgress(p.history, CAT).toolkit).toEqual(tk);
  });

  test('never throws on player-shaped input', () => {
    const junk: unknown[] = [null, 7, 'cooked', [], {}, { id: 'x' }, { id: 'x', kind: 'cooked', at: MON }, { id: 'x', kind: 'rules', at: MON },
      { id: 'x', kind: 'quest_step', at: MON, quest: 'leela-tempering', step: '1' }, { id: 'x', kind: 'imported', at: MON, technique: 'knife', tier: 'master', firstAt: MON, lastUsedAt: MON, recipes: [] },
      { id: 'x', kind: 'imported', at: MON, technique: 'knife', tier: 'tried', firstAt: MON, lastUsedAt: '2025-01-01', recipes: [] }, { id: 'x'.repeat(200), kind: 'lesson', at: MON, recipe: 'parippu' },
      { id: 'x', kind: 'lesson', at: MON, recipe: '__proto__' }, { id: 'x', kind: 'drill', at: MON, quest: 'constructor', step: 1, technique: 'knife' }];
    for (const e of junk) {
      const r = grantsFor(e as ProgressEvent, EMPTY, CAT, DATA, T);
      expect(r.grants, JSON.stringify(e)).toEqual([]);
      expect(r.problems.length, JSON.stringify(e)).toBeGreaterThan(0);
    }
    expect(grantsFor({ id: 'r', kind: 'rules', at: MON } as unknown as ProgressEvent, EMPTY, CAT, DATA, T).problems).toEqual(['unknown_kind']);
  });
});

describe('caps and weeks', () => {
  test('the 201st event with one local date → problem too_many_events for that event only; other dates still accepted (C14)', () => {
    const p = play(Array.from({ length: MAX_PROGRESS_EVENTS_PER_DAY }, (_, i) => ev.meal(MON, i % 1440)));
    expect(p.history.events).toHaveLength(200);
    expect(grantsFor(ev.cooked('parippu', MON), p.history, CAT, DATA, T)).toEqual({ grants: [], problems: ['too_many_events'] });
    const next = grantsFor(ev.cooked('parippu', addDays(MON, 1)), p.history, CAT, DATA, T);
    expect(next.problems).toEqual([]);
    expect(xpOf(next.grants)).toBe(30);
  });

  test('lesson/drill XP once per ISO week of the event date; market_run XP and stamp once per ISO week (C16)', () => {
    const sun = addDays(MON, 6); // still 2026-W02
    const nextMon = addDays(MON, 7); // 2026-W03
    const lessons = play([ev.lesson('parippu', MON), ev.lesson('parippu', sun), ev.lesson('onigiri', sun), ev.lesson('parippu', nextMon)]);
    expect(lessons.results.map((r) => xpOf(r.grants))).toEqual([10, 0, 10, 10]);
    expect(tierOf(lessons, 'tempering')).toBe('seen');

    const quest = play([...finishQuest('leela-tempering', '2025-12-01')]).history;
    const drills = play([ev.drill('leela-tempering', 3, 'knife', MON), ev.drill('leela-tempering', 3, 'knife', sun), ev.drill('leela-tempering', 4, 'tempering', sun), ev.drill('leela-tempering', 3, 'knife', nextMon)], quest);
    expect(drills.results.map((r) => xpOf(r.grants))).toEqual([10, 0, 10, 10]);

    // Sunday and the next Monday are different ISO weeks, whatever plan week they claim.
    const runs = play([ev.market(MON), ev.market(sun, MON), ev.market(nextMon, MON), ev.market(addDays(nextMon, 2), nextMon)]);
    expect(runs.results.map((r) => kinds(r.grants))).toEqual([['xp:market_run:20', 'stamp:market_run'], [], ['xp:market_run:20', 'stamp:market_run'], []]);
    expect(runs.results.every((r) => r.problems.length === 0)).toBe(true);
  });

  test('frame_cooked: Tried on the frame technique, frame XP once per frame per day, dates kept', () => {
    const p = play([ev.frame('fried-rice', 'stir-fry', MON), ev.frame('fried-rice', 'stir-fry', MON), ev.frame('green-sauce', 'emulsion', MON)]);
    expect(p.results.map((r) => xpOf(r.grants))).toEqual([20, 0, 20]);
    expect(tierOf(p, 'stir-fry')).toBe('tried');
    expect(deriveProgress(p.history, CAT).framesCookedOn).toEqual({ 'fried-rice': [MON], 'green-sauce': [MON] });
  });
});

describe('imported', () => {
  test('imported events rebuild an M3 toolkit exactly and grant nothing', () => {
    const m3: ToolkitState = [
      { kind: 'lesson', technique: 'knife', at: '2026-01-01' },
      { kind: 'cooked', technique: 'tempering', at: '2026-01-02', recipe: 'parippu' },
      { kind: 'cooked', technique: 'legumes', at: '2026-01-02', recipe: 'parippu' },
      { kind: 'cooked', technique: 'legumes', at: '2026-02-10', recipe: 'frijoles-de-olla' },
    ].reduce((s, e) => recordTechnique(s, e as Parameters<typeof recordTechnique>[1]), EMPTY_TOOLKIT);
    const events: ProgressEvent[] = Object.entries(m3.techniques).map(([technique, r]: [string, TechniqueRecord], i) => ({
      id: `imp${i}`, kind: 'imported', at: '2026-03-01', technique, tier: r.tier, firstAt: r.firstAt, lastUsedAt: r.lastUsedAt, recipes: [...r.recipes],
    }));
    const p = play(events);
    for (const r of p.results) expect(r).toMatchObject({ grants: [], problems: [] });
    expect(deriveProgress(p.history, CAT).toolkit).toEqual(m3);
    expect(toolkitFromEvents(events, CAT)).toEqual(m3);
    // Re-importing the same records changes nothing.
    expect(toolkitFromEvents([...events, ...events], CAT)).toEqual(m3);
  });
});

describe('validateRewards', () => {
  test('the fixture data is valid', () => expect(validateRewards(DATA)).toEqual([]));

  test('validateRewards: non-increasing levels, a negative amount, trust names ≠ weeks_for_level + 2 → problems', () => {
    const bad: [string, unknown][] = [
      ['levels', { ...DATA, levels: [100, 100, 250] }],
      ['levels', { ...DATA, levels: [250, 100] }],
      ['levels', { ...DATA, levels: [] }],
      ['xp.cook', { ...DATA, xp: { ...DATA.xp, cook: -30 } }],
      ['xp.refresh', { ...DATA, xp: { ...DATA.xp, refresh: 1.5 } }],
      ['per_log', { ...DATA, xp: { ...DATA.xp, nourishment: { ...DATA.xp.nourishment, per_log: -5 } } }],
      ['stamps.market_run', { ...DATA, stamps: { ...DATA.stamps, market_run: -1 } }],
      ['stamps.loot', { ...DATA, stamps: { ...DATA.stamps, loot: 1 } }],
      ['trust.names', { ...DATA, trust: { ...DATA.trust, names: DATA.trust.names.slice(0, 5) } }],
      ['trust.names', { ...DATA, trust: { names: DATA.trust.names, weeks_for_level: [2, 4, 7] } }],
      ['weeks_for_level', { ...DATA, trust: { names: DATA.trust.names, weeks_for_level: [2, 2, 7, 10] } }],
      ['rewards', null],
    ];
    for (const [what, d] of bad) {
      const problems = validateRewards(d);
      expect(problems.length, what).toBeGreaterThan(0);
      expect(problems.join('\n'), what).toContain(what);
    }
    // The count of trust names follows the thresholds, never a fixed number (C17).
    expect(validateRewards({ ...DATA, trust: { names: ['Stranger', 'Guest', 'Acquainted'], weeks_for_level: [3] } })).toEqual([]);
  });
});
