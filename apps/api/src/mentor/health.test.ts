// M4 Step 7 fix round 1: the stage-4 health predicate catches every probe text (rev7/probe.test.ts).
import { classifyTurn } from '@kitchenquest/core';
import { expect, test } from 'vitest';
import { defaultCatalog } from '../catalog.js';
import { isHealthText, ruleWords } from './health.js';

const catalog = defaultCatalog();

test.each([
  'my throat is closing up after the satay',
  "I think I'm having a reaction",
  'should I use my epipen',
  'my lips are swelling after eating nuts',
  "can't breathe",
  'my son ate peanuts and has hives',
  'my daughter is allergic to eggs',
  "i'm diabetic",
  "I'm pregnant, what should I avoid",
  'I take metformin',
  'alergic to penuts',
  "I'm coeliac",
  'nut free please',
  'I get migraines from cheese',
  "I'm allergic to boring food. What should I cook tonight?",
  "I'm allergic to Mondays, what's for dinner",
  'how many mg of ibuprofen',
  'my wife is allergic to shellfish',
])('%j is a health turn', (text) => expect(isHealthText(text, catalog)).toBe(true));

test('a child is pre-routed before the health gate', () => expect(classifyTurn("I'm 9 and I like pizza")).toBe('child'));

test.each(['what should I cook tonight?', 'tell me a joke', 'my market day is saturday'])('%j is not', (text) =>
  expect(isHealthText(text, catalog)).toBe(false),
);

test('ruleWords covers names, aliases, kinds and rule-term phrases', () => {
  const words = ruleWords(
    [
      { id: 'a', target: { kind: 'ingredient', ids: ['milk'] }, type: 'avoid', severity: 'intolerance' },
      { id: 'b', target: { kind: 'category', ids: ['shellfish'] }, type: 'avoid', severity: 'allergy' },
    ],
    catalog,
  );
  expect(words).toEqual(expect.arrayContaining(['milk', 'dairy', 'lactose', 'shellfish', 'prawn']));
});

// Fix round 2: the re-review's gate readings (rev7b/r2 and r3).
test.each([
  'can I eat this one?', 'is this ok for me?', 'milc makes me sick', 'egs give me a rash', 'my kid cant have soi', 'nutz make me ill', 'fsh makes me throw up',
  'kiwi makes my mouth itch', 'oats make me bloated', 'shrimp gives me a rash', 'mlik upsets my stomach', 'peaunts make me ill', 'pnuts make me ill',
  'sesmae is bad for me', 'gluten makes me sick', 'my tummy hurts after cheese', 'I threw up after the prawns', 'I get a rash from tomatos',
  'egs make me throw up', 'my stomach hurts after dinner', 'I feel sick after eating bread', 'I get itchy after kiwi',
])('%j is a health turn (fix round 2)', (text) => expect(isHealthText(text, catalog)).toBe(true));

test.each(['what should I cook tonight?', 'we finished it', 'change my market day to saturday', 'i moved house', 'I have no money, what can I cook', 'my mouse broke'])(
  '%j is not (fix round 2)',
  (text) => expect(isHealthText(text, catalog)).toBe(false),
);

test('ruleWords include what a target is a kind of (R7)', () => {
  expect(ruleWords([{ id: 'p', target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'allergy' }], catalog)).toEqual(
    expect.arrayContaining(['peanut', 'groundnut', 'nut']),
  );
});

// Fix round 3: the re-review's gate hunt (rev7c/gate.test.ts).
test.each([
  'is pad thai a good shout tonight?', 'should I order the satay?', 'fancy a korma, good idea for me?', 'is the curry from last night good to go?',
  'thinking of getting a takeaway pad thai, yay or nay?', 'can I go for the pad thai', 'is it okay if I have the pad thai', 'am I ok with pad thai',
  'is pad thai alright', 'pad thai good for me?', 'will pad thai be a problem', 'any issue with pad thai for me?', 'would I be fine with a satay',
  'can i eat pad thai', 'can I eat it', 'can I eat these', 'can I eat that one', 'could I have this', 'may I eat this', 'is this okay', 'is it ok to eat',
  "I'm allergic to nots", 'nots, dinner ideas?', 'no nots please', 'my kid is allergic to egs', 'egs, what can I cook', 'mild makes me ill',
  'can I have this? nuts give me a rash', 'can I eat this, peanuts and me do not mix', 'is this ok for me, I react to sesame', 'can I eat this? I am coeliac',
  'can I have this, I get hives from prawns', 'can I eat this? shrimp makes my throat close',
])('%j is a health turn (fix round 3)', (text) => expect(isHealthText(text, catalog)).toBe(true));

test.each(['what is a better idea for tea', 'got any ideas for the union day party', 'what shall I make tonight', 'quick weeknight meal ideas', 'I have a slow cooker'])(
  '%j is not (fix round 3)',
  (text) => expect(isHealthText(text, catalog)).toBe(false),
);
