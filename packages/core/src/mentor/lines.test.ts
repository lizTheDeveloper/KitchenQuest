import { expect, test } from 'vitest';
import { fillLine, resolveTrigger } from './lines';

// The M3 cases for these two functions in apps/game/src/mentor/dialogue.test.ts, copied verbatim
// (that file's bank helper and content bank are replaced by small inline banks).
const bank6 = { triggers: { six: { ai: 'never', lines: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5'] } } };
const pan = { triggers: { 'reminder.hours_since_meal': { ai: 'allowed', lines: ['{hours} hours'] } } };

test('fillLine and resolveTrigger behave as the M3 dialogue tests pin', () => {
  expect(resolveTrigger(pan, 'reminder.hours_since_meal.h7')).toBe('reminder.hours_since_meal');
  expect(resolveTrigger(bank6, 'nope')).toBeNull();
  expect(fillLine('{n} left', { n: 0 })).toBe('0 left');
  expect(fillLine('a {x} b', {})).toBeNull();
});

test.each([['undefined', undefined], ['null', null], ['empty string', '']])('a %s var counts as missing', (_n, v) => {
  expect(fillLine('Hi {name}.', { name: v })).toBeNull();
});

test('fills every var, numbers stringified', () => {
  expect(fillLine('{dish} in {n} min, {dish}!', { dish: 'Parippu', n: 20 })).toBe('Parippu in 20 min, Parippu!');
  expect(fillLine('no vars', {})).toBe('no vars');
  expect(resolveTrigger(bank6, 'six')).toBe('six');
  expect(resolveTrigger(bank6, 'six.a.b')).toBe('six');
  // Prototype keys are not triggers.
  expect(resolveTrigger(bank6, 'toString')).toBeNull();
});
