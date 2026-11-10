import { content } from '../content';
import { mountMentor } from '../mentor';
import type { PlayerStore } from '../state/store';
import { h } from '../ui/dom';
import { reducedMotion } from './motion';
import { parseRoute, routeHref, type Route } from './router';

export interface AppContext { store: PlayerStore; navigate(route: Route): void; now: () => Date }
export interface Screen { title: string; mount(el: HTMLElement, route: Route, ctx: AppContext): void | Promise<void>; unmount?(): void }

/** Thrown from a screen's `mount` when its route names something that doesn't exist: shows the not-found screen. */
export class RouteNotFound extends Error {}

const screens = new Map<Route['name'], () => Screen>();

/** Later tasks replace the placeholder for a route by registering the same name again. */
export function registerScreen(name: Route['name'], make: () => Screen): void {
  screens.set(name, make);
}

export function mountApp(doc: Document, base: Omit<AppContext, 'navigate'>): void {
  const win = doc.defaultView!;
  const view = doc.getElementById('view')!;
  const screenEl = doc.getElementById('screen')!;
  const ctx: AppContext = {
    ...base,
    navigate(route) {
      const next = route.name === 'notFound' ? route.hash : routeHref(route);
      if (win.location.hash === next) void render(false); else win.location.hash = next;
    },
  };

  // Motion: the player's setting wins; 'full' also beats the OS media query in CSS.
  const mql = win.matchMedia('(prefers-reduced-motion: reduce)');
  const applyMotion = () => {
    doc.documentElement.dataset.motion = reducedMotion(ctx.store.get().settings.reducedMotion, mql) ? 'reduced' : 'full';
  };
  applyMotion();
  ctx.store.subscribe(applyMotion);
  mql.addEventListener('change', applyMotion);

  const NOTICES = {
    corrupt: "We couldn't read the progress saved on this device, so you're starting fresh. A copy of the old data has been kept.",
    unsaved: "This device wouldn't save your last change. It will be lost when you close the page, so please check your storage settings.",
  } as const;
  const showNotice = () => {
    const n = ctx.store.notice;
    let el = doc.getElementById('store-notice');
    if (!n) { el?.remove(); return; }
    if (!el) { el = h('div', { class: 'notice', role: 'status', id: 'store-notice' }); screenEl.before(el); }
    el.textContent = NOTICES[n];
  };
  showNotice();
  ctx.store.subscribe(showNotice);

  doc.querySelector('.skip-link')?.addEventListener('click', (ev) => {
    ev.preventDefault(); // a '#view' hash would be a route change
    view.tabIndex = -1;
    view.focus();
  });

  mountMentor(doc, ctx.store, content.pan);

  let current: Screen | null = null;
  let token = 0;

  async function render(moveFocus: boolean) {
    const my = ++token;
    const route = parseRoute(win.location.hash);
    current?.unmount?.();
    current = null;
    // Each render gets its own container, so a slow mount that loses the race can't write into the new screen.
    const container = h('div', { class: 'screen-body' });
    view.replaceChildren(container);
    const make = screens.get(route.name);
    let screen = make ? make() : notFoundScreen();
    current = screen;
    doc.title = `${screen.title} · Kitchen Quest`;
    const focusBefore = doc.activeElement;
    try {
      await screen.mount(container, route, ctx);
    } catch (err) {
      const missing = err instanceof RouteNotFound;
      if (!missing) console.error(err);
      if (my !== token) return;
      screen.unmount?.();
      screen = missing ? notFoundScreen() : errorScreen();
      current = screen;
      doc.title = `${screen.title} · Kitchen Quest`;
      container.replaceChildren();
      await screen.mount(container, route, ctx);
    }
    if (my !== token) return;
    // A screen that opened an overlay and focused it (a cook's intro focuses its Next button) keeps that focus;
    // anything inline in the view (the kitchen's greeting) yields to the h1.
    const active = doc.activeElement;
    const overlayFocused = active !== focusBefore && !!doc.getElementById('overlay-root')?.contains(active);
    if (moveFocus && !overlayFocused) {
      const h1 = container.querySelector('h1');
      if (h1) { h1.tabIndex = -1; h1.focus(); }
    }
  }

  win.addEventListener('hashchange', () => { void render(true); });
  void render(false);
}

function notFoundScreen(): Screen {
  return {
    title: 'Not found',
    mount(el) {
      el.append(
        h('h1', null, 'Not found'),
        h('p', null, "That page isn't in the kitchen."),
        h('p', null, h('a', { href: routeHref({ name: 'kitchen' }) }, 'Back to the kitchen')),
      );
    },
  };
}

function errorScreen(): Screen {
  return {
    title: 'Something went off the boil',
    mount(el) {
      el.append(
        h('h1', null, 'Something went off the boil'),
        h('p', null, "That page wouldn't open. Nothing you've saved has been touched."),
        h('p', null, h('a', { href: routeHref({ name: 'kitchen' }) }, 'Back to the kitchen')),
      );
    },
  };
}
