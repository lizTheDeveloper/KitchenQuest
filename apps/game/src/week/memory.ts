import type { Plan, ToolkitState } from '@kitchenquest/core/engine';

/**
 * The week's small in-memory facts (M5 Step 10), with no week code, so first paint can hold them: the player's
 * current week as last read or saved (signed in: the server's answer), for the account it was read for, and the
 * toolkit progress shows once it has loaded. Nothing here is stored; a sign-out forgets the remembered week.
 */

let known: { weekStart: string; plan: Plan | null; account: string | null } | null = null;

export function rememberWeek(weekStart: string, plan: Plan | null, account: string | null): void { known = { weekStart, plan, account }; }
/** The remembered week of this account (null: signed out), if any. Another account's is never returned. */
export const rememberedWeek = (account: string | null): { weekStart: string; plan: Plan | null } | null =>
  (known !== null && known.account === account ? known : null);
/** A sign-out or an account change: the week remembered for the old session goes (M2). */
export function forgetWeek(): void { known = null; }

const DAY_MS = 86_400_000;
/**
 * Whether `slug` is planned for `today` in this account's remembered week (a cook's `planned`, Ruling 7). Another
 * account's week never counts (Step 9 partitions).
 */
export function plannedOn(slug: string, today: string, account: string | null): boolean {
  const plan = rememberedWeek(account)?.plan ?? null;
  if (plan === null) return false;
  const day = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${plan.weekStart}T00:00:00Z`)) / DAY_MS);
  return day >= 0 && day < 7 && plan.items.some((i) => i.kind === 'dish' && i.slug === slug && i.day === day);
}

let toolkitSource: (() => ToolkitState) | null = null;
/** Set by progress once it has loaded (it loads with the kitchen): the toolkit the game shows. */
export function setToolkitSource(fn: () => ToolkitState): void { toolkitSource = fn; }
/** The toolkit the game shows, or null while progress is still loading (then One More Technique offers nothing). */
export const currentToolkit = (): ToolkitState | null => toolkitSource?.() ?? null;
