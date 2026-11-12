import { toolkitRows, type ToolkitState } from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import { content, techniqueName } from '../content';
import { createDialogue, getMentor, getMentorServices } from '../mentor';
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

/** "Not now" on the guest-progress offer (C1 ruling) lasts for this page load. */
let guestOfferDismissed = false;
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
      // Use-It-Up Rescue (M5 Step 10): at most one offer a day, only while the kitchen is open. Its code loads after first paint.
      const rescueSlot = h('div', { class: 'rescue-slot' });
      el.replaceChildren(h('h1', null, 'Your kitchen'), greetingSlot, backdropSlot, bar, rescueSlot, cardSlot);
      void import('../week/rescue-slot')
        .then(({ mountRescue }) => mountRescue(rescueSlot, ctx, getMentorServices().client, () => alive))
        .catch((err: unknown) => { console.error(err); });
      // The apprentice card and the knife roll read progress, which loads after first paint (Step 9.3).
      let stopCard: (() => void) | null = null;
      // The Shared Table tally (Step 11, C21): counts only, signed in only, read once per visit after first paint.
      let shared: number | null = null;
      const email = ctx.store.get().account?.email ?? null;
      void Promise.all([progressService(), import('./apprentice-card')]).then(([svc, { renderApprenticeCard, renderGuestOffer, sharedCount }]) => {
        if (!alive) return;
        const draw = () => {
          const offer = !guestOfferDismissed && svc.sync.guestOffer()
            ? renderGuestOffer({ add: () => { const p = svc.sync.addGuestProgress(); draw(); return p; }, dismiss: () => { guestOfferDismissed = true; draw(); } })
            : null;
          if (offer === null && cardSlot.querySelector('.guest-offer')?.contains(doc.activeElement)) cardSlot.querySelector<HTMLElement>('.apprentice-card h2')?.focus();
          cardSlot.replaceChildren(renderApprenticeCard(svc.view(), shared), ...(offer ? [offer] : []));
        };
        draw();
        stopCard = svc.subscribe(draw);
        if (email !== null && !ctx.store.get().settings.familyTable) {
          void getMentorServices().client.sharedTally().then((r) => {
            if (!alive || !r.ok || (ctx.store.get().account?.email ?? null) !== email) return;
            shared = sharedCount(r.data);
            draw();
          });
        }
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
        // The Recipe Book on the shelf (Step 11): an HTML control now; its sprite slot is M10's.
        { id: 'book', label: 'Recipe Book', run: () => ctx.navigate({ name: 'book', slug: null }) },
        { id: 'week', label: 'This week', run: () => ctx.navigate({ name: 'plan' }) },
        // The market hub (M6 Step 9): practice at the stalls, any day. Its screens load on first visit.
        { id: 'market', label: 'The Market', run: () => ctx.navigate({ name: 'stalls' }) },
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
