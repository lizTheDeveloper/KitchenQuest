import { describe, expect, test } from 'vitest';
import content from 'virtual:kq-content';
import type { LineBank, LineTrigger } from '../content/types';
import { REQUIRED_PAN_TRIGGERS } from '../content/required';
import { COMMON_DEFAULTS, createDialogue, defaultFor, DialogueError, fillLine, resolveTrigger } from './dialogue';
import { settingsTriggers } from '../settings/settings-copy';

const bank = (triggers: Record<string, Partial<LineTrigger> & { lines: string[] }>): LineBank => ({
  triggers: Object.fromEntries(Object.entries(triggers).map(([k, v]) => [k, { ai: 'never', ...v }])),
});
const bank6 = bank({ six: { lines: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] } });
const idx = (t: string) => Number(t.slice(1));

describe('dialogue engine', () => {
  test('six-line trigger never repeats within 3', () => {
    for (const r of [0, 0.3, 0.99]) {
      const d = createDialogue(bank6, { random: () => r });
      const picks = Array.from({ length: 12 }, () => idx(d.say('six').text));
      picks.forEach((p, i) => expect(picks.slice(Math.max(0, i - 3), i)).not.toContain(p));
    }
  });

  test('two-line trigger alternates', () => {
    const d = createDialogue(bank({ two: { lines: ['L0', 'L1'] } }), { random: () => 0 });
    expect(Array.from({ length: 4 }, () => idx(d.say('two').text))).toEqual([0, 1, 0, 1]);
  });

  test('one-line trigger repeats', () => {
    const d = createDialogue(content.pan);
    expect(content.pan.triggers['rule.emergency']!.lines).toHaveLength(1);
    expect(d.say('rule.emergency').text).toBe(d.say('rule.emergency').text);
  });

  test('fills vars (numbers are stringified)', () => {
    const d = createDialogue(bank({ g: { lines: ['Morning, {name}. {n} eggs.'] } }));
    expect(d.say('g', { name: 'Sam', n: 3 }).text).toBe('Morning, Sam. 3 eggs.');
  });

  test('skips lines missing a var', () => {
    const d = createDialogue(bank({ g: { lines: ['Hi {name}.', 'Hello.'] } }));
    for (let i = 0; i < 20; i++) expect(d.say('g').text).toBe('Hello.');
  });

  test('documented default when every line needs a var', () => {
    const d = createDialogue(bank({ t: { vars: { hours: "whole hours (default: 'a while')" }, lines: ['{hours} since.', 'Over {hours}.'] } }));
    expect(d.say('t').text).toBe('a while since.');
  });

  test('common default for name', () => {
    expect(COMMON_DEFAULTS.name).toBe('apprentice');
    expect(createDialogue(bank({ g: { lines: ['Morning, {name}.'] } })).say('g').text).toBe('Morning, apprentice.');
  });

  test('missing var without default throws naming trigger and var', () => {
    const d = createDialogue(bank({ cook: { lines: ['Making {dish}.'] } }));
    expect(() => d.say('cook')).toThrow(DialogueError);
    expect(() => d.say('cook')).toThrow(/cook.*dish|dish.*cook/);
  });

  test('falls back to the parent trigger', () => {
    const s = createDialogue(content.pan).say('reminder.hours_since_meal.h7', { hours: 7 });
    expect(s.trigger).toBe('reminder.hours_since_meal');
    expect(resolveTrigger(content.pan, 'reminder.hours_since_meal.h7')).toBe('reminder.hours_since_meal');
  });

  test('unknown trigger throws naming the id', () => {
    expect(() => createDialogue(bank6).say('nope.deeper')).toThrow(/nope\.deeper/);
    expect(resolveTrigger(bank6, 'nope')).toBeNull();
  });

  test('history survives a new engine', () => {
    let saved: Record<string, number[]> = {};
    const a = createDialogue(bank6, { random: () => 0, onHistory: (h) => { saved = h; } });
    const first = [0, 1, 2].map(() => idx(a.say('six').text));
    const b = createDialogue(bank6, { random: () => 0, history: saved });
    expect(first).not.toContain(idx(b.say('six').text));
  });

  test('every required trigger renders', () => {
    const sample = {
      dish: 'Parippu', cook: 'Ammachi Leela', place: 'Kochi', time: '20 minutes', step: 'step 2', technique: 'Tempering',
      // M4: read-backs and intake follow-ups have no defaults on purpose; code always supplies them.
      ingredient: 'peanut', spelled: 'P-E-A-N-U-T', severity: 'a severe allergy', covers: 'peanuts and peanut oil',
      summary: 'toast, breakfast', items: 'rice', day: 'Saturday', count: '5', region: 'Kerala, India', term: 'kiwi', rule: 'tree nut', meal: 'lunch',
      // M5 Step 4: the weekly loop's lines; code always supplies these.
      item: 'spinach', known: 'Heat control', frame: 'Green sauce', slot: 'rice', finding: 'peanut butter contains peanut',
      examples: 'curry leaf or epazote',
      // M5 Step 9: reward lines (progress/announce.ts supplies each from the grant).
      level: '3', stamp: 'A Quest, Completed With Thanks', friend: 'Doña Marisol',
      // M6 Step 5: the market's lines (Steps 8–10 supply these).
      swap: 'shallot', category: 'Local, stored from the autumn harvest', stall: 'Old Wen',
      // M7 Step 5: the heard card's spoken half (the API renders it from its own transcript).
      terms: 'sesame',
      // M7 Step 6: voice.resting's day (Step 9 supplies it from GET /voice/status).
      until: 'Thursday 19 November',
    };
    // M7 Step 9: the Settings screen's copy ships in its lazy module; it renders from there.
    const all = { triggers: { ...content.pan.triggers, ...settingsTriggers } };
    for (const id of REQUIRED_PAN_TRIGGERS) expect(createDialogue(all).say(id, sample).text, id).not.toMatch(/[{}]/);
  });

  test.each([['undefined', undefined], ['null', null], ['empty string', '']])('a %s var counts as missing', (_n, v) => {
    expect(fillLine('Hi {name}.', { name: v })).toBeNull();
    const d = createDialogue(bank({ g: { lines: ['Hi {name}.', 'Hello.'] } }));
    for (let i = 0; i < 10; i++) expect(d.say('g', { name: v }).text).toBe('Hello.');
    // Every line needs it: the default fills in, never "Hi ." or "Hi null."
    expect(createDialogue(bank({ g: { lines: ['Hi {name}.'] } })).say('g', { name: v }).text).toBe('Hi apprentice.');
    expect(() => createDialogue(bank({ c: { lines: ['Making {dish}.'] } })).say('c', { dish: v })).toThrow(/dish/);
  });

  test('zero is a real value, not missing', () => {
    expect(fillLine('{n} left', { n: 0 })).toBe('0 left');
  });

  test('fillLine and defaultFor helpers', () => {
    expect(fillLine('a {x} b', {})).toBeNull();
    expect(defaultFor({ ai: 'never', lines: [], vars: { h: 'x (default: "y")' } }, 'h')).toBe('y');
    expect(defaultFor({ ai: 'never', lines: [] }, 'dish')).toBeNull();
  });
});
