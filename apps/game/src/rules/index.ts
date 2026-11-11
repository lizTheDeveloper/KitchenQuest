import { registerScreen } from '../shell/app';
import { lazyScreen } from '../shell/lazy';

/**
 * Your rules (`#/rules`), registered over Step 9's placeholder. The screen and its form load on first visit, so the
 * main chunk stays inside its budget; the service worker precaches the chunk, so it opens offline too.
 */
export function registerRulesScreen(): void {
  registerScreen('rules', () => lazyScreen('Your rules', async () => (await import('./rules-screen')).rulesScreen()));
}
