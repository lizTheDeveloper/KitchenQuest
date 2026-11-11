import type { Rule } from '@kitchenquest/core/engine';
import type { PlayerState } from '../state/store';

/** The rules a card is compared with (S13, M-5): the account's when signed in (none while they load), else the device's. */
export function savedRules(s: Pick<PlayerState, 'account' | 'accountRules' | 'localRules'>): readonly Rule[] {
  return s.account !== null ? (s.accountRules ?? []) : s.localRules;
}
