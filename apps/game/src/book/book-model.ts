import type { MarginNote, ProgressView, SharedTally, Tier } from '@kitchenquest/core/engine';
import type { ClientContent } from '../content/types';

/**
 * The Recipe Book's pages (M5 Step 11), from core-only inputs: the progress view, the content, the player's margin
 * notes and the Shared Table tally. Nothing here fetches or stores anything.
 */

export type BookNote = MarginNote & { id: string };

export interface BookPage {
  slug: string; dish: string; cook: string;
  /** The cook's gift lines, as written: the page opens with them. */
  gift: string[];
  /** The community first (audit M-5, voice §0.4): the home cooks of the place, then who taught it. */
  credit: string;
  techniques: { id: string; name: string; tier: Tier }[];
  cookedOn: string[];
  notes: BookNote[];
  /** Meals of this dish shared with someone (Cooked for Someone), from the tally's `byRecipe` (C21). */
  sharedMeals: number;
}

/** A Pantry Frame the player has cooked (`view.framesCookedOn`). */
export interface FramePage { id: string; title: string; technique: string; credit: string; cookedOn: string[] }

/** Signed out there is no Shared Table: counts are all zero. */
export const NO_TALLY: SharedTally = { shared: 0, byRecipe: {} };

/** The book's credit line for a cook's dish: the community first, then the cook who taught it. */
export const communityCredit = (place: string, cook: string): string => `The home cooks of ${place}, as taught by ${cook}`;

/**
 * One page per dish the player was taught (its cook's quest done, or the dish cooked at least once), never one for a
 * sacred dish (C39, spec §10), and never a list or a count of dishes not yet taught (no "n of m", no tabs per country).
 * Pages run in order of the first cook date; a dish taught but not yet cooked follows, by title. Each page's notes are
 * the player's notes filtered here by slug (C32); `sharedMeals` is `shared.byRecipe[slug] ?? 0` (C21). Frames are a
 * section of their own, each once it has been cooked at least once.
 */
export function bookPages(
  view: ProgressView, content: ClientContent, notes: ReadonlyMap<string, readonly BookNote[]>, shared: SharedTally,
): { dishes: BookPage[]; frames: FramePage[] } {
  const techniqueName = (id: string) => content.techniques.techniques.find((t) => t.id === id)?.name ?? id;
  const questTaught = new Set<string>();
  for (const cook of Object.values(content.cooks)) if (view.questsDone.includes(cook.quest.id)) questTaught.add(cook.recipe);
  const dishes: BookPage[] = [];
  for (const [slug, recipe] of Object.entries(content.recipes)) {
    const { meta } = recipe;
    if (meta.sacred) continue;
    const cookedOn = Object.hasOwn(view.cookedOn, slug) ? [...view.cookedOn[slug]].sort() : [];
    if (cookedOn.length === 0 && !questTaught.has(slug)) continue;
    const cook = Object.hasOwn(content.cooks, meta.cook) ? content.cooks[meta.cook] : null;
    // A taught dish's techniques were at least seen (its lessons); the toolkit says how far the player has taken each.
    const techniques = meta.skills.map((id) => ({ id, name: techniqueName(id), tier: Object.hasOwn(view.toolkit.techniques, id) ? view.toolkit.techniques[id].tier : 'seen' as Tier }));
    const byRecipe = shared.byRecipe;
    dishes.push({
      slug, dish: meta.title, cook: cook?.name ?? meta.cook,
      gift: cook !== null && cook.recipe === slug ? [...cook.gift] : [],
      credit: communityCredit(cook?.place ?? meta.region, cook?.name ?? meta.cook),
      techniques, cookedOn,
      notes: [...(notes.get(slug) ?? [])].filter((n) => n.recipe === slug),
      sharedMeals: Object.hasOwn(byRecipe, slug) && Number.isInteger(byRecipe[slug]) && byRecipe[slug] > 0 ? byRecipe[slug] : 0,
    });
  }
  dishes.sort((a, b) => {
    const fa = a.cookedOn[0], fb = b.cookedOn[0];
    if (fa !== undefined && fb !== undefined && fa !== fb) return fa < fb ? -1 : 1;
    if (fa === undefined && fb !== undefined) return 1;
    if (fb === undefined && fa !== undefined) return -1;
    return a.dish < b.dish ? -1 : a.dish > b.dish ? 1 : 0;
  });
  const frames: FramePage[] = content.frames
    .filter((f) => Object.hasOwn(view.framesCookedOn, f.id) && view.framesCookedOn[f.id].length > 0)
    .map((f) => ({ id: f.id, title: f.title, technique: techniqueName(f.technique), credit: f.credit, cookedOn: [...view.framesCookedOn[f.id]].sort() }))
    .sort((a, b) => (a.cookedOn[0] < b.cookedOn[0] ? -1 : a.cookedOn[0] > b.cookedOn[0] ? 1 : 0));
  return { dishes, frames };
}

/** The player's notes by recipe slug, filtered here on the device (C32): one GET /notes, never a slug in a URL. */
export function notesBySlug(all: readonly BookNote[]): Map<string, BookNote[]> {
  const out = new Map<string, BookNote[]>();
  for (const n of all) {
    if (typeof n.recipe !== 'string') continue;
    out.set(n.recipe, [...(out.get(n.recipe) ?? []), n]);
  }
  return out;
}
