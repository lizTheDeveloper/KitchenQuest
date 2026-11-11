// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import type { AppContext, Screen } from './app';
import { lazyScreen } from './lazy';
import { SCREEN_TITLES } from './titles';

const route = { name: 'kitchen' } as never;
const ctx = {} as AppContext;

describe('lazyScreen', () => {
  test('shows its fixed title before the code loads, mounts the loaded screen, and unmounts it', async () => {
    const mount = vi.fn();
    const unmount = vi.fn();
    const s = lazyScreen('Cook', () => Promise.resolve({ title: 'Cook', mount, unmount }));
    expect(s.title).toBe('Cook');
    await s.mount(document.createElement('div'), route, ctx);
    expect(mount).toHaveBeenCalledOnce();
    s.unmount?.();
    expect(unmount).toHaveBeenCalledOnce();
  });

  test('a load that fails rejects the mount, so the shell shows its error screen (never a half-loaded screen)', async () => {
    const s = lazyScreen('Cook', () => Promise.reject(new Error('chunk gone')));
    await expect(s.mount(document.createElement('div'), route, ctx)).rejects.toThrow('chunk gone');
  });

  test('leaving before the code arrives mounts nothing', async () => {
    const mount = vi.fn();
    let done!: (s: Screen) => void;
    const s = lazyScreen('Cook', () => new Promise<Screen>((r) => { done = r; }));
    const mounted = s.mount(document.createElement('div'), route, ctx);
    s.unmount?.();
    done({ title: 'Cook', mount });
    await mounted;
    expect(mount).not.toHaveBeenCalled();
  });
});

describe('lazy screen titles', () => {
  test('each screen module reports the title the shell shows while it loads', async () => {
    const { rulesScreen } = await import('../rules/rules-screen');
    expect(rulesScreen().title).toBe(SCREEN_TITLES.rules);
    const { cookScreen } = await import('../cook/cook-screen');
    expect(cookScreen().title).toBe(SCREEN_TITLES.cook);
    const { recipeScreen } = await import('../recipes/recipe-screen');
    expect(recipeScreen().title).toBe(SCREEN_TITLES.recipe);
    const { recipesScreen } = await import('../recipes/recipes-screen');
    expect(recipesScreen().title).toBe(SCREEN_TITLES.recipes);
    const { mapScreen } = await import('../world/map-screen');
    expect(mapScreen().title).toBe(SCREEN_TITLES.map);
    const { visitScreen } = await import('../world/visit-screen');
    expect(visitScreen().title).toBe(SCREEN_TITLES.visit);
  });
});
