import { describe, expect, it } from 'vitest';
import { clampToBounds } from './movement';

describe('clampToBounds', () => {
  const bounds = { width: 100, height: 50 };

  it('leaves points inside the bounds untouched', () => {
    expect(clampToBounds({ x: 40, y: 20 }, bounds, 5)).toEqual({ x: 40, y: 20 });
  });

  it('clamps points outside the bounds to the inset edge', () => {
    expect(clampToBounds({ x: -10, y: 80 }, bounds, 5)).toEqual({ x: 5, y: 45 });
  });
});
