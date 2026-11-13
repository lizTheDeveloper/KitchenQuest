// M7 Step 1 (P2, Ruling 16): speech text and sentence chunks for scripted lines, and a canon step read aloud.
import { describe, expect, test } from 'vitest';
import type { ParsedRecipe } from '../recipe/types';
import { stepPlainText } from '../recipe/steps';
import { speechChunks, speechText, stepSpeech } from './speech';

describe('speechText', () => {
  test('speechText speaks spelled letters one by one and drops footnote asterisks and emoji; other words are unchanged', () => {
    expect(speechText('P-E-A-N-U-T')).toBe('P. E. A. N. U. T.');
    expect(speechText('I heard peanut, P-E-A-N-U-T. Right?')).toBe('I heard peanut, P. E. A. N. U. T. Right?');
    expect(speechText('tree nut, T-R-E-E N-U-T')).toBe('tree nut, T. R. E. E. N. U. T.');
    expect(speechText('Checked against your rules* ✅')).toBe('Checked against your rules');
    expect(speechText('Nice one 👩🏽‍🍳🔥, keep going.')).toBe('Nice one, keep going.');
    expect(speechText('A well-known step-by-step stir-fry, not A-OK')).toBe('A well-known step-by-step stir-fry, not A-OK');
    expect(speechText('Half-and-half for 2 people.')).toBe('Half-and-half for 2 people.');
    expect(speechText('')).toBe('');
  });
});

describe('speechChunks', () => {
  test('speechChunks splits a long first sentence at its first comma; "" → []', () => {
    expect(speechChunks('')).toEqual([]);
    expect(speechChunks('   ')).toEqual([]);
    expect(speechChunks('Right then, chop the onions into thin half moons. Then fry them slowly.')).toEqual([
      'Right then,',
      'chop the onions into thin half moons.',
      'Then fry them slowly.',
    ]);
    // a short first sentence stays whole; later sentences never split at commas
    expect(speechChunks('Ah, leftover pad thai. Bold of you, frankly, to admit that in front of me!')).toEqual([
      'Ah, leftover pad thai.',
      'Bold of you, frankly, to admit that in front of me!',
    ]);
    // a long first sentence with no clause break stays whole
    expect(speechChunks('Chop the onions into thin half moons now. Done?')).toEqual(['Chop the onions into thin half moons now.', 'Done?']);
    // spelled letters never end a sentence
    expect(speechChunks('I heard peanut. P. E. A. N. U. T. Is that right?')).toEqual(['I heard peanut.', 'P. E. A. N. U. T.', 'Is that right?']);
    expect(speechChunks('No full stop at the end')).toEqual(['No full stop at the end']);
  });
});

const RECIPE: ParsedRecipe = {
  meta: { title: 'Parippu', country: 'India', region: 'Kerala', credit: 'x', cook: 'leela', difficulty: 1, skills: [], servings: 2, license: 'CC-BY-4.0', status: 'reviewed', sacred: false, contributors: [] },
  ingredients: [{ name: 'red lentil', displayName: 'lentils', quantity: 200, unit: 'g', note: null }],
  timers: [{ name: null, quantity: 20, unit: 'minutes' }],
  steps: [
    { section: null, items: [{ type: 'text', value: 'Rinse the ' }, { type: 'ingredient', index: 0 }, { type: 'text', value: '  twice.' }] },
    { section: null, items: [{ type: 'text', value: 'Simmer ' }, { type: 'timer', index: 0 }, { type: 'text', value: '.' }] },
  ],
  source: '',
};

describe('stepSpeech', () => {
  test("stepSpeech(recipe, 0) is the first step's plain text; step = length → null", () => {
    expect(RECIPE.steps.length).toBeGreaterThan(1);
    expect(stepSpeech(RECIPE, 0)).toBe(stepPlainText(RECIPE, RECIPE.steps[0]));
    expect(stepSpeech(RECIPE, RECIPE.steps.length - 1)).toBe(stepPlainText(RECIPE, RECIPE.steps[RECIPE.steps.length - 1]));
    for (const bad of [RECIPE.steps.length, -1, 0.5, Number.NaN]) expect(stepSpeech(RECIPE, bad), String(bad)).toBeNull();
  });
});
