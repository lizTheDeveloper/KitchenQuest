import { describe, expect, test } from 'vitest';
import { STALL_IDS } from '@kitchenquest/core/engine';
import { KEEPER_STALLS } from '../shell/router';
import { navRoute } from './nav';

describe('navigation chips (M6 Step 9: the market hub and its stalls now have screens)', () => {
  test('stalls → #/stalls; stall → that keeper\'s stall, the id checked against the closed set', () => {
    expect(navRoute({ to: 'stalls' })).toEqual({ name: 'stalls' });
    expect(navRoute({ to: 'stall', stall: 'okafor-sato' })).toEqual({ name: 'stall', id: 'okafor-sato' });
    for (const stall of ['general', 'fishmonger', 'wen/x', '__proto__', 7, undefined]) expect(navRoute({ to: 'stall', stall }), String(stall)).toBeNull();
  });
  test('the router\'s closed stall set is core\'s, without the General Counter', () => {
    expect([...KEEPER_STALLS]).toEqual(STALL_IDS.filter((s) => s !== 'general'));
  });
});
