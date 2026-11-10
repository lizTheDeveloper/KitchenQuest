import type { Rule } from '@kitchenquest/core/engine';
import type { PlayerStore } from '../state/store';
import type { ApiClient } from './client';

/**
 * Bumped by every sign-out, per store. A refresh that started before a sign-out drops its answers, so a
 * `/me` reply already on its way can't sign the player back in.
 */
const epochs = new WeakMap<PlayerStore, number>();
const epoch = (store: PlayerStore) => epochs.get(store) ?? 0;

const isRuleList = (x: unknown): x is Rule[] =>
  Array.isArray(x) && x.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r));

const clearAccount = (store: PlayerStore) => store.update((s) => ({ ...s, account: null, accountRules: null }));

/**
 * Ask the API who is signed in and load their rules. Runs on app start and on `online` events.
 *
 * Account rules are cached on the device (N-3: the minimum, the email and the rules) so dishes are still
 * checked offline (§9); a sign-out or a 401 removes them. Whatever is stored is validated by `activeRules`,
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
  if (!me.ok) {
    if (me.status === 401) { clearAccount(store); return 'signed-out'; }
    return 'offline'; // network, 5xx, 429, a non-JSON reply: no change
  }
  const email = (me.data as { email?: unknown } | null)?.email;
  if (typeof email !== 'string') return 'offline';
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
  } // otherwise keep the cached copy (or none, which is an error state)
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
