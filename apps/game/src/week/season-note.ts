// The Season's Table on the week screens (M6 Step 10, Ruling 10): information only. A note never hides, reorders,
// badges or locks anything, has no warning style and no countdown, and is never shown on a row the rules engine can't
// verify (❓) or blocks (⛔). Player-facing season text comes ONLY from core `seasonNote` / `dishSeasonNote` (Step 2
// fix round 1, I1), which give a note only for an item the rules engine calls ✅. With no region, no note at all
// (`market.no_calendar` is said once, on the stalls hub, never here).
import { dishSeasonNote as coreDishSeasonNote, listWords, seasonNote, type ListItem, type MarketCtx, type ParsedRecipe, type SeasonTable } from '@kitchenquest/core/engine';
import { contentText } from '../ui/dom';
import { writtenLine } from './plan-view';

/** Where the player is in the Season's Table: their region id (or null) and the table. */
export interface SeasonView { regionId: string | null; table: SeasonTable }

/**
 * A market-list row's note: `season.now` ("in season where you are") for the region's first category, else
 * `season.other` with the region's own category label. Null with no region, on a ❓ or rules-swapped row, a row marked
 * out of stock, or whenever core's `seasonNote` gives none (the item isn't ✅, or the month has no entry).
 */
export function seasonNoteFor(row: ListItem, season: SeasonView, ctx: MarketCtx): string | null {
  if (season.regionId === null || row.unverified === true || row.outOfStock === true) return null;
  const s = seasonNote(row.ingredientId, season.regionId, season.table, ctx);
  if (s === null) return null;
  return s.isNow ? writtenLine('season.now', { item: row.name }) : writtenLine('season.other', { item: row.name, category: s.label });
}

/**
 * The plan view's note for one dish: `season.now` naming the dish's ingredients that are in season now and ✅ for the
 * player (core `dishSeasonNote`, in recipe order, by their graph names). Null with no region, for a sacred dish, or
 * when none is.
 */
export function dishSeasonNote(recipe: ParsedRecipe, season: SeasonView, ctx: MarketCtx): string | null {
  if (season.regionId === null) return null;
  const ids = coreDishSeasonNote(recipe, season.regionId, season.table, ctx);
  if (ids.length === 0) return null;
  return writtenLine('season.now', { item: listWords(ids.map((id) => ctx.graph.get(id).name)) });
}

/** The note as an element: plain text, the same style as any other row text (never a warning colour). */
export const seasonNoteEl = (text: string) => contentText('p', text, { class: 'season-note' });
