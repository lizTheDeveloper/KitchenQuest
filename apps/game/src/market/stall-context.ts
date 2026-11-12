// The market screens' shared context (M6 Step 9): the player's MarketCtx for core's stall functions, their seasonal
// region and month, and the profile both come from. Everything that decides (which questions, the variant, the
// season) is core's; this file only gathers its inputs, and fails closed: rules that can't be read give no context.
import { monthOf, seasonRegionFor, stallVariant, type IngredientGraph, type MarketCtx, type Rule, type SeasonTable, type StallFile, type Substitution } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ClientStall } from '../content/types';
import type { PlayerState } from '../state/store';

export interface MarketProfile { country: string | null; region: string | null }

/**
 * Core's MarketCtx for the player today: their active rules (as `rulesOf` reads them), the graph, the swaps (carried,
 * never applied to a question), the local date and the profile country as written. Null while the rules can't be
 * read: then the stall waits (`market.stall_wait`), as quests do (M5 fail closed, Ruling 4).
 */
export function marketCtxFor(
  rules: Rule[] | null, profile: MarketProfile, today: string, graph: IngredientGraph, subs: Substitution[],
): MarketCtx | null {
  if (rules === null) return null;
  return { rules, graph, subs, date: today, country: profile.country };
}

/**
 * The player's seasonal region (core `seasonRegionFor`: their own country and region against the curated table, null
 * for none or more than one, never a default) and the month of their local date. Throws on a bad date.
 */
export function seasonFor(profile: MarketProfile, table: SeasonTable, today: string): { regionId: string | null; month: number } {
  return { regionId: seasonRegionFor(profile, table), month: monthOf(today) };
}

/**
 * Where the player said they are: the device profile signed out, the account's (`GET /profile`) signed in. A profile
 * that can't be read is no country and no region: unscoped questions only and no seasonal round, never a guess. The
 * region never leaves the device in a URL or a prompt (C-13, P-5); it only picks a row of the table here.
 */
export async function profileFor(state: PlayerState, client: Pick<ApiClient, 'getProfile'>): Promise<MarketProfile> {
  if (state.account === null) return { country: state.localProfile?.country ?? null, region: state.localProfile?.region ?? null };
  const r = await client.getProfile();
  return r.ok ? { country: r.data.country, region: r.data.region } : { country: null, region: null };
}

/** The keeper's name as their sign has it: the Protein Counter's own name for that variant (a full stall, never a lesser one). */
export function keeperName(stall: ClientStall, ctx: MarketCtx | null): string {
  const pc = stall.variants?.protein_counter;
  return ctx !== null && pc?.name !== undefined && stallVariant(stall as StallFile, ctx) === 'protein_counter' ? pc.name : stall.name;
}

/** A line for the hub to show once on its next mount (the Pan's `market.leave_round` after leaving a stall). Memory only. */
let hubNote: string | null = null;
export function noteForHub(text: string): void { hubNote = text; }
export function takeHubNote(): string | null {
  const t = hubNote;
  hubNote = null;
  return t;
}
