import { describe, expect, it } from 'vitest';
import { isReducedMotion, reducedMotion } from './motion';

describe('reducedMotion', () => {
  it('on and off ignore the media query', () => {
    expect(reducedMotion('on', { matches: false })).toBe(true);
    expect(reducedMotion('off', { matches: true })).toBe(false);
  });
  it('system follows the media query', () => {
    expect(reducedMotion('system', { matches: true })).toBe(true);
    expect(reducedMotion('system', { matches: false })).toBe(false);
  });
});

describe('isReducedMotion', () => {
  const win = (matches: boolean) => ({ matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' && matches }) }) as unknown as Window;
  const store = (reducedMotion: 'system' | 'on' | 'off') => ({ get: () => ({ settings: { reducedMotion } }) }) as never;
  it('reads the setting and the media query', () => {
    expect(isReducedMotion(store('system'), win(true))).toBe(true);
    expect(isReducedMotion(store('system'), win(false))).toBe(false);
    expect(isReducedMotion(store('on'), win(false))).toBe(true);
    expect(isReducedMotion(store('off'), win(true))).toBe(false);
  });
});
