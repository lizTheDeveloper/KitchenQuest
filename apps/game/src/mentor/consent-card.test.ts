// @vitest-environment happy-dom
import { expect, test, vi } from 'vitest';
import { content } from '../content';
import { renderConsentCard } from './consent-card';

const forms = content.bureau.forms;
const button = (el: HTMLElement, name: string) => [...el.querySelectorAll('button')].find((b) => b.textContent === name)!;
const notice = { version: 'v1', text: 'We keep your rules <b>encrypted</b>.' };

test('the notice text verbatim in a [data-content] element, with the form number and buttons', () => {
  const el = renderConsentCard('ai_health', { form: forms.consent_ai, notice, onAgree: vi.fn(), onDecline: vi.fn() });
  expect(el.textContent).toContain('3-C/AI');
  const n = el.querySelector('.consent-notice')!;
  expect(n.hasAttribute('data-content')).toBe(true);
  expect(n.textContent).toBe(notice.text);
  expect(n.querySelector('b')).toBeNull();
  expect(button(el, 'I agree').type).toBe('button');
  expect(renderConsentCard('health_data', { form: forms.consent_health, notice, onAgree: vi.fn(), onDecline: vi.fn() }).textContent).toContain('3-C/HEALTH');
});

test('agree runs once while pending; decline calls onDecline', async () => {
  let done!: () => void;
  const onAgree = vi.fn(() => new Promise<void>((r) => { done = r; }));
  const el = renderConsentCard('ai_health', { form: forms.consent_ai, notice, onAgree, onDecline: vi.fn() });
  button(el, 'I agree').click();
  button(el, 'I agree').click();
  expect(onAgree).toHaveBeenCalledTimes(1);
  expect(button(el, 'Not now').disabled).toBe(true);
  done();
  await new Promise((r) => setTimeout(r, 0));
  expect(button(el, 'I agree').disabled).toBe(false);
  const onDecline = vi.fn();
  button(renderConsentCard('ai_health', { form: forms.consent_ai, notice, onAgree: vi.fn(), onDecline }), 'Not now').click();
  expect(onDecline).toHaveBeenCalledTimes(1);
});
