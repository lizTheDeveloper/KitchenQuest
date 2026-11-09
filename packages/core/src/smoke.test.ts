import { it, expect } from 'vitest';
import { CORE_VERSION } from './index';

it('exports a version', () => {
  expect(CORE_VERSION).toBe('0.1.0');
});
