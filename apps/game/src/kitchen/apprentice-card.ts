import type { ProgressView } from '@kitchenquest/core/engine';
import { h } from '../ui/dom';

/** Stamps are earned in M5 and spent nowhere until M10's cosmetics (Ruling 17): the card says so, with no price and no shop. */
const OUTFITTER_NOTE = "*Stamps are kept with your papers. The Bureau's outfitter opens later.";

/**
 * The apprentice's card in the kitchen: the level and the stamps, quietly. No bar to the next level, no XP still
 * to go, no streak, no daily target and no count of anything not yet done (Step 9, audit M-1). Step 11 adds the
 * Shared Table tally here.
 */
export function renderApprenticeCard(view: Pick<ProgressView, 'level' | 'stamps'>): HTMLElement {
  return h('section', { class: 'apprentice-card', 'aria-labelledby': 'apprentice-card-title' },
    h('h2', { id: 'apprentice-card-title' }, 'Your apprentice papers'),
    h('p', { class: 'apprentice-level' }, `Apprentice level ${view.level}`),
    h('p', { class: 'apprentice-stamps' }, view.stamps === 1 ? 'One Bureau Stamp' : `Bureau Stamps: ${view.stamps}`),
    h('p', { class: 'bureau-footnote' }, OUTFITTER_NOTE),
  );
}
