// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { findingItem, LABEL_RULE_TEXT, RECIPE_LEVEL_TEXT } from './card-view';

test('a recipe-level finding (ingredient "") is a reminder about the whole dish, never a blank row', () => {
  const li = findingItem({ ingredient: '', kind: 'label', fromRule: true, status: 'unverified', path: null, ruleNote: null, swapLabel: null });
  expect(li.querySelector('strong')!.textContent).toBe('The whole dish');
  expect(li.textContent).toContain(RECIPE_LEVEL_TEXT);
  expect(li.classList.contains('finding-recipe')).toBe(true);
});

test('an ingredient finding names its ingredient', () => {
  const li = findingItem({ ingredient: 'dried apricot', kind: 'label', fromRule: true, status: 'unverified', path: null, ruleNote: null, swapLabel: null });
  expect(li.querySelector('strong')!.textContent).toBe('dried apricot');
  expect(li.textContent).toContain(LABEL_RULE_TEXT);
});
