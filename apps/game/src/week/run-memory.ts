import type { MarketRunView } from '@kitchenquest/core/engine';

let known: { run: MarketRunView; account: string } | null = null;
/**
 * M6 Step 10: the signed-in market run as the market screen (or a check-off) last read or changed it, for the account
 * it is for. The scripted Pan's check-off and cook mode's stall-swap label read it, and `loadKnownRun` fills it from
 * `GET /market-runs/current` when it is empty (a check-off ticks through the API, which re-reads the run under its locks). Another account's run is never
 * returned, so a sign-out needs no clearing here. Memory only, outside first paint (only lazy week code imports it).
 */
export function rememberRun(run: MarketRunView, account: string | null): void { known = account === null ? null : { run, account }; }
export const rememberedRun = (account: string | null): MarketRunView | null => (known !== null && known.account === account ? known.run : null);
