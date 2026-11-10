import { registerScreen, type Screen } from '../shell/app';

/**
 * Your rules (`#/rules`), registered over Step 9's placeholder. The screen and its form load on first visit, so the
 * main chunk stays inside its budget; the service worker precaches the chunk, so it opens offline too.
 */
export function registerRulesScreen(): void {
  registerScreen('rules', (): Screen => {
    let inner: Screen | null = null;
    let gone = false;
    return {
      title: 'Your rules',
      async mount(el, route, ctx) {
        const { rulesScreen } = await import('./rules-screen');
        if (gone) return;
        inner = rulesScreen();
        await inner.mount(el, route, ctx);
      },
      unmount() { gone = true; inner?.unmount?.(); },
    };
  });
}
