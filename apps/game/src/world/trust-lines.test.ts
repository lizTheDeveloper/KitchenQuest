import { describe, expect, test } from 'vitest';
import { content } from '../content';
import { trustLine } from './trust-lines';

describe('trust lines', () => {
  test('trust lines: level 2 shows a trust_lines[2] line on return; level 0 never shows return lines', () => {
    for (const cook of Object.values(content.cooks)) {
      for (let i = 0; i < 10; i++) expect(cook.trust_lines['2']).toContain(trustLine(cook.trust_lines, 2));
      expect(trustLine(cook.trust_lines, 0)).toBeNull();
      expect(cook.trust_lines['1']).toContain(trustLine(cook.trust_lines, 1));
    }
  });
  test('a level above the highest written one uses the highest', () => {
    expect(trustLine({ '1': ['a'], '2': ['b'] }, 5)).toBe('b');
    expect(trustLine({}, 3)).toBeNull();
  });
});
