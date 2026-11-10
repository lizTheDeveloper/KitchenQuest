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
    expect(parseRuleStatement('no pork please')).toMatchObject({ terms: ['no pork'], severity: null });
    expect(parseRuleStatement('I have a severe peanut allergy, like EpiPen severe.')).toMatchObject({ terms: ['peanut'], severity: 'anaphylactic' });
    expect(parseRuleStatement('allergic to peanuts and sesame')).toMatchObject({ terms: ['peanuts', 'sesame'], severity: 'allergy' });
    expect(parseRuleStatement("I'm vegetarian.")).toMatchObject({ terms: ['vegetarian'], severity: 'preference' });
    expect(parseRuleStatement("I'm allergic to shellfish. Just save it")).toMatchObject({ terms: ['shellfish'], severity: 'allergy' });
    expect(parseRuleStatement("I can't eat the eggs, milk & wheat because they upset my stomach")).toMatchObject({
      terms: ['eggs', 'milk', 'wheat'],
      severity: null, // a symptom is not a severity word: the card asks
    });
    expect(parseRuleStatement('I have a tree nut allergy')).toMatchObject({ terms: ['tree nut'], severity: 'allergy' });
    expect(parseRuleStatement('anaphylactic to cashews')).toMatchObject({ terms: ['cashews'], severity: 'anaphylactic' });
    expect(parseRuleStatement('peanut and sesame allergy')).toMatchObject({ terms: ['peanut', 'sesame'], severity: 'allergy' });
    expect(parseRuleStatement('not like an allergy')).toBeNull();
    expect(parseRuleStatement('I keep halal')).toMatchObject({ terms: ['halal'], severity: 'preference' });
    expect(parseRuleStatement('allergic to peanuts and sesame')!.items).toEqual([
      { term: 'peanuts', severity: 'allergy' },
      { term: 'sesame', severity: 'allergy' },
    ]);
  });

  test.each([
    ['EpiPen severe', 'anaphylactic'],
    ['an allergy, I end up in hospital', 'anaphylactic'],
    ['not an allergy, i just feel rough after', null], // a symptom is not a severity word
    ['intolerant, not an allergy', 'intolerance'],
    ['allergic', 'allergy'],
    ["I'd rather not", 'preference'],
    ['peanut allergy, it upsets my stomach', 'allergy'], // allergy beats a soft cue
    ['not like an allergy, it upsets my stomach', null],
    ["I'm vegan", null], // a diet word is not a severity
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

const severities = (text: string) => parseRuleStatement(text)?.items.map((i) => [i.term, i.severity]);

describe('fix round 1: a parser only keeps or raises a stated severity (C1)', () => {
  test.each([
    ["I'm vegetarian and can't eat peanuts", [['vegetarian', 'preference'], ['peanuts', null]], null],
    ["can't eat peanuts, I prefer to be safe", [['peanuts', null]], null],
    ["I'm coeliac and vegan", [['coeliac', null], ['vegan', 'preference']], null],
    ["I have a peanut allergy, I'm really sensitive to it", [['peanut', 'allergy']], 'allergy'],
    ['peanut allergy, it upsets my stomach', [['peanut', 'allergy']], 'allergy'],
    ['allergic to peanuts and sensitive to milk', [['peanuts', 'allergy'], ['milk', null]], null], // "sensitive" is not a severity word
    ['allergic to peanuts and intolerant to milk', [['peanuts', 'allergy'], ['milk', 'intolerance']], null],
    ['garlic kinda wrecks my stomach, it is not an allergy, I just avoid garlic', [['garlic', null]], null], // symptoms never lower the default
    ["I can't eat milk because it upsets my stomach", [['milk', null]], null],
    ["I can't eat onions, they make me feel sick", [['onions', null]], null],
    ['lactose intolerance', [['lactose', 'intolerance']], 'intolerance'],
    ["I'm intolerant to milk, it's not an allergy", [['milk', 'intolerance']], 'intolerance'],
    ["I'm allergic to peanuts, not like an allergy really", [['peanuts', null]], null], // conflicting → asked
    ["I'm vegan and severely allergic to sesame", [['vegan', 'preference'], ['sesame', 'anaphylactic']], null],
    ["I can't eat shellfish, I end up in hospital", [['shellfish', 'anaphylactic']], 'anaphylactic'],
  ])('%s', (text, items, overall) => {
    expect(severities(text)).toEqual(items);
    expect(parseRuleStatement(text)!.severity).toBe(overall);
  });
});

describe('fix round 1: term splitting (I2)', () => {
  test.each([
    ["I can't eat pork or shellfish", ['pork', 'shellfish']],
    ['allergic to shellfish\nAlso allergic to sesame', ['shellfish', 'sesame']],
    ['allergic to tree nuts e.g. cashews', ['tree nuts', 'cashews']],
    ['allergic to tree nuts, eg cashews and pecans', ['tree nuts', 'cashews', 'pecans']],
    ['allergic to nuts like cashews', ['nuts', 'cashews']],
    ['Allergic to: peanuts, sesame', ['peanuts', 'sesame']],
    ['allergic - peanuts', ['peanuts']],
    ['Allergies: peanuts and milk', ['peanuts', 'milk']],
    ['allergic to peanuts and sensitive to milk', ['peanuts', 'milk']],
  ])('%s', (text, terms) => expect(parseRuleStatement(text)?.terms).toEqual(terms));
});

describe('fix round 1: negation and pronouns (I3, M6, M2)', () => {
  test.each([
    "I don't have a peanut allergy",
    "I'm not vegan",
    'not allergic to anything',
    "I'm never allergic to anything",
    'I avoid it',
    'I had a veggie burger',
    'veggies are great',
  ])('%s → no terms', (text) => expect(parseRuleStatement(text)).toBeNull());

  test('negation is per clause', () => {
    expect(parseRuleStatement("No, I'm allergic to peanuts")?.terms).toEqual(['peanuts']);
    expect(parseRuleStatement("I'm not vegan but I am vegetarian")?.terms).toEqual(['vegetarian']);
    expect(parseRuleStatement("I'm not sure but I'm allergic to sesame")?.terms).toEqual(['sesame']);
  });

  test('veggie needs a rule cue', () => {
    expect(parseRuleStatement("I'm veggie")?.terms).toEqual(['veggie']);
    expect(parseRuleStatement('we are veggie')?.terms).toEqual(['veggie']);
    expect(parseRuleStatement('veggie diet')?.terms).toEqual(['veggie']);
  });
});

describe('fix round 1: clocks, counts, weekdays, pantry, meals (M3–M5)', () => {
  test.each([
    ['half past seven', '07:30'],
    ['half seven pm', '19:30'],
    ['7.30pm', '19:30'],
    ['19.30', '19:30'],
    ["7 o'clock", '07:00'],
    ['seven oclock pm', '19:00'],
    ['it costs £7.50', null],
    ['1.50 servings', null],
  ])('parseClock(%s)', (t, v) => expect(parseClock(t)).toBe(v));

  test('parseCount refuses a range', () => {
    expect(parseCount('5-6')).toBeNull();
    expect(parseCount('5 to 6 a week')).toBeNull();
    expect(parseCount('five or six')).toBeNull();
  });

  test.each([
    ['I sat down', []],
    ['mon dieu', []],
    ['wed like to cook', []],
    ['sat', [6]],
    ['sat and sun', [0, 6]],
    ['Fri', [5]],
    ['the market is fri, sat', [5, 6]],
    ['Saturday', [6]],
    ['every saturday when the sun is out', [6]],
  ])('parseWeekdays(%s)', (t, v) => expect(parseWeekdays(t)).toEqual(v));

  test('removals keep going through a list', () => {
    expect(parsePantryRemovals('finished the milk and eggs')).toEqual(['milk', 'eggs']);
    expect(parsePantryRemovals('ran out of rice, lentils and the oats.')).toEqual(['rice', 'lentils', 'oats']);
    expect(parsePantryRemovals('finished the milk and I bought eggs')).toEqual(['milk']);
  });

  test.each(['had enough', 'had a long day', 'had a go at it', 'I had it', 'had a look'])('%s is not a meal', (t) =>
    expect(parseMealStatement(t)).toBeNull(),
  );
});

describe('fix round 2: an unattached allergy word voids intolerance (R1)', () => {
  test.each([
    "I'm allergic and intolerant to milk",
    'allergic/intolerant to milk',
    "I'm allergic & intolerant to milk",
    'intolerant to milk and allergic to it',
    "milk intolerance, it's actually an allergy",
    'intolerant to milk (allergic actually)',
    "I'm intolerant to milk, I'm also allergic",
    'intolerant to milk + allergic to it',
    'intolerant to milk; allergic',
  ])('%s → milk null', (text) => {
    expect(parseRuleStatement(text)?.items).toEqual([{ term: 'milk', severity: null }]);
  });

  test('an allergy that names its own term leaves the intolerance alone', () => {
    expect(severities('allergic to peanuts and intolerant to milk')).toEqual([['peanuts', 'allergy'], ['milk', 'intolerance']]);
    expect(severities("I'm not allergic, just intolerant to milk")).toEqual([['milk', 'intolerance']]);
  });
});

describe('fix round 2: recall (R4, minor)', () => {
  test.each([
    ['no allergies apart from peanuts', [['peanuts', 'allergy']]],
    ['no allergies except peanuts', [['peanuts', 'allergy']]],
    ["I haven't got any allergies except peanuts", [['peanuts', 'allergy']]],
    ["I'm allergic to nothing except peanuts", [['peanuts', 'allergy']]],
    ["I'm lactose intolerant", [['lactose', 'intolerance']]],
    ["I'm gluten intolerant", [['gluten', 'intolerance']]],
    ['peanuts - allergic', [['peanuts', 'allergy']]],
    ['no allergies, but I avoid pork', [['pork', null]]],
    ["I'm allergic to peanuts, tree nuts are fine", [['peanuts', 'allergy']]],
    ['allergic to peanuts, milk is ok', [['peanuts', 'allergy']]],
    ['allergic to peanuts maybe', [['peanuts', 'allergy']]],
    ['allergic to them', undefined],
    ['allergic to it all', undefined],
    ['allergic to everything too', undefined],
    ["I'm allergic to peanuts, my son is intolerant to them", [['peanuts', 'allergy']]],
    ['intolerant to milk and my allergist says avoid it', [['milk', null]]],
  ])('%s', (text, items) => expect(severities(text)).toEqual(items));

  test('"but only mildly to milk" keeps milk as a term; mildly never lowers it', () => {
    const r = parseRuleStatement("I'm severely allergic to peanuts but only mildly to milk")!;
    expect(r.terms).toEqual(['peanuts', 'milk']);
    expect(r.items[0].severity).toBe('anaphylactic');
    expect(['anaphylactic', 'allergy', null]).toContain(r.items[1].severity); // over-raising is accepted
  });
});
