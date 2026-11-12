import {
  buildPlanCard,
  planWeekStart,
  navPlace,
  dishName,
  type NavTarget,
  type PlanCard,
  type PlanContext,
  type PlanRequest,
  type ReplyPart,
  type WeeklySlotInput,
} from '@kitchenquest/core';
import type { Catalog } from '../catalog.js';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { catalogueFor } from '../progress/catalogue.js';
import { progressViewOf } from '../progress/service.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';
import { eq } from 'drizzle-orm';
import { profiles } from '../db/schema.js';
import { loadRules } from '../rules/store.js';
import { planContext } from '../week/plan-service.js';
import { loadPlan } from '../week/store.js';
import type { LoopContent } from '../catalog.js';
import type { RecipeIndexSource } from '../recipes/recipe-index.js';

/**
 * The plan and navigation pieces of a mentor turn (M5 Step 8). Code builds every card from core: the model's
 * `propose_plan` and the scripted `planIntent` reach the same `buildPlanCard` with the same context, and a
 * navigation is only ever a `go` part, a chip the player taps (Ruling 15).
 */

/** Where a plan card reads the canon and the loop content from (the app's one recipe index, C7). */
export interface WeekSource {
  loop: LoopContent;
  recipes: RecipeIndexSource;
}

export interface PlanTurnDeps {
  keyring: Keyring;
  catalog: Catalog;
  week: WeekSource;
}

/** What `buildPlanCard` reads for the player's current plan week, in the caller's transaction (no lock: the confirm re-checks under `plan:`). */
export type PlanCardContext = PlanContext & { slot: WeeklySlotInput };

/**
 * The player's current plan week (Ruling 11, from their market days and `today`, their local date), their rules now,
 * the week's stored plan (its items are kept on the card; its `hard` and slot feed One More Technique) and their
 * toolkit, from their stored progress. Plans are health data (Step 6 ruling): the caller reads this only with
 * `health_data`.
 */
export async function planCardContext(tx: Tx, deps: PlanTurnDeps, userId: string, today: string): Promise<PlanCardContext> {
  const recipes = await deps.week.recipes.current(tx);
  const week = { catalog: deps.catalog, loop: deps.week.loop, recipes };
  // Read only: a turn never writes (the plan service's loadProfile creates an empty profile row on first use).
  const row = (await tx.select({ marketDays: profiles.marketDays }).from(profiles).where(eq(profiles.userId, userId))).at(0);
  const weekStart = planWeekStart(today, row?.marketDays ?? []);
  const rules = await loadRules(tx, deps.keyring, userId);
  const stored = await loadPlan(tx, deps.keyring, userId, weekStart);
  const ctx = { ...planContext(week, weekStart, rules), existing: stored?.items ?? [] };
  const { toolkit } = await progressViewOf(tx, deps.keyring, userId, catalogueFor(recipes, deps.week.loop), {
    rewards: deps.week.loop.rewards,
    thresholds: deps.week.loop.thresholds,
  });
  return {
    ...ctx,
    slot: {
      toolkit,
      techniques: deps.week.loop.techniques,
      recipes,
      // Every canon dish is the player's to cook (Ruling 3); a sacred one is never offered (§10).
      taught: new Set([...recipes].filter(([, r]) => !r.meta.sacred).map(([slug]) => slug)),
      planned: [],
      rules,
      graph: deps.catalog.graph,
      subs: [...deps.catalog.substitutions],
      weekStart,
      today,
      thresholds: deps.week.loop.thresholds,
      week: { hard: stored?.hard ?? false, slot: stored?.slot ?? 'unanswered' },
    },
  };
}

/** The plan card for `req` with its read-back as reply parts, or only the lines when there is nothing to plan. */
export function planReply(req: PlanRequest, ctx: PlanCardContext): { card: PlanCard | null; parts: ReplyPart[] } {
  const built = buildPlanCard(req, ctx);
  if ('none' in built) return { card: null, parts: built.none.map((l) => ({ kind: 'line', line: l })) };
  return { card: built, parts: built.readback.map((l) => ({ kind: 'line', line: l })) };
}

/** A navigation chip with its `nav.offer` line: the place's name from code (a cook's display name, a dish's title). */
export function goPart(target: NavTarget, deps: { week: WeekSource }, recipes: RecipeIndex): ReplyPart {
  const name =
    target.to === 'visit' ? (deps.week.loop.cookNames.get(target.cook) ?? null) : target.to === 'recipe' ? dishName(target.slug, recipes) : null;
  return { kind: 'go', target, line: { trigger: 'nav.offer', vars: { place: navPlace(target, name) } } };
}
