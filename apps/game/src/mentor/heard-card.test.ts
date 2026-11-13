// @vitest-environment happy-dom
import { heardCheck } from '@kitchenquest/core/engine';
import { expect, test, vi } from 'vitest';
import { content, graph } from '../content';
import { HEARD_AGAIN, HEARD_TAP_ONLY, HEARD_TYPE, HEARD_YES, renderHeardCard, spokenSpelling } from './heard-card';

const button = (el: Element, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)!;

test('the spelling is shown with an aria-label spelling it; only the buttons confirm (a transcript "yes" does not)', () => {
  const check = heardCheck("I'm allergic to rice", graph, content.ruleTerms)!;
  const on = { yes: vi.fn(), again: vi.fn(), type: vi.fn() };
  const el = renderHeardCard(check, on);
  document.body.replaceChildren(el);
  // As heard, never corrected, and spelled by code; a screen reader hears it letter by letter.
  expect(el.querySelector('.heard-said')!.textContent).toBe('rice');
  const spelled = el.querySelector('.heard-spelled')!;
  expect(spelled.textContent).toBe('R-I-C-E');
  expect(spelled.getAttribute('aria-label')).toBe('spelled R, I, C, E');
  expect(spokenSpelling('P-I-N-E N-U-T')).toBe('P, I, N, E, then N, U, T');
  // Named, with the tap-only note (Ruling 12: heard cards are tap-only, and the UI says so).
  const section = el.closest('section')!;
  expect(document.getElementById(section.getAttribute('aria-labelledby')!)!.textContent).toBe('What I heard');
  expect(el.textContent).toContain(HEARD_TAP_ONLY);
  // Nothing on the card listens for words: no text box, no form, nothing but buttons.
  expect(el.querySelectorAll('input, textarea, form, [contenteditable]').length).toBe(0);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true }));
  expect(on.yes).not.toHaveBeenCalled();
  // Its alternatives are chips: choosing "rye" then the yes button confirms that choice, once.
  const rye = check.terms[0].alternatives.findIndex((a) => a.name === 'rye');
  const chip = button(el, 'rye');
  expect(chip.getAttribute('aria-label')).toBe('rye, spelled R, Y, E');
  chip.click();
  expect(chip.getAttribute('aria-pressed')).toBe('true');
  button(el, HEARD_YES).click();
  expect(on.yes).toHaveBeenCalledWith([rye]);
  // After a tap the card's buttons are spent: a second tap sends nothing more.
  button(el, HEARD_YES).click();
  expect(on.yes).toHaveBeenCalledTimes(1);
});

test('the words as heard: yes with no chip is [null]; a chip tapped twice is cleared; again and type are their own taps', () => {
  const check = heardCheck("I can't eat sesame", graph, content.ruleTerms)!;
  const a = { yes: vi.fn(), again: vi.fn(), type: vi.fn() };
  const el = renderHeardCard(check, a);
  const soy = button(el, 'soy');
  soy.click();
  soy.click();
  expect(soy.getAttribute('aria-pressed')).toBe('false');
  button(el, HEARD_YES).click();
  expect(a.yes).toHaveBeenCalledWith([null]);
  const b = { yes: vi.fn(), again: vi.fn(), type: vi.fn() };
  button(renderHeardCard(check, b), HEARD_AGAIN).click();
  expect(b.again).toHaveBeenCalledTimes(1);
  const c = { yes: vi.fn(), again: vi.fn(), type: vi.fn() };
  button(renderHeardCard(check, c), HEARD_TYPE).click();
  expect(c.type).toHaveBeenCalledTimes(1);
  expect(b.yes).not.toHaveBeenCalled();
  expect(c.yes).not.toHaveBeenCalled();
});
