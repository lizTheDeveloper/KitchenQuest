import { describe, expect, test } from 'vitest';
import type { Rule } from '@kitchenquest/core/engine';
import { graph } from '../content';
import { activeRules } from '../recipes/rules';
import { createStore, type PlayerState } from '../state/store';
import { refreshAccount, signOut, watchAccount } from './account';
import type { ApiClient } from './client';
import type { ApiResult } from './types';

const coconut: Rule = { id: 'a1', target: { kind: 'ingredient', ids: ['coconut'] }, type: 'avoid', severity: 'anaphylactic' };
const ok = <T>(data: T, status = 200): ApiResult<T> => ({ ok: true, status, data });
const fail = (status: number, code = status === 0 ? 'network' : `http_${status}`): ApiResult<never> =>
  ({ ok: false, status, error: { code, message: '' } });

type Script = Partial<Record<'me' | 'listRules' | 'logout', () => Promise<ApiResult<unknown>>>>;
function fakeClient(script: Script) {
  const calls: string[] = [];
  const handler = (name: string) => () => {
    calls.push(name);
    const f = script[name as keyof Script];
    return f ? f() : Promise.reject(new Error(`unexpected call: ${name}`));
  };
  const client = new Proxy({}, { get: (_t, name: string) => handler(name) }) as ApiClient;
  return { client, calls };
}

const me = (email = 'cook@example.com') => () => Promise.resolve(ok({ id: 'u1', email, entitlements: [] }));
const rules = (list: unknown) => () => Promise.resolve(ok({ rules: list }));
const status = (s: number) => () => Promise.resolve(fail(s));
const storeWith = (patch: Partial<PlayerState> = {}) => {
  const s = createStore(null);
  s.update((x) => ({ ...x, ...patch }));
  return s;
};

describe('refreshAccount', () => {
  test('signed in loads account rules', async () => {
    const store = storeWith();
    const { client, calls } = fakeClient({ me: me(), listRules: rules([coconut]) });
    expect(await refreshAccount(client, store)).toBe('signed-in');
    expect(calls).toEqual(['me', 'listRules']);
    expect(store.get().account).toEqual({ email: 'cook@example.com' });
    expect(store.get().accountRules).toEqual([coconut]);
    expect(activeRules(store.get(), graph)).toEqual({ status: 'ready', rules: [coconut], source: 'account' });
  });

  test('401 clears account and account rules', async () => {
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
    const { client, calls } = fakeClient({ me: status(401) });
    expect(await refreshAccount(client, store)).toBe('signed-out');
    expect(calls).toEqual(['me']);
    expect(store.get().account).toBeNull();
    expect(store.get().accountRules).toBeNull();
  });

  test('offline keeps cached account rules', async () => {
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
    const { client } = fakeClient({ me: status(0) });
    expect(await refreshAccount(client, store)).toBe('offline');
    expect(store.get().account).toEqual({ email: 'cook@example.com' });
    expect(store.get().accountRules).toEqual([coconut]);
  });

  test('rules the server failed to send (5xx) are not loaded: fail closed, never the stale cache', async () => {
    for (const st of [500, 503]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [] });
      const { client } = fakeClient({ me: me(), listRules: status(st) });
      expect(await refreshAccount(client, store)).toBe('signed-in');
      expect(store.get().accountRules).toBeNull();
      expect(activeRules(store.get(), graph).status).toBe('error');
    }
  });

  test('any other non-401 rules failure (403, a non-JSON 200) also fails closed', async () => {
    const badResponse = () => Promise.resolve<ApiResult<never>>({ ok: false, status: 200, error: { code: 'bad_response', message: '' } });
    for (const listRules of [status(403), status(404), badResponse]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
      const { client } = fakeClient({ me: me(), listRules });
      await refreshAccount(client, store);
      expect(store.get().accountRules).toBeNull();
      expect(activeRules(store.get(), graph).status).toBe('error');
    }
  });

  test('rules offline (status 0) or rate-limited (429) keep the cached copy', async () => {
    for (const st of [0, 429]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
      const { client } = fakeClient({ me: me(), listRules: status(st) });
      expect(await refreshAccount(client, store)).toBe('signed-in');
      expect(store.get().accountRules).toEqual([coconut]);
    }
  });

  test('signed in but rules never loaded: checks fail closed, never "no rules"', async () => {
    const store = storeWith({ localRules: [] });
    const { client } = fakeClient({ me: me(), listRules: status(0) });
    expect(await refreshAccount(client, store)).toBe('signed-in');
    expect(store.get().accountRules).toBeNull();
    expect(activeRules(store.get(), graph).status).toBe('error');
  });

  test('a rules response that is not a list of rules is unreadable: error, not ready', async () => {
    for (const bad of [null, 'x', [1], { a: 1 }]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
      const { client } = fakeClient({ me: me(), listRules: rules(bad) });
      await refreshAccount(client, store);
      expect(store.get().accountRules).toBeNull();
      expect(activeRules(store.get(), graph).status).toBe('error');
    }
  });

  test('rules 401 (session gone mid-way) signs out', async () => {
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
    const { client } = fakeClient({ me: me(), listRules: status(401) });
    expect(await refreshAccount(client, store)).toBe('signed-out');
    expect(store.get().account).toBeNull();
    expect(store.get().accountRules).toBeNull();
  });

  test('a different account never sees the previous account\'s cached rules', async () => {
    const store = storeWith({ account: { email: 'old@example.com' }, accountRules: [coconut] });
    const { client } = fakeClient({ me: me('new@example.com'), listRules: status(503) });
    await refreshAccount(client, store);
    expect(store.get().account).toEqual({ email: 'new@example.com' });
    expect(store.get().accountRules).toBeNull();
    expect(activeRules(store.get(), graph).status).toBe('error');
  });

  test('/me offline (status 0) or rate-limited (429) changes nothing', async () => {
    for (const st of [0, 429]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
      const { client, calls } = fakeClient({ me: status(st) });
      expect(await refreshAccount(client, store)).toBe('offline');
      expect(calls).toEqual(['me']);
      expect(store.get().account).toEqual({ email: 'cook@example.com' });
      expect(store.get().accountRules).toEqual([coconut]);
    }
  });

  test('/me 5xx, other 4xx or an unreadable answer: the cached rules may be stale, so they are dropped (fail closed)', async () => {
    const badResponse = () => Promise.resolve<ApiResult<never>>({ ok: false, status: 200, error: { code: 'bad_response', message: '' } });
    const noEmail = () => Promise.resolve(ok({ id: 'u1' }));
    for (const meAnswer of [status(500), status(502), status(403), badResponse, noEmail]) {
      const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
      const { client, calls } = fakeClient({ me: meAnswer });
      expect(await refreshAccount(client, store)).toBe('offline');
      expect(calls).toEqual(['me']);
      expect(store.get().account).toEqual({ email: 'cook@example.com' });
      expect(store.get().accountRules).toBeNull();
      expect(activeRules(store.get(), graph).status).toBe('error');
    }
  });

  test('/me 5xx while signed out leaves the device signed out', async () => {
    const store = storeWith({ localRules: [] });
    const { client } = fakeClient({ me: status(500) });
    await refreshAccount(client, store);
    expect(store.get().account).toBeNull();
    expect(activeRules(store.get(), graph)).toEqual({ status: 'ready', rules: [], source: 'device' });
  });

  test('invalid account rules make activeRules an error', async () => {
    const store = storeWith({ localRules: [] });
    const unknownId: Rule = { ...coconut, target: { kind: 'ingredient', ids: ['no_such_ingredient'] } };
    const { client } = fakeClient({ me: me(), listRules: rules([unknownId]) });
    await refreshAccount(client, store);
    const s = activeRules(store.get(), graph);
    expect(s.status).toBe('error');
  });

  test('device rules are never touched, and account rules never copied into them', async () => {
    const device: Rule = { ...coconut, id: 'd1', severity: 'preference' };
    const store = storeWith({ localRules: [device] });
    const { client } = fakeClient({ me: me(), listRules: rules([coconut]) });
    await refreshAccount(client, store);
    expect(store.get().localRules).toEqual([device]);
  });
});

describe('signOut', () => {
  test('signOut clears even when logout fails offline', async () => {
    const device: Rule = { ...coconut, id: 'd1' };
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut], localRules: [device] });
    const { client } = fakeClient({ logout: status(0) });
    await signOut(client, store);
    expect(store.get().account).toBeNull();
    expect(store.get().accountRules).toBeNull();
    expect(store.get().localRules).toEqual([device]);
    expect(activeRules(store.get(), graph)).toEqual({ status: 'ready', rules: [device], source: 'device' });
  });

  test('a sign-out that never reached the server is finished before /me is asked again', async () => {
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
    await signOut(fakeClient({ logout: status(0) }).client, store);
    expect(store.get().signOutPending).toBe(true);
    // Still offline: nothing is asked, so the old session cannot sign the device back in.
    const offline = fakeClient({ logout: status(0) });
    expect(await refreshAccount(offline.client, store)).toBe('offline');
    expect(offline.calls).toEqual(['logout']);
    const back = fakeClient({ logout: () => Promise.resolve(ok(null, 204)) });
    expect(await refreshAccount(back.client, store)).toBe('signed-out');
    expect(back.calls).toEqual(['logout']);
    expect(store.get().signOutPending).toBe(false);
    expect(store.get().account).toBeNull();
  });

  test('a successful sign-out leaves nothing pending', async () => {
    const store = storeWith({ account: { email: 'cook@example.com' }, accountRules: [coconut] });
    await signOut(fakeClient({ logout: () => Promise.resolve(ok(null, 204)) }).client, store);
    expect(store.get().signOutPending).toBe(false);
  });

  test('a refresh in flight when the player signs out cannot sign them back in', async () => {
    const store = storeWith();
    let answerMe!: (r: ApiResult<unknown>) => void;
    const { client } = fakeClient({
      me: () => new Promise((res) => { answerMe = res; }),
      listRules: rules([coconut]),
      logout: () => Promise.resolve(ok(null, 204)),
    });
    const pending = refreshAccount(client, store);
    await Promise.resolve();
    await signOut(client, store);
    answerMe(ok({ id: 'u1', email: 'cook@example.com', entitlements: [] }));
    await pending;
    expect(store.get().account).toBeNull();
    expect(store.get().accountRules).toBeNull();
  });
});

describe('watchAccount', () => {
  test('refreshes on start, on online, and when the page becomes visible again (not when hidden)', async () => {
    const store = storeWith();
    const { client, calls } = fakeClient({ me: status(401) });
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    watchAccount(client, store, win as unknown as Window, doc as unknown as Document);
    await Promise.resolve();
    expect(calls).toEqual(['me']);
    win.dispatchEvent(new Event('online'));
    expect(calls).toEqual(['me', 'me']);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toEqual(['me', 'me']);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(calls).toEqual(['me', 'me', 'me']);
  });
});
