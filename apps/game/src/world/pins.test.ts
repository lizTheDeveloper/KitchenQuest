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

describe('pin states (Ruling 3)', () => {
  test('map: unintroduced cook → "Awaiting an introduction" (travel anyway); introduced → "expecting you"; no locked pin', async () => {
    const { introduced } = await import('../progress/announce');
    const { pinState, PIN_STATE_TEXT } = await import('./pins');
    const fresh = introduced({});
    expect(pinState('leela', fresh)).toBe('expecting');
    expect(pinState('marisol', fresh)).toBe('awaiting');
    expect(PIN_STATE_TEXT.awaiting).toBe('Awaiting an introduction');
    expect(PIN_STATE_TEXT.expecting).toBe('Expecting you');
    // Leela's trust reaches 3: her letter introduces Marisol.
    expect(pinState('marisol', introduced({ leela: 3 }))).toBe('expecting');
    // Only two states, neither a lock.
    expect(Object.keys(PIN_STATE_TEXT).sort()).toEqual(['awaiting', 'expecting']);
    expect(Object.values(PIN_STATE_TEXT).join(' ')).not.toMatch(/lock|unlock/i);
  });
});
