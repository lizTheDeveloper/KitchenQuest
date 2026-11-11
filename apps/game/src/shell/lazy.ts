import type { Screen } from './app';

/**
 * A screen whose code loads on first visit, so first paint doesn't carry it. `title` is the screen's fixed title
 * (the shell reads it before `mount`); the service worker precaches the chunk, so the screen opens offline too.
 */
export function lazyScreen(title: string, load: () => Promise<Screen>): Screen {
  let inner: Screen | null = null;
  let gone = false;
  return {
    title,
    async mount(el, route, ctx) {
      const screen = await load();
      if (gone) return;
      inner = screen;
      await screen.mount(el, route, ctx);
    },
    unmount() {
      gone = true;
      inner?.unmount?.();
    },
  };
}
