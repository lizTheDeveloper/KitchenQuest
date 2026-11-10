import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Rule } from '@kitchenquest/core/engine';
import { graph } from '../content';
import { createStore, type PlayerState } from '../state/store';
import {
  ACCOUNT_NOT_LOADED_MESSAGE, activeRules, cardInputsKey, localDate, RULES_INVALID_MESSAGE, RULES_UNREADABLE_MESSAGE, rulesStateForApiError, watchLocalDate,
} from './rules';

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

  test('signed in, account rules replace device rules', () => {
    const local = [rule('d1', ['coconut'])];
    const account = [rule('a1', ['ghee'])];
    const signedIn = { account: { email: 'cook@example.com' } };
    expect(activeRules(player({ ...signedIn, localRules: local, accountRules: account }), graph))
      .toEqual({ status: 'ready', rules: account, source: 'account' });
    // An empty account list is still the account's answer.
    expect(activeRules(player({ ...signedIn, localRules: local, accountRules: [] }), graph))
      .toEqual({ status: 'ready', rules: [], source: 'account' });
    expect(activeRules(player({ localRules: local, accountRules: null }), graph))
      .toEqual({ status: 'ready', rules: local, source: 'device' });
  });

  test('signed in but the account rules have not loaded: error, never the device rules or "none"', () => {
    const s = activeRules(player({ account: { email: 'cook@example.com' }, accountRules: null, localRules: [] }), graph);
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.message).toMatch(/account/i);
  });

  test('signed out: leftover account rules are not used', () => {
    const local = [rule('d1', ['coconut'])];
    expect(activeRules(player({ account: null, accountRules: [rule('a1', ['ghee'])], localRules: local }), graph))
      .toEqual({ status: 'ready', rules: local, source: 'device' });
  });

  test('signed in with loaded account rules, unreadable device data does not force an error', () => {
    const account = [rule('a1', ['ghee'])];
    expect(activeRules(player({ account: { email: 'cook@example.com' }, accountRules: account, rulesUnreadable: true }), graph))
      .toEqual({ status: 'ready', rules: account, source: 'account' });
    // ...but with the account rules not loaded it is still an error.
    expect(activeRules(player({ account: { email: 'cook@example.com' }, accountRules: null, rulesUnreadable: true }), graph).status).toBe('error');
  });

  test('rules core rejects → error state', () => {
    const s = activeRules(player({ localRules: [rule('r1', ['not_an_id'])] }), graph);
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.problems.join(' ')).toContain('not_an_id');
  });

  test("invalid rules give the player message, never core's text", () => {
    const s = activeRules(player({ localRules: [rule('r1', ['not_an_id'])] }), graph);
    expect(s).toMatchObject({ status: 'error', reason: 'invalid', message: RULES_INVALID_MESSAGE });
    if (s.status === 'error') {
      expect(s.message).not.toContain('not_an_id');
      expect(s.problems.some((p) => p.includes('not_an_id'))).toBe(true);
    }
    expect(RULES_INVALID_MESSAGE).toBe("One of your saved rules names something the Bureau's ingredient ledger no longer knows, so I can't check dishes against it. Open Your rules to fix it.");
  });

  test('unreadable device rules give the player message', () => {
    const s = activeRules(player({ rulesUnreadable: true }), graph);
    expect(s).toEqual({ status: 'error', reason: 'unreadable', message: RULES_UNREADABLE_MESSAGE, problems: [] });
    expect(RULES_UNREADABLE_MESSAGE).toBe("Some of the rules saved on this device couldn't be read, so I can't be sure what to check for. Open Your rules to look them over and confirm them.");
  });

  test('signed in with accountRules null → account_not_loaded, ACCOUNT_NOT_LOADED_MESSAGE', () => {
    const s = activeRules(player({ account: { email: 'c@e.com' }, accountRules: null }), graph);
    expect(s).toEqual({ status: 'error', reason: 'account_not_loaded', message: ACCOUNT_NOT_LOADED_MESSAGE, problems: [] });
    expect(ACCOUNT_NOT_LOADED_MESSAGE).toBe("Your account's rules couldn't be loaded, so dishes can't be checked. Try again in a moment.");
  });

  test('API 409 rules_need_review reads as the invalid message', () => {
    expect(rulesStateForApiError({ code: 'rules_need_review', message: 'Some of your saved rules need review.' }, 409))
      .toEqual({ status: 'error', reason: 'invalid', message: RULES_INVALID_MESSAGE, problems: ['Some of your saved rules need review.'] });
    expect(rulesStateForApiError({ code: 'network', message: 'x' }, 0)).toBeNull();
  });

  test('bad account rules are an error too, even when device rules are fine', () => {
    const s = activeRules(player({ account: { email: 'c@e.com' }, localRules: [rule('d1', ['coconut'])], accountRules: [rule('a1', ['nope_id'])] }), graph);
    expect(s.status).toBe('error');
    if (s.status === 'error') expect(s.problems.join(' ')).toContain('nope_id');
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

describe('cardInputsKey', () => {
  test('changes when the player signs in or out', () => {
    const out = player();
    expect(cardInputsKey(player({ account: { email: 'c@e.com' } }))).not.toBe(cardInputsKey(out));
  });
});
