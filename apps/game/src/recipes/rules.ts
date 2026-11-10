import { validateRules, type IngredientGraph, type Rule } from '@kitchenquest/core/engine';
import type { PlayerState } from '../state/store';

export type RulesState =
  | { status: 'ready'; rules: Rule[]; source: 'device' | 'account' }
  | { status: 'error'; message: string };

const UNREADABLE_MESSAGE =
  "The rules saved on this device couldn't be read, so some may be missing. Tell the Bureau your rules again to clear this.";

const ACCOUNT_NOT_LOADED_MESSAGE =
  "Your account's rules haven't loaded on this device yet, so dishes can't be checked. Connect to the internet and open Kitchen Quest again.";

/**
 * The rules to check dishes against. Signed in, the account's rules replace the device's: once they have
 * loaded they are the source of truth (unreadable device data no longer matters), and until they have, every
 * check is an error, never the device rules or "no rules". Signed out, account rules are never used.
 * Any doubt is an error, never an empty "ready": saved data that couldn't be read (`rulesUnreadable`),
 * or rules core's `validateRules` rejects (e.g. an ingredient id that was renamed).
 */
export function activeRules(state: PlayerState, graph: IngredientGraph): RulesState {
  const signedIn = state.account !== null;
  if (signedIn && state.accountRules === null) return { status: 'error', message: ACCOUNT_NOT_LOADED_MESSAGE };
  if (!signedIn && state.rulesUnreadable) return { status: 'error', message: UNREADABLE_MESSAGE };
  const source = signedIn ? 'account' : 'device';
  const rules = signedIn ? state.accountRules! : state.localRules;
  const problems = validateRules(rules, graph);
  if (problems.length > 0) return { status: 'error', message: problems.join('; ') };
  return { status: 'ready', rules, source };
}

/** The player's LOCAL calendar date as YYYY-MM-DD: at 23:30 in UTC−8 it is still today, not tomorrow. */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** What a card depends on in the player state, as a comparable key: re-render only when this changes. */
export function cardInputsKey(state: PlayerState): string {
  return JSON.stringify([state.account, state.localRules, state.accountRules, state.rulesUnreadable, state.settings.showCalories]);
}

/**
 * Calls `onChange(newDate)` when the player's local date has changed since the last look. Checked when the tab
 * becomes visible and at most once a minute while it is visible, so a card or shelf left open across midnight
 * (or a sleeping phone waking up) redraws with the right phases and freshness.
 */
export function watchLocalDate(
  doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>,
  now: () => Date,
  onChange: (today: string) => void,
): () => void {
  let last = localDate(now());
  const check = () => {
    if (doc.visibilityState !== 'visible') return;
    const today = localDate(now());
    if (today !== last) { last = today; onChange(today); }
  };
  doc.addEventListener('visibilitychange', check);
  const timer = setInterval(check, 60_000);
  return () => { doc.removeEventListener('visibilitychange', check); clearInterval(timer); };
}
