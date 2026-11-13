// M7 Step 8 (M6 fix review N2): the health_data deletes this device has asked for each account, counted on its
// partition (store.ts keeps the count through an erase, a prune, a merge with another tab and a reload). Settings
// counts one when the delete is asked and one more once it is done; a round, an event or a request that began before
// a count moved is never kept, put back or cached after it. Only lazy modules read it, so first paint never carries it.
import { partitionOf, withPartition, type AccountPartition, type PlayerState } from './store';

/** The health deletes asked on this device for account `key` (0 when none, or no partition). */
export function healthDeletesOf(s: Pick<PlayerState, 'accountProgress'>, key: string): number {
  return Object.hasOwn(s.accountProgress, key) ? s.accountProgress[key].healthDeletes ?? 0 : 0;
}

/** One more health delete for account `key` (its partition made if it has none). Nothing else changes. */
export function markHealthDelete(s: PlayerState, key: string): PlayerState {
  const base = Object.hasOwn(s.accountProgress, key) ? s : withPartition(s, key, partitionOf(s, key));
  const old: AccountPartition = base.accountProgress[key];
  return { ...base, accountProgress: { ...base.accountProgress, [key]: { ...old, healthDeletes: (old.healthDeletes ?? 0) + 1 } } };
}
