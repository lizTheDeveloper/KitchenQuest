import { describe, expect, test } from 'vitest';
import { content, graph } from '../content';
import { createStore } from '../state/store';
import { loadMarket } from './content';
import { marketCtxFor, noteForHub, profileFor, seasonFor, takeHubNote } from './stall-context';

const subs = [...content.substitutions];

describe('the market context (M6 Step 9)', () => {
  test('rules null → no context (market.stall_wait); otherwise the date and the profile country as written', () => {
    expect(marketCtxFor(null, { country: 'USA', region: null }, '2026-11-12', graph, subs)).toBeNull();
    expect(marketCtxFor([], { country: 'USA', region: 'Seattle' }, '2026-11-12', graph, subs)).toMatchObject({ rules: [], date: '2026-11-12', country: 'USA' });
  });

  test('seasonFor: no region / an unmatched region → null; pnw-usa in November', async () => {
    const { seasonality } = await loadMarket();
    expect(seasonFor({ country: null, region: null }, seasonality, '2026-11-12')).toEqual({ regionId: null, month: 11 });
    expect(seasonFor({ country: 'India', region: 'Kerala' }, seasonality, '2026-11-12')).toEqual({ regionId: null, month: 11 });
    expect(seasonFor({ country: 'United States', region: 'Seattle, Washington' }, seasonality, '2026-11-12')).toEqual({ regionId: 'pnw-usa', month: 11 });
    expect(() => seasonFor({ country: null, region: null }, seasonality, 'soon')).toThrow();
  });

  test('profileFor: the device profile signed out (no call); GET /profile signed in; an unreadable profile is no country and no region', async () => {
    const store = createStore(null);
    let calls = 0;
    const client = (ok: boolean) => ({ getProfile: () => { calls += 1; return Promise.resolve(ok ? { ok: true as const, status: 200, data: { marketDays: [], mealsPerWeek: null, country: 'Canada', region: 'BC', mealWindows: [] } } : { ok: false as const, status: 0, error: { code: 'network', message: '' } }); } });
    expect(await profileFor(store.get(), client(true))).toEqual({ country: null, region: null });
    store.update((s) => ({ ...s, localProfile: { marketDays: [], mealsPerWeek: null, country: 'Japan', region: 'Osaka', mealWindows: [] } }));
    expect(await profileFor(store.get(), client(true))).toEqual({ country: 'Japan', region: 'Osaka' });
    expect(calls).toBe(0);
    store.update((s) => ({ ...s, account: { email: 'a@example.com' } }));
    expect(await profileFor(store.get(), client(true))).toEqual({ country: 'Canada', region: 'BC' });
    expect(await profileFor(store.get(), client(false))).toEqual({ country: null, region: null });
  });

  test('the hub note is said once', () => {
    noteForHub('x');
    expect(takeHubNote()).toBe('x');
    expect(takeHubNote()).toBeNull();
  });
});
