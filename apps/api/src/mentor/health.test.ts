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
