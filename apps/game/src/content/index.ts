import { IngredientGraph } from '@kitchenquest/core/engine';
import data from 'virtual:kq-content';
import type { ClientContent } from './types';

// typescript-eslint sees the `virtual:` module as an error type even though tsc resolves it via
// src/virtual.d.ts (checked with TS 5.9 and 7). The declared type is the contract here.
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- virtual module, typed in virtual.d.ts
export const content: ClientContent = data;
export const graph: IngredientGraph = IngredientGraph.fromData(content.ingredients);

/** A technique's display name; an unknown id is shown as written rather than hidden. */
export function techniqueName(id: string): string {
  return content.techniques.techniques.find((t) => t.id === id)?.name ?? id;
}
