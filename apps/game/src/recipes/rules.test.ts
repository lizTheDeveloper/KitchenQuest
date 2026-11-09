import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Rule } from '@kitchenquest/core/engine';
import { graph } from '../content';
import { createStore, type PlayerState } from '../state/store';
import { activeRules, localDate, watchLocalDate } from './rules';

// vi.stubEnv sets process.env.TZ, which Node honours at runtime; unstubAllEnvs restores it.
afterEach(() => { vi.unstubAllEnvs(); });

const player = (patch: Partial<PlayerState> = {}): PlayerState => ({ ...createStore(null).get(), ...patch });
const rule = (id: string, ids: string[], extra: Partial<Rule> = {}): Rule =>
  ({ id, target: { kind: 'ingredient', ids }, type: 'avoid', severity: 'allergy', ...extra });

describe('localDate', () => {
  test('localDate uses the local calendar date', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    expect(localDate(new Date('2026-03-02T07:30:00Z'))).toBe('2026-03-01'); // 23:30 local on 1 March
  });

  test('ahead of UTC it is already tomorrow', () => {
    vi.stubEnv('TZ', 'Pacific/Auckland');
    expect(localDate(new Date('2026-11-09T12:30:00Z'))).toBe('2026-11-10');
  });

  test('pads month and day', () => {
    vi.stubEnv('TZ', 'UTC');
    expect(localDate(new Date('2026-01-05T00:00:00Z'))).toBe('2026-01-05');
  });
});

describe('activeRules', () => {
  test('no rules anywhere: ready, empty, from the device', () => {
    expect(activeRules(player(), graph)).toEqual({ status: 'ready', rules: [], source: 'device' });
  });

  test('account rules win over device rules when present', () => {
    const local = [rule('d1', ['coconut'])];
    const account = [rule('a1', ['ghee'])];
    expect(activeRules(player({ localRules: local, accountRules: account }), graph))
      .toEqual({ status: 'ready', rules: account, source: 'account' });
    // An empty account list is still the account's answer.
    expect(activeRules(player({ localRules: local, accountRules: [] }), graph))
      .toEqual({ status: 'ready', rules: [], source: 'account' });
    expect(activeRules(player({ localRules: local, accountRules: null }), graph))
      .toEqual({ status: 'ready', rules: local, source: 'device' });
  });

  test('rules core rejects → error state', () => {
    const s = activeRules(player({ localRules: [rule('r1', ['not_an_id'])] }), graph);
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.message).toContain('not_an_id');
  });

  test('bad account rules are an error too, even when device rules are fine', () => {
    const s = activeRules(player({ localRules: [rule('d1', ['coconut'])], accountRules: [rule('a1', ['nope_id'])] }), graph);
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.message).toContain('nope_id');
  });

  test('unreadable saved rules are an error, never ready', () => {
    const s = activeRules(player({ rulesUnreadable: true }), graph);
    expect(s.status).toBe('error');
    // Even with rules on file: some may have been lost or may conflict.
    expect(activeRules(player({ rulesUnreadable: true, localRules: [rule('d1', ['coconut'])] }), graph).status).toBe('error');
  });
});

describe('watchLocalDate', () => {
  afterEach(() => { vi.useRealTimers(); });
  const fakeDoc = () => {
    const ls = new Set<() => void>();
    return {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_t: string, fn: () => void) => { ls.add(fn); },
      removeEventListener: (_t: string, fn: () => void) => { ls.delete(fn); },
      fire() { for (const fn of [...ls]) fn(); },
      count: () => ls.size,
    };
  };

  test('redraws within a minute of local midnight, once', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 23, 59, 30)); // local time
    const doc = fakeDoc();
    const seen: string[] = [];
    const stop = watchLocalDate(doc as unknown as Document, () => new Date(), (d) => seen.push(d));
    vi.advanceTimersByTime(20_000);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(seen).toEqual(['2026-11-10']);
    vi.advanceTimersByTime(5 * 60_000);
    expect(seen).toEqual(['2026-11-10']);
    stop();
    expect(doc.count()).toBe(0);
  });

  test('does nothing while hidden; checks on becoming visible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 23, 0, 0));
    const doc = fakeDoc();
    const seen: string[] = [];
    watchLocalDate(doc as unknown as Document, () => new Date(), (d) => seen.push(d));
    doc.visibilityState = 'hidden';
    vi.advanceTimersByTime(3 * 3600_000);
    expect(seen).toEqual([]);
    doc.visibilityState = 'visible';
    doc.fire();
    expect(seen).toEqual(['2026-11-10']);
  });

  test('stops after the returned function is called', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 9, 23, 59, 59));
    const seen: string[] = [];
    const stop = watchLocalDate(fakeDoc() as unknown as Document, () => new Date(), (d) => seen.push(d));
    stop();
    vi.advanceTimersByTime(5 * 60_000);
    expect(seen).toEqual([]);
  });
});
