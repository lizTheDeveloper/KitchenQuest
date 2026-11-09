import { IngredientGraph } from '@kitchenquest/core/engine';
import data from 'virtual:kq-content';
import type { GameContent } from './types';

export const content: GameContent = data;
export const graph: IngredientGraph = IngredientGraph.fromData(content.ingredients);

/** A technique's display name; an unknown id is shown as written rather than hidden. */
export function techniqueName(id: string): string {
  return content.techniques.techniques.find((t) => t.id === id)?.name ?? id;
}
