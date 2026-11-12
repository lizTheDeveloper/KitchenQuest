import { stockSwapsFor, type MarketRunView } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { PlayerState } from '../state/store';
import { devicePlan, weekOf } from './context';
import { rememberedWeek } from './memory';
import { rememberedRun, rememberRun } from './run-memory';

/**
 * M6 Step 10 (Ruling 11): the plan week's market run as this device knows it, read only (nothing is opened or
 * written): signed out, the device run of the current plan week; signed in, the run the market screen last read for
 * this account (there is no read-only run route). Null when there is none, or it is another week's.
 */
export function knownRun(state: PlayerState, today: string): MarketRunView | null {
  const account = state.account?.email ?? null;
  if (account !== null) {
    const run = rememberedRun(account);
    const week = rememberedWeek(account)?.weekStart ?? null;
    return run !== null && (week === null || run.weekStart === week) ? run : null;
  }
  const weekStart = weekOf(today, state.localProfile?.marketDays ?? []);
  const r = state.localWeek.runs.find((x) => x.weekStart === weekStart) ?? null;
  return r === null ? null : { id: r.id, weekStart: r.weekStart, items: r.items, doneAt: r.doneAt };
}

/**
 * Cook mode's stall swaps for a dish planned this week (core `stockSwapsFor` over the known run): "swapped at the
 * market: Y for X". [] when the dish is not on this week's plan or the run made none.
 */
export function stockSwapsNow(state: PlayerState, slug: string, today: string): { from: string; to: string }[] {
  const run = knownRun(state, today);
  if (run === null) return [];
  const account = state.account?.email ?? null;
  const plan = account === null ? devicePlan(state, run.weekStart) : (rememberedWeek(account)?.plan ?? null);
  const planned = plan === null ? account !== null : plan.items.some((i) => i.kind === 'dish' && i.slug === slug);
  return planned ? stockSwapsFor(run, slug) : [];
}

/**
 * The known run, loaded on demand signed in (coordinator ruling 3): the remembered one, else `GET /market-runs/current`
 * (read only), remembered for this account. Signed out the device run. Null on any failure: nothing is guessed.
 */
export async function loadKnownRun(state: PlayerState, client: Pick<ApiClient, 'currentRun'>, today: string): Promise<MarketRunView | null> {
  const account = state.account?.email ?? null;
  const known = knownRun(state, today);
  if (account === null || known !== null) return known;
  const r = await client.currentRun(today).catch(() => null);
  if (r === null || !r.ok || r.data.run === null) return null;
  rememberRun(r.data.run, account);
  return r.data.run;
}
