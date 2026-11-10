import { expect, test } from 'vitest';
import { spell } from './spell';

test('spells letters with hyphens, words with one space', () => {
  expect(spell('peanut')).toBe('P-E-A-N-U-T');
  expect(spell('tree nut')).toBe('T-R-E-E N-U-T');
  expect(spell('Doña')).toBe('D-O-Ñ-A');
});

test('drops characters that are not letters', () => {
  expect(spell('garlic-infused oil')).toBe('G-A-R-L-I-C-I-N-F-U-S-E-D O-I-L');
  expect(spell("  short-grain   rice's 2 ")).toBe('S-H-O-R-T-G-R-A-I-N R-I-C-E-S');
  expect(spell('Doña')).toBe('D-O-Ñ-A'); // decomposed ñ
  expect(spell('')).toBe('');
});
