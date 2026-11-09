import type { ParsedRecipe, TechniqueEvent } from '@kitchenquest/core/engine';

/** One 'cooked' event for each technique the recipe teaches. `today` is the player's local date. */
export function cookedEvents(slug: string, recipe: ParsedRecipe, today: string): TechniqueEvent[] {
  return recipe.meta.skills.map((technique) => ({ kind: 'cooked', technique, at: today, recipe: slug }));
}
