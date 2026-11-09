import { describe, expect, it } from 'vitest';
import { reducedMotion } from './motion';

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
