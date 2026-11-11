// What can stand in for a dish the player's rules block (concern-1 and I3 rulings). Shared by the quest engine (a
// quest cook step) and grantsFor (trust cook-weeks). Pure: dates are passed in, every dish goes through `check`.
import type { IngredientGraph } from '../ingredients/graph';
import type { Catalogue } from '../progress/types';
import type { ParsedRecipe } from '../recipe/types';
import { check, type CheckStatus, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';

export interface FrameOption {
  id: string;
  technique: string;
  /** The frame's rules status as the frame engine (Step 3) works it out with `check`. */
  status: CheckStatus;
}

/** The player's rules and the content to judge dishes with. */
export interface RulesContext {
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  /** Every canon recipe (all taught, Ruling 3), parsed. */
  recipes: ReadonlyMap<string, ParsedRecipe>;
  /** Pantry Frames the player could cook; optional until frames exist (Step 3). Only 'ok' / 'swap' are offered. */
  frames?: readonly FrameOption[];
}

/** A dish that can stand in for a rule-blocked one: never ⛔ or ❓. */
export type CookAlternative =
  | { kind: 'recipe'; slug: string; status: 'ok' | 'swap' }
  | { kind: 'frame'; id: string; status: 'ok' | 'swap' };

export const passes = (s: CheckStatus): s is 'ok' | 'swap' => s === 'ok' || s === 'swap';
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A dish's rules status on `date`; a recipe missing from `ctx.recipes` can't be verified. */
export function statusOn(slug: string, date: string, ctx: RulesContext): CheckStatus {
  const r = ctx.recipes.get(slug);
  return r ? check(r, ctx.rules, ctx.graph, ctx.subs, date).status : 'unverified';
}

/**
 * What can stand in for `recipe` on `date`: every other non-sacred recipe, and every frame, that practises one of
 * its techniques (its `skills`) and whose rules check is ✅ or a labelled swap. Recipes by slug, then frames by id.
 */
export function alternativesOn(recipe: string, date: string, ctx: RulesContext): CookAlternative[] {
  const skills = new Set(ctx.recipes.get(recipe)?.meta.skills ?? []);
  const out: CookAlternative[] = [];
  for (const slug of [...ctx.recipes.keys()].sort(byId)) {
    const r = ctx.recipes.get(slug)!;
    if (slug === recipe || r.meta.sacred || !r.meta.skills.some((t) => skills.has(t))) continue;
    const status = check(r, ctx.rules, ctx.graph, ctx.subs, date).status;
    if (passes(status)) out.push({ kind: 'recipe', slug, status });
  }
  for (const f of [...(ctx.frames ?? [])].sort((a, b) => byId(a.id, b.id))) {
    if (skills.has(f.technique) && passes(f.status)) out.push({ kind: 'frame', id: f.id, status: f.status });
  }
  return out;
}

/**
 * The cooks a real cook of `dish` on `date` stands in for (I3 ruling): every cook C, other than the dish's own cook,
 * whose non-sacred dishes are all ⛔ for the player on that date (❓ dishes are cookable, I2), where `dish` is an
 * alternative to one of them. Sorted by cook id. The client puts this in the event's `standsInFor`; grantsFor checks it.
 */
export function standInCooks(
  dish: { kind: 'recipe'; slug: string } | { kind: 'frame'; id: string },
  date: string,
  cat: Pick<Catalogue, 'recipes'>,
  ctx: RulesContext,
): string[] {
  const ownCook = dish.kind === 'recipe' ? cat.recipes.get(dish.slug)?.cook : undefined;
  const dishesOf = new Map<string, string[]>();
  for (const [slug, r] of cat.recipes) if (!r.sacred) dishesOf.set(r.cook, [...(dishesOf.get(r.cook) ?? []), slug]);
  const out: string[] = [];
  for (const [cook, dishes] of [...dishesOf].sort(([a], [b]) => byId(a, b))) {
    if (cook === ownCook || !dishes.every((d) => statusOn(d, date, ctx) === 'blocked')) continue;
    const standsIn = dishes.some((d) =>
      alternativesOn(d, date, ctx).some((a) => (a.kind === 'recipe' ? dish.kind === 'recipe' && a.slug === dish.slug : dish.kind === 'frame' && a.id === dish.id)),
    );
    if (standsIn) out.push(cook);
  }
  return out;
}
