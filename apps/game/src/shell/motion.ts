import type { PlayerStore } from '../state/store';

export function reducedMotion(setting: 'system' | 'on' | 'off', mql: { matches: boolean }): boolean {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return mql.matches;
}

/** The player's setting combined with the browser's prefers-reduced-motion, read now. */
export function isReducedMotion(store: Pick<PlayerStore, 'get'>, win: Window): boolean {
  return reducedMotion(store.get().settings.reducedMotion, win.matchMedia('(prefers-reduced-motion: reduce)'));
}
