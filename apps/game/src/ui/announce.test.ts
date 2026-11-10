// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { announce } from './announce';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test('announce clears the live region, then sets the message a moment later so a repeat is heard again', () => {
  const el = document.createElement('div');
  el.textContent = 'Timer finished: 20 minutes for step 2';
  announce(el, 'Timer finished: 20 minutes for step 2');
  expect(el.textContent).toBe('');
  vi.advanceTimersByTime(49);
  expect(el.textContent).toBe('');
  vi.advanceTimersByTime(1);
  expect(el.textContent).toBe('Timer finished: 20 minutes for step 2');
});

test('a newer message wins over one still waiting', () => {
  const el = document.createElement('div');
  announce(el, 'first');
  announce(el, 'second');
  vi.advanceTimersByTime(100);
  expect(el.textContent).toBe('second');
});

test('a missing region is ignored', () => {
  expect(() => announce(null, 'x')).not.toThrow();
});
