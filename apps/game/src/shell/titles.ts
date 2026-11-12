import { content } from '../content';
import { parseRoute } from './router';

/** The title of each lazily loaded screen, written once: the shell reads it before the screen's code has loaded. */
export const SCREEN_TITLES = {
  settings: 'Settings', recipes: 'Recipe shelf', recipe: 'Recipe', cook: 'Cook', map: 'World map', visit: 'Visit', rules: 'Your rules',
  plan: 'This week', market: 'Market list', frame: 'Pantry Frame', book: 'Recipe Book',
  // M6 Step 9: the hub, and a stall before its keeper's name is known (the stall screen names it).
  stalls: 'The Market', stall: 'Stall',
} as const;

/** A stall's title before its code loads: the keeper's name (first-paint `stallNames`); the stall screen names a variant. */
export function stallTitle(hash: string): string {
  const r = parseRoute(hash);
  return r.name === 'stall' ? content.stallNames[r.id] : SCREEN_TITLES.stall;
}
