import {
  fillFrame, rescueCandidate, type CheckStatus, type FilledFrame, type Frame, type IngredientGraph, type KeepsMap, type PantryItem, type ParsedRecipe,
  type Plan, type Rule, type Substitution,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { partitionKey, type PlayerState, type PlayerStore } from '../state/store';

/**
 * Use-It-Up Rescue in the kitchen (audit M-4 / M-14, Ruling 12, M5 Step 10): at most RESCUE_NUDGES_PER_DAY (one)
 * gentle offer a day, in-app only, for an item the player bought at the market and that core `rescueCandidate` picks
 * (in date, its own check ✅: never one their rules block or can't verify, never one past its keep time). The offer
 * is a Pantry Frame filled with that very item; a frame whose fill leaves the item out, or is ⛔, is never offered,
 * and a ❓ one is offered with `rescue.unverified` and the ❓ badge. "Not now", Compost and Cook each answer the day's
 * nudge. Off in settings, or in Family Table mode (compost is a write, C31), there is no offer at all.
 */
export interface RescueOffer { item: PantryItem & { id: string }; frame: Frame; filled: FilledFrame }

export interface RescueUses {
  recipes: ReadonlyMap<string, ParsedRecipe>;
  graph: IngredientGraph;
  rules: Rule[];
  /** Passed through to `fillFrame` (C41): a filler that needs a swap is offered with 🔁. */
  subs: Substitution[];
}

const RANK: Record<CheckStatus, number> = { ok: 0, swap: 1, unverified: 2, blocked: 3 };
/** Whose nudge memory this is: the live account's partition key, else the guest's. Nothing crosses accounts. */
const nudgeKey = (s: PlayerState): string => partitionKey(s) ?? 'guest';

/** Today's nudge for this partition, or null. */
function todays(s: PlayerState, today: string) {
  const r = s.rescue;
  return r !== null && r.key === nudgeKey(s) && r.on === today ? r : null;
}

/** The frame, filled with `item`, that rescues it best (✅, then 🔁, then ❓; never ⛔), or null. */
function frameFor(item: PantryItem & { id: string }, pantry: readonly PantryItem[], today: string, frames: readonly Frame[], keeps: KeepsMap, uses: RescueUses) {
  const id = item.ingredientId;
  if (id === null || !uses.graph.has(id)) return null;
  const kinds = [id, ...uses.graph.ancestors(id)];
  let best: { frame: Frame; filled: FilledFrame } | null = null;
  for (const frame of frames) {
    if (!frame.rescues.some((r) => kinds.includes(r))) continue;
    for (const slot of frame.slots) {
      const filled = fillFrame(frame, pantry, { rules: uses.rules, graph: uses.graph, subs: uses.subs, today, keeps }, { [slot.key]: item.name });
      const f = filled.fills[slot.key];
      // The rescued item itself must be in the dish (Step 3 carry): a frame that filled the slot with something else is refused.
      if (f === null || f.name !== item.name || f.ingredientId !== item.ingredientId) continue;
      if (filled.check.status === 'blocked') continue;
      if (best === null || RANK[filled.check.status] < RANK[best.filled.check.status]) best = { frame, filled };
    }
  }
  return best;
}

export function rescueOffer(
  state: PlayerState,
  pantry: readonly (PantryItem & { id: string })[],
  plan: Plan | null,
  today: string,
  frames: readonly Frame[],
  keeps: KeepsMap,
  uses: RescueUses,
): RescueOffer | null {
  if (!state.settings.rescueNudges || state.settings.familyTable) return null;
  const memory = todays(state, today);
  if (memory?.answered) return null;
  // Already nudged today, not yet answered: the same nudge again, never a second one.
  const pool = memory === null ? pantry : pantry.filter((p) => p.id === memory.itemId);
  const cand = rescueCandidate(pool, plan, today, keeps, false, uses);
  if (cand === null) return null;
  const found = frameFor(cand.item, pantry, today, frames, keeps, uses);
  return found === null ? null : { item: cand.item, ...found };
}

/** The offer was shown: it is today's one nudge (for this partition). */
export function noteNudge(store: PlayerStore, offer: RescueOffer, today: string): void {
  store.update((s) => (todays(s, today) !== null ? s : { ...s, rescue: { key: nudgeKey(s), on: today, itemId: offer.item.id, answered: false } }));
}

/** Cook, Compost or Not now: today's nudge is answered, and nothing more is offered today. */
export function answerNudge(store: PlayerStore, offer: RescueOffer, today: string): void {
  store.update((s) => ({ ...s, rescue: { key: nudgeKey(s), on: today, itemId: offer.item.id, answered: true } }));
}

/**
 * "Compost it": that pantry row, by id, leaves the pantry (a write, so never in Family Table mode). Signed in through
 * the M4 pantry route; signed out on the device. True when it went.
 */
export async function compost(store: PlayerStore, client: Pick<ApiClient, 'changePantry'>, item: PantryItem & { id: string }): Promise<boolean> {
  if (store.get().settings.familyTable) return false;
  if (store.get().account === null) {
    store.update((s) => ({ ...s, localPantry: s.localPantry.filter((p) => p.id !== item.id) }));
    return true;
  }
  const r = await client.changePantry({ add: [], removeNames: [], removeIds: [item.id] }, true);
  return r.ok;
}
