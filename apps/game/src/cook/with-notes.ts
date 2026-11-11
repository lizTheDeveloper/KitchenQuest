import type { MarginNote } from '@kitchenquest/core/engine';

/**
 * "Cook with my notes" (M5 Step 11): the Recipe Book hands cook mode the player's notes on one dish, in this page's
 * memory only. Notes are health data: they are never put in the address, in storage or in a URL (P-5). Cook mode takes
 * them once, for that dish and the account that handed them over (fix M2: a sign-out or another account never cooks
 * with them); a reload or another dish cooks the canon recipe as the cook wrote it.
 */
let pending: { slug: string; account: string; notes: MarginNote[] } | null = null;

export function cookWithNotes(slug: string, notes: readonly MarginNote[], account: string): void {
  pending = { slug, account, notes: notes.filter((n) => n.recipe === slug) };
}

/** The notes handed over for `slug` by `account`, once (then forgotten, whoever asks), or null. */
export function takeNotes(slug: string, account: string | null): MarginNote[] | null {
  const p = pending;
  pending = null;
  return p !== null && p.slug === slug && account !== null && p.account === account && p.notes.length > 0 ? p.notes : null;
}

/** Forget any hand-off (an account change, fix M2). */
export function dropNotesHandOff(): void {
  pending = null;
}
