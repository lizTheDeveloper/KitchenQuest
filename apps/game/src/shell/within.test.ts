import { afterEach, expect, test, vi } from 'vitest';
import { LOOKUP_TIMEOUT_MS, within } from './within';

afterEach(() => { vi.useRealTimers(); });

test('within: the answer when it comes in time, the fallback on a hang (at 3 s at most) or a rejection', async () => {
  expect(LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  expect(await within(Promise.resolve(1), 10, 0)).toBe(1);
  expect(await within(Promise.reject(new Error('x')), 10, 0)).toBe(0);
  vi.useFakeTimers();
  const hung = within(new Promise<number>(() => {}), LOOKUP_TIMEOUT_MS, -1);
  await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS);
  expect(await hung).toBe(-1);
});
