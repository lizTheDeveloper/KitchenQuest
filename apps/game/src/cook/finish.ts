import { standInCooks, type Catalogue, type ProgressEvent, type RulesContext } from '@kitchenquest/core/engine';

/**
 * The `cooked` progress event for finishing cook mode (Ruling 7): the slug, the player's local date and whether the
 * dish was on this week's plan. The toolkit is a fold over these events now; nothing writes it directly.
 *
 * `standsInFor` (I3) is filled from core `standInCooks` when the player's rules are known: the cooks whose every dish
 * is ⛔ for them today and to one of which this dish is an alternative. Core checks the claim again (and the server
 * with the rules it holds); a claim that doesn't hold is dropped, never the event.
 */
export function cookedEvent(
  slug: string, today: string, planned: boolean, id: string, cat: Pick<Catalogue, 'recipes'>, ctx: RulesContext | undefined,
): Extract<ProgressEvent, { kind: 'cooked' }> {
  const standsIn = ctx === undefined ? [] : standInCooks({ kind: 'recipe', slug }, today, cat, ctx);
  return { id, kind: 'cooked', at: today, recipe: slug, planned, ...(standsIn.length > 0 ? { standsInFor: standsIn } : {}) };
}
