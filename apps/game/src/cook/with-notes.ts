import type { MarginNote } from '@kitchenquest/core/engine';

/**
 * "Cook with my notes" (M5 Step 11): the Recipe Book hands cook mode the player's notes on one dish, in this page's
 * memory only. Notes are health data: they are never put in the address, in storage or in a URL (P-5). Cook mode takes
 * them once, for that dish; a reload or another dish cooks the canon recipe as the cook wrote it.
 */
let pending: { slug: string; notes: MarginNote[] } | null = null;

export function cookWithNotes(slug: string, notes: readonly MarginNote[]): void {
  pending = { slug, notes: notes.filter((n) => n.recipe === slug) };
}

/** The notes handed over for `slug`, once (then forgotten), or null. */
export function takeNotes(slug: string): MarginNote[] | null {
  const p = pending;
  pending = null;
  return p !== null && p.slug === slug && p.notes.length > 0 ? p.notes : null;
}
