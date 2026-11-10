// @vitest-environment happy-dom
import { beforeAll, describe, expect, test } from 'vitest';
import { createStore } from '../state/store';
import { h } from '../ui/dom';
import { mountApp, registerScreen } from './app';

/** Where focus lands after a route change, per the shell's rule. */
const overlayRoot = () => document.getElementById('overlay-root')!;
const settle = () => new Promise((r) => setTimeout(r, 0));
async function go(hash: string): Promise<void> {
  location.hash = hash;
  await settle();
  await settle();
}

beforeAll(async () => {
  document.body.replaceChildren(
    h('button', { id: 'pan-button', type: 'button' }, 'The Pan'),
    h('main', { id: 'screen' }, h('div', { id: 'stage', 'aria-hidden': 'true' }), h('div', { id: 'view' })),
    h('div', { id: 'overlay-root' }),
  );
  // A screen that opens an overlay (like a cook's intro) and focuses its button.
  registerScreen('map', () => ({
    title: 'Overlay',
    mount(el) {
      el.append(h('h1', null, 'With an overlay'));
      const next = h('button', { type: 'button', id: 'overlay-next' }, 'Next');
      overlayRoot().replaceChildren(next);
      next.focus();
    },
  }));
  // A screen that focuses something inline in the view (like the kitchen greeting).
  registerScreen('recipes', () => ({
    title: 'Inline',
    mount(el) {
      const next = h('button', { type: 'button', id: 'inline-next' }, 'Next');
      el.append(h('h1', null, 'Inline'), next);
      next.focus();
    },
  }));
  // A screen that moves no focus at all.
  registerScreen('settings', () => ({ title: 'Plain', mount(el) { el.append(h('h1', null, 'Plain')); } }));
  location.hash = '#/settings';
  mountApp(document, { store: createStore(null), now: () => new Date() });
  await settle();
});

describe('focus after a route change', () => {
  test('a screen that focused its own overlay while mounting keeps that focus', async () => {
    await go('#/map');
    expect(document.activeElement?.id).toBe('overlay-next');
  });

  test('focus put inline in the view gives way to the h1', async () => {
    await go('#/recipes');
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Inline');
  });

  test('an overlay that already had focus before the route change gives way to the h1', async () => {
    const stale = h('button', { type: 'button', id: 'stale' }, 'Stale');
    overlayRoot().replaceChildren(stale);
    stale.focus();
    await go('#/settings');
    expect(document.activeElement?.tagName).toBe('H1');
    expect(document.activeElement?.textContent).toBe('Plain');
  });
});
