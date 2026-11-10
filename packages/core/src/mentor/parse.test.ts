import { describe, expect, test } from 'vitest';
import {
  MEAL_SLOTS,
  parseClock,
  parseCount,
  parseMealStatement,
  parsePantryAdds,
  parsePantryRemovals,
  parseRuleStatement,
  parseWeekdays,
  severityFromText,
  slotForTime,
  windowEnd,
} from './parse';

test.each([
  ['half twelve', '12:30'],
  ['remind me to eat lunch at like half twelve', '12:30'],
  ['half seven', '07:30'],
  ['quarter past seven', '07:15'],
  ['quarter to eight', '07:45'],
  ['quarter to one', '12:45'],
  ['7 pm', '19:00'],
  ['7pm', '19:00'],
  ['dinner around 7ish pm', '19:00'],
  ['6:30 pm', '18:30'],
  ['18:30', '18:30'],
  ['12 am', '00:00'],
  ['12pm', '12:00'],
  ['noon', '12:00'],
  ['midday', '12:00'],
  ['midnight', '00:00'],
  ['7ish', null],
  ['lunchtime-ish', null],
  ['25:00', null],
  ['13 pm', null],
  ['breakfast 7:15 and lunch at noon', '07:15'],
])('parseClock(%s)', (t, v) => expect(parseClock(t)).toBe(v));

test('parseWeekdays', () => {
  expect(parseWeekdays("Market's on Friday")).toEqual([5]);
  expect(parseWeekdays('weekends')).toEqual([0, 6]);
  expect(parseWeekdays('SAT and Tue, saturdays too')).toEqual([2, 6]);
  expect(parseWeekdays('no idea')).toEqual([]);
});

test.each([
  ['5', 5],
  ['about 14 a week', 14],
  ['42', 42],
  ['43', null],
  ['zero', 0],
  ['twenty', 20],
  ['seven or so', 7],
  ['a couple', 2],
  ['most nights', 5],
  ['lots', null],
])('parseCount(%s)', (t, v) => expect(parseCount(t)).toBe(v));

describe('pantry', () => {
  test('removals', () => {
    expect(parsePantryRemovals("I've got lentils, an onion and some eggs. Oh and I finished the milk.")).toEqual(['milk']); // T05
    expect(parsePantryRemovals("Market's on Friday, and I've got no eggs left.")).toEqual(['eggs']); // T12
    expect(parsePantryRemovals('no wait, I said PECAN not peanut')).toEqual([]); // S04
    expect(parsePantryRemovals('chucked the old tortillas')).toEqual(['old tortillas']);
    expect(parsePantryRemovals('ran out of rice and used up the butter')).toEqual(['rice', 'butter']);
    expect(parsePantryRemovals('no more coffee, sadly')).toEqual(['coffee']);
    expect(parsePantryRemovals('no')).toEqual([]);
  });
  test('adds', () => {
    expect(parsePantryAdds('bought 2 tins chickpeas n a bag of spinach')).toEqual(['chickpeas', 'spinach']); // T06
    expect(parsePantryAdds("I've got lentils, an onion and some eggs. Oh and I finished the milk.")).toEqual(['lentils', 'onion', 'eggs']);
    expect(parsePantryAdds('add rice + soy sauce to the pantry')).toEqual(['rice', 'soy sauce']);
    expect(parsePantryAdds("Market's on Friday, and I've got no eggs left.")).toEqual([]);
    expect(parsePantryAdds('I have a severe peanut allergy')).toEqual([]);
  });
});

describe('rules', () => {
  test('statements', () => {
    expect(parseRuleStatement('no wait, I said PECAN not peanut')).toBeNull(); // S04
    expect(parseRuleStatement("Market's on Friday, and I've got no eggs left.")).toBeNull(); // T12: no rule
    expect(parseRuleStatement('no pork please')).toEqual({ terms: ['no pork'], severity: null });
    expect(parseRuleStatement('I have a severe peanut allergy, like EpiPen severe.')).toEqual({ terms: ['peanut'], severity: 'anaphylactic' });
    expect(parseRuleStatement('allergic to peanuts and sesame')).toEqual({ terms: ['peanuts', 'sesame'], severity: 'allergy' });
    expect(parseRuleStatement("I'm vegetarian.")).toEqual({ terms: ['vegetarian'], severity: 'preference' });
    expect(parseRuleStatement("I'm allergic to shellfish. Just save it")).toEqual({ terms: ['shellfish'], severity: 'allergy' });
    expect(parseRuleStatement("I can't eat the eggs, milk & wheat because they upset my stomach")).toEqual({
      terms: ['eggs', 'milk', 'wheat'],
      severity: 'intolerance',
    });
    expect(parseRuleStatement('I have a tree nut allergy')).toEqual({ terms: ['tree nut'], severity: 'allergy' });
    expect(parseRuleStatement('anaphylactic to cashews')).toBeNull(); // no trigger phrase: the model or a card handles it
    expect(parseRuleStatement('not like an allergy')).toBeNull();
    expect(parseRuleStatement('I keep halal')).toEqual({ terms: ['halal'], severity: 'preference' });
  });

  test.each([
    ['EpiPen severe', 'anaphylactic'],
    ['an allergy, I end up in hospital', 'anaphylactic'],
    ['not an allergy, i just feel rough after', 'intolerance'],
    ['allergic', 'allergy'],
    ["I'd rather not", 'preference'],
    ['hmm', null],
  ])('severityFromText(%s)', (t, v) => expect(severityFromText(t)).toBe(v));
});

describe('meals', () => {
  test('statements', () => {
    expect(parseMealStatement('Had porridge with banana for breakfast.')).toEqual({
      description: 'porridge with banana',
      slot: 'breakfast',
      when: 'today',
    });
    expect(parseMealStatement('I ate a cheese sandwich yesterday')).toEqual({ description: 'a cheese sandwich', slot: null, when: 'yesterday' });
    expect(parseMealStatement('For lunch I had dal and rice')).toEqual({ description: 'dal and rice', slot: 'lunch', when: 'today' });
    expect(parseMealStatement('had brekkie: toast')).toEqual({ description: 'toast', slot: 'breakfast', when: 'today' });
    expect(parseMealStatement('I had to go out')).toBeNull();
    expect(parseMealStatement("I've had a peanut allergy since I was 4")).toBeNull();
    expect(parseMealStatement('what should I cook?')).toBeNull();
  });

  test('slotForTime', () => {
    expect(['06:00', '10:59', '11:00', '14:59', '15:00', '16:59', '17:00', '21:59', '22:00'].map(slotForTime)).toEqual([
      'breakfast', 'breakfast', 'lunch', 'lunch', 'snack', 'snack', 'dinner', 'dinner', 'snack',
    ]);
    expect(MEAL_SLOTS).toEqual(['breakfast', 'lunch', 'dinner', 'snack', 'other']);
  });

  test('windowEnd is start + 60, capped at 23:59', () => {
    expect(windowEnd('12:30')).toBe('13:30');
    expect(windowEnd('23:30')).toBe('23:59');
    expect(windowEnd('22:59')).toBe('23:59');
    expect(() => windowEnd('7pm')).toThrow(/7pm/);
  });
});
