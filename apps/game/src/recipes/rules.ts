import { validateRules, type IngredientGraph, type Rule } from '@kitchenquest/core/engine';
import type { ApiErrorBody } from '../api/types';
import { localDate, type PlayerState } from '../state/store';

export type RulesState =
  | { status: 'ready'; rules: Rule[]; source: 'device' | 'account' }
  /** `message` is player copy; `problems` (core's text) is for logs and tests, never shown on a card. */
  | { status: 'error'; reason: 'unreadable' | 'invalid' | 'account_not_loaded'; message: string; problems: string[] };

export const RULES_UNREADABLE_MESSAGE =
  "Some of the rules saved on this device couldn't be read, so I can't be sure what to check for. Open Your rules to look them over and confirm them.";

export const RULES_INVALID_MESSAGE =
  "One of your saved rules names something the Bureau's ingredient ledger no longer knows, so I can't check dishes against it. Open Your rules to fix it.";

/** M3 Step 11's text, kept verbatim: signed in with `accountRules === null`, every check fails closed. */
export const ACCOUNT_NOT_LOADED_MESSAGE =
  "Your account's rules couldn't be loaded, so dishes can't be checked. Try again in a moment.";

/**
 * The rules to check dishes against. Signed in, the account's rules replace the device's: once they have
 * loaded they are the source of truth (unreadable device data no longer matters), and until they have, every
 * check is an error, never the device rules or "no rules". Signed out, account rules are never used.
 * Any doubt is an error, never an empty "ready": saved data that couldn't be read (`rulesUnreadable`),
 * or rules core's `validateRules` rejects (e.g. an ingredient id that was renamed).
 */
export function activeRules(state: PlayerState, graph: IngredientGraph): RulesState {
  const signedIn = state.account !== null;
  if (signedIn && state.accountRules === null) return { status: 'error', reason: 'account_not_loaded', message: ACCOUNT_NOT_LOADED_MESSAGE, problems: [] };
  if (!signedIn && state.rulesUnreadable) return { status: 'error', reason: 'unreadable', message: RULES_UNREADABLE_MESSAGE, problems: [] };
  const source = signedIn ? 'account' : 'device';
  const rules = signedIn ? state.accountRules! : state.localRules;
  const problems = validateRules(rules, graph);
  if (problems.length > 0) return { status: 'error', reason: 'invalid', message: RULES_INVALID_MESSAGE, problems };
  return { status: 'ready', rules, source };
}

/** An API refusal that means the saved rules no longer validate (409 `rules_need_review`), as a rules error; else null. */
export function rulesStateForApiError(error: ApiErrorBody, status: number): RulesState | null {
  if (status !== 409 || error.code !== 'rules_need_review') return null;
  return { status: 'error', reason: 'invalid', message: RULES_INVALID_MESSAGE, problems: [error.message] };
}

/** The player's LOCAL calendar date as YYYY-MM-DD: at 23:30 in UTC−8 it is still today, not tomorrow (state/store.ts). */
export { localDate };

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
