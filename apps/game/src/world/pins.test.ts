import { describe, expect, test } from 'vitest';
import { content } from '../content';
import { MAP_PINS } from './pins';

describe('MAP_PINS', () => {
  test('every cook in the compiled content has a pin', () => {
    const ids = Object.keys(content.cooks);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(Object.hasOwn(MAP_PINS, id), id).toBe(true);
  });

  test('every pin lies on the map, in percent', () => {
    for (const [id, { x, y }] of Object.entries(MAP_PINS)) {
      expect(x, `${id}.x`).toBeGreaterThanOrEqual(0);
      expect(x, `${id}.x`).toBeLessThanOrEqual(100);
      expect(y, `${id}.y`).toBeGreaterThanOrEqual(0);
      expect(y, `${id}.y`).toBeLessThanOrEqual(100);
    }
  });
});
