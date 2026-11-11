import { registerScreen } from '../shell/app';
import { lazyScreen } from '../shell/lazy';
import { SCREEN_TITLES } from '../shell/titles';

/**
 * Your rules (`#/rules`), registered over Step 9's placeholder. The screen and its form load on first visit, so the
 * main chunk stays inside its budget; the service worker precaches the chunk, so it opens offline too.
 */
export function registerRulesScreen(): void {
  registerScreen('rules', () => lazyScreen(SCREEN_TITLES.rules, async () => (await import('./rules-screen')).rulesScreen()));
}
