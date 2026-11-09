import { toolkitRows } from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import { content, techniqueName } from '../content';
import { createDialogue, getMentor } from '../mentor';
import { localDate } from '../recipes/rules';
import { hideStage, showScene } from '../scenes/phaser-host';
import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { reducedMotion } from '../shell/motion';
import type { PlayerStore } from '../state/store';
import { renderActionBar } from '../ui/action-bar';
import { showDialogue } from '../ui/dialogue-box';
import { h } from '../ui/dom';
import { greetingTrigger } from '../world/greeting';
import { renderToolkit } from './toolkit-view';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The Pan greets once per page load, on the first kitchen visit. */
let greeted = false;
/** Rusty invitations draw from their own in-memory history: the knife roll never writes to the store. */
let invites: ReturnType<typeof createDialogue> | null = null;

function isReduced(store: PlayerStore, win: Window): boolean {
  return reducedMotion(store.get().settings.reducedMotion, win.matchMedia('(prefers-reduced-motion: reduce)'));
}

/** The knife roll: a modal dialog over everything else. Returns a function that closes it. */
function openKnifeRoll(doc: Document, ctx: AppContext, onClose: () => void): () => void {
  const root = doc.getElementById('overlay-root') ?? doc.body;
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  invites ??= createDialogue(content.pan);
  const rows = toolkitRows(ctx.store.get().toolkit, localDate(ctx.now()), content.techniques.freshness);
  const body = renderToolkit(rows, {
    name: techniqueName,
    rustyLine: (technique) => invites!.say('toolkit.rusty_invite', { technique }).text,
  });

  const inerted: HTMLElement[] = [];
  for (const el of Array.from(doc.body.children)) {
    if (el instanceof HTMLElement && !el.contains(root) && !el.inert && el.tagName !== 'SCRIPT' && el.id !== 'announcer') {
      el.inert = true;
      inerted.push(el);
    }
  }
  const closeBtn = h('button', { type: 'button', class: 'btn btn-secondary knife-roll-close' }, 'Close');
  const dialog = h('div', { class: 'knife-roll', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'knife-roll-title' },
    h('h2', { id: 'knife-roll-title', tabindex: -1 }, 'Your knife roll'),
    body,
    h('div', { class: 'knife-roll-buttons' }, closeBtn),
  );
  const backdrop = h('div', { class: 'overlay-backdrop' }, dialog);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    for (const el of inerted) el.inert = false;
    if (opener?.isConnected) opener.focus();
    onClose();
  };
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0]!, last = items[items.length - 1]!;
    const active = doc.activeElement;
    if (!dialog.contains(active)) { ev.preventDefault(); first.focus(); }
    else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  doc.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  dialog.querySelector<HTMLElement>('#knife-roll-title')!.focus();
  return close;
}

function kitchenScreen(): Screen {
  let cleanup: (() => void) | null = null;
  return {
    title: 'Your kitchen',
    mount(el, _route, ctx) {
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const stage = doc.getElementById('stage');
      let alive = true;
      let closeRoll: (() => void) | null = null;

      const backdropSlot = h('div', { class: 'kitchen-backdrop' });
      const bar = h('div', { class: 'kitchen-actions' });
      const greetingSlot = h('div', { class: 'kitchen-greeting' });
      el.replaceChildren(h('h1', null, 'Your kitchen'), greetingSlot, backdropSlot, bar);

      const showFallback = () => {
        if (!alive || backdropSlot.firstChild) return;
        backdropSlot.append(h('img', { class: 'kitchen-backdrop-img', src: assets['scene.kitchen']!, alt: '' }));
      };
      if (stage) {
        void showScene(stage, 'Kitchen').then((ok) => { if (!ok) showFallback(); });
      } else {
        showFallback();
      }

      const stopBar = renderActionBar(bar, [
        { id: 'talk', label: 'Talk to the Pan', run: () => getMentor().open() },
        { id: 'toolkit', label: 'Knife roll', run: () => { if (!closeRoll) closeRoll = openKnifeRoll(doc, ctx, () => { closeRoll = null; }); } },
        { id: 'recipes', label: 'Recipe shelf', run: () => ctx.navigate({ name: 'recipes' }) },
        { id: 'map', label: 'Go out to the world map', run: () => ctx.navigate({ name: 'map' }) },
      ]);

      if (!greeted) {
        greeted = true;
        const now = ctx.now();
        const { firstOpenedAt, lastOpenedAt } = ctx.store.get();
        const said = getMentor().say(greetingTrigger(now, firstOpenedAt, lastOpenedAt));
        ctx.store.update((s) => ({ ...s, firstOpenedAt: s.firstOpenedAt ?? now.toISOString(), lastOpenedAt: now.toISOString() }));
        void showDialogue(greetingSlot, {
          speaker: 'The Pan', portrait: assets['char.pan'] ?? null, lines: [said.text], reducedMotion: isReduced(ctx.store, win),
        });
      }

      cleanup = () => {
        alive = false;
        stopBar();
        closeRoll?.();
        if (stage) hideStage(stage);
      };
    },
    unmount() { cleanup?.(); cleanup = null; },
  };
}

export function registerKitchenScreen(): void { registerScreen('kitchen', kitchenScreen); }
