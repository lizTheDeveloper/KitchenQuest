import { toolkitRows, type ToolkitState } from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import { content, techniqueName } from '../content';
import { createDialogue, getMentor } from '../mentor';
import { localDate } from '../recipes/rules';
import { hideStage, showScene } from '../scenes/phaser-host';
import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { progressService } from '../progress';
import { iosNote } from '../settings/install-section';
import { renderActionBar } from '../ui/action-bar';
import { showDialogue } from '../ui/dialogue-box';
import { h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { greetingTrigger } from '../world/greeting';
import { renderToolkit } from './toolkit-view';

/** The Pan greets once per page load, on the first kitchen visit. */
let greeted = false;
/** Rusty invitations draw from their own in-memory history: the knife roll never writes to the store. */
let invites: ReturnType<typeof createDialogue> | null = null;

/** The knife roll: a modal dialog over everything else. Returns a function that closes it. Its rows come from progress (Ruling 7). */
function openKnifeRoll(doc: Document, ctx: AppContext, toolkit: ToolkitState, onClose: () => void): () => void {
  // Opened from a canvas hotspot, focus is on the body: return it to the knife roll's own button instead.
  const active = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
  const opener = active ?? doc.querySelector<HTMLElement>('[data-action="toolkit"]');
  invites ??= createDialogue(content.pan);
  const rows = toolkitRows(toolkit, localDate(ctx.now()), content.techniques.freshness);
  const body = renderToolkit(rows, {
    name: techniqueName,
    rustyLine: (technique) => invites!.say('toolkit.rusty_invite', { technique }).text,
  });

  return openModal(doc, { className: 'knife-roll', title: h('h2', null, 'Your knife roll'), body, opener, onClose });
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
      const leaving = new AbortController(); // settles a greeting still on screen when the player leaves
      let closeRoll: (() => void) | null = null;

      const backdropSlot = h('div', { class: 'kitchen-backdrop' });
      const bar = h('div', { class: 'kitchen-actions' });
      const greetingSlot = h('div', { class: 'kitchen-greeting' });
      const cardSlot = h('div', { class: 'apprentice-slot' });
      el.replaceChildren(h('h1', null, 'Your kitchen'), greetingSlot, backdropSlot, bar, cardSlot);
      // The apprentice card and the knife roll read progress, which loads after first paint (Step 9.3).
      let stopCard: (() => void) | null = null;
      void Promise.all([progressService(), import('./apprentice-card')]).then(([svc, { renderApprenticeCard }]) => {
        if (!alive) return;
        const draw = () => { cardSlot.replaceChildren(renderApprenticeCard(svc.view())); };
        draw();
        stopCard = svc.subscribe(draw);
      }, (err: unknown) => { console.error(err); });
      let rollOpening = false;
      const openRoll = () => {
        if (closeRoll || rollOpening) return;
        rollOpening = true;
        void progressService().then((svc) => {
          rollOpening = false;
          if (!alive || closeRoll) return;
          closeRoll = openKnifeRoll(doc, ctx, svc.view().toolkit, () => { closeRoll = null; });
        }, (err: unknown) => { rollOpening = false; console.error(err); });
      };
      const note = iosNote(win, ctx.store, 'h2');
      if (note) bar.after(note);

      const showFallback = () => {
        if (!alive || backdropSlot.firstChild) return;
        backdropSlot.append(h('img', { class: 'kitchen-backdrop-img', src: assets['scene.kitchen'], alt: '' }));
      };
      if (stage) {
        void showScene(stage, 'Kitchen').then((ok) => { if (!ok) showFallback(); });
      } else {
        showFallback();
      }

      const stopBar = renderActionBar(bar, [
        { id: 'talk', label: 'Talk to the Pan', run: () => getMentor().open() },
        { id: 'toolkit', label: 'Knife roll', run: openRoll },
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
          speaker: 'The Pan', portrait: assets['char.pan'] ?? null, lines: [said.text], reducedMotion: isReducedMotion(ctx.store, win),
          signal: leaving.signal,
        });
      }

      cleanup = () => {
        alive = false;
        leaving.abort();
        stopBar();
        stopCard?.();
        closeRoll?.();
        if (stage) hideStage(stage);
      };
    },
    unmount() { cleanup?.(); cleanup = null; },
  };
}

export function registerKitchenScreen(): void { registerScreen('kitchen', kitchenScreen); }
