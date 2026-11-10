import type { Rule } from '@kitchenquest/core/engine';
import type { PlayerStore } from '../state/store';
import type { ApiClient } from './client';
import type { ApiResult } from './types';

/**
 * Bumped by every sign-out, per store. A refresh that started before a sign-out drops its answers, so a
 * `/me` reply already on its way can't sign the player back in.
 */
const epochs = new WeakMap<PlayerStore, number>();
const epoch = (store: PlayerStore) => epochs.get(store) ?? 0;

const isRuleList = (x: unknown): x is Rule[] =>
  Array.isArray(x) && x.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r));

/** Only "couldn't reach the server" (status 0) and "slow down" (429) keep cached account rules. */
const keepsCache = (r: ApiResult<unknown>) => !r.ok && (r.status === 0 || r.status === 429);

const dropAccountRules = (store: PlayerStore) => store.update((s) => (s.accountRules === null ? s : { ...s, accountRules: null }));

const clearAccount = (store: PlayerStore) => store.update((s) => ({ ...s, account: null, accountRules: null }));

/**
 * Ask the API who is signed in and load their rules. Runs on app start and on `online` events.
 *
 * Account rules are cached on the device (N-3: the minimum, the email and the rules) so dishes are still
 * checked offline (§9); a sign-out or a 401 removes them. The cache is kept only while the API is
 * unreachable (status 0) or rate-limiting (429); any other failure of /me or /rules drops it (fail closed).
 * It runs on app start, on `online`, and when the app becomes visible again. Whatever is stored is validated by `activeRules`,
 * so rules that can't be read show ❓, never ✅. Signed in with no rules loaded is an error too.
 */
export async function refreshAccount(client: ApiClient, store: PlayerStore): Promise<'signed-in' | 'signed-out' | 'offline'> {
  if (store.get().signOutPending) {
    // Finish the sign-out first; until the server has heard it, /me isn't asked.
    const out = await client.logout();
    if (out.ok) store.update((s) => ({ ...s, signOutPending: false }));
    return out.status === 0 ? 'offline' : 'signed-out';
  }
  const started = epoch(store);
  const stale = () => epoch(store) !== started;

  const me = await client.me();
  if (stale()) return 'signed-out';
  if (!me.ok && me.status === 401) { clearAccount(store); return 'signed-out'; }
  const email = me.ok ? (me.data as { email?: unknown } | null)?.email : undefined;
  if (typeof email !== 'string') {
    // Offline or rate-limited: nothing is known to have changed, so the cached copy stays (§9 offline play).
    // Anything else (5xx, another 4xx, an answer we can't read) means the server is up but couldn't confirm
    // the session or its rules: the cached rules may be stale, so drop them and fail closed (❓).
    if (!keepsCache(me)) dropAccountRules(store);
    return 'offline';
  }
  // Another account's cached rules are never used for this one.
  store.update((s) => ({ ...s, account: { email }, accountRules: s.account?.email === email ? s.accountRules : null }));

  const list = await client.listRules();
  if (stale()) return 'signed-out';
  if (list.ok) {
    const rules = (list.data as { rules?: unknown } | null)?.rules;
    // A reply we can't read as rules leaves none loaded: checks fail closed.
    store.update((s) => ({ ...s, accountRules: isRuleList(rules) ? rules : null }));
  } else if (list.status === 401) {
    clearAccount(store);
    return 'signed-out';
  } else if (!keepsCache(list)) {
    // A 5xx (e.g. a stored rule M2 couldn't open), another 4xx or a non-JSON 200: the rules couldn't be
    // fetched, so checks fail closed rather than trust a copy that may be missing a rule.
    dropAccountRules(store);
  } // offline or 429: keep the cached copy (or none, which is an error state too)
  return 'signed-in';
}

/**
 * Sign out on this device. The account and its rules are removed first, so nothing waits on the network;
 * when the logout call can't reach the server, the sign-out is finished by the next `refreshAccount`.
 * Device rules are untouched, and account rules are never copied into them.
 */
export async function signOut(client: ApiClient, store: PlayerStore): Promise<void> {
  epochs.set(store, epoch(store) + 1);
  store.update((s) => ({ ...s, account: null, accountRules: null, signOutPending: true }));
  const out = await client.logout();
  if (out.ok) store.update((s) => ({ ...s, signOutPending: false }));
}

/**
 * Keep the account fresh: refresh now, whenever the connection comes back, and whenever the app becomes
 * visible again (a phone unlocked hours later must not keep checking against rules it can't confirm).
 */
export function watchAccount(client: ApiClient, store: PlayerStore, win: Window, doc: Document): void {
  const refresh = () => { void refreshAccount(client, store); };
  refresh();
  win.addEventListener('online', refresh);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') refresh(); });
}
