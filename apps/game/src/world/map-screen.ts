import { SCREEN_TITLES } from '../shell/titles';
import assets from 'virtual:kq-assets';
import { content } from '../content';
import type { CookFile } from '../content/types';
import { getMentor } from '../mentor';
import { type AppContext, type Screen } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { renderActionBar } from '../ui/action-bar';
import { showBureauForm } from '../ui/bureau-form';
import { contentText, h } from '../ui/dom';
import { mountBackdrop } from './backdrop';
import { MAP_PINS, PIN_STATE_TEXT, pinState, type PinState } from './pins';
import { questStatus } from '@kitchenquest/core/engine';
import { progressService } from '../progress';
import { introduced } from '../progress/announce';

/** Quest-offered letters already read out this page load (in memory only: nothing is kept for it). */
const offeredSaid = new Set<string>();

/** scene.map is 384×216; shown at 2x (integer), shrinking with the page. */
const MAP_WIDTH = 768;

const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(Math.random() * xs.length)]);

/** Form 9-T. Resolves true when the player stamped it. */
async function travelPermit(doc: Document, ctx: AppContext, cook: CookFile, state: PinState, signal: AbortSignal): Promise<boolean> {
  if (!Object.hasOwn(content.bureau.forms, 'travel')) throw new Error('forms.yaml has no travel form (9-T)');
  const travel = content.bureau.forms.travel;
  // Ruling 3: no introduction yet is never a lock. The permit says so, and its stamp reads "Travel anyway".
  const form = state === 'expecting' ? travel : { ...travel, buttons: { ...travel.buttons, confirm: 'Travel anyway' } };
  const answer = await showBureauForm(doc.getElementById('overlay-root') ?? doc.body, {
    form,
    values: {
      bearer: 'One (1) apprentice, plus pan',
      destination: cook.place,
      host: cook.name,
      status: state === 'expecting' ? 'Guest. Invited.' : 'Guest. Awaiting an introduction.',
      purpose: 'To learn, if taught',
    },
    footnote: pick(form.footnotes ?? []),
    reducedMotion: isReducedMotion(ctx.store, doc.defaultView!),
    stamps: content.bureau.stamps,
    signal,
  });
  return answer === 'confirm';
}

export function mapScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let gone = false;
  return {
    title: SCREEN_TITLES.map,
    async mount(el, _route, ctx) {
      const doc = el.ownerDocument;
      const svc = await progressService().catch((err: unknown) => { console.error(err); return null; });
      if (gone) return;
      const view = svc?.view() ?? null;
      const known = view ? introduced(view.trust) : new Set(Object.keys(content.cooks));
      let alive = true;
      let permitOpen = false;
      const leaving = new AbortController();

      const choose = async (cook: CookFile, pin: HTMLButtonElement) => {
        if (permitOpen) return;
        permitOpen = true;
        pin.focus(); // some browsers don't focus a clicked button; the form returns focus to whatever had it
        const state = pinState(cook.id, known);
        const go = await travelPermit(doc, ctx, cook, state, leaving.signal);
        permitOpen = false;
        if (!alive || !go) return;
        if (state === 'expecting') getMentor().say('travel.depart', { cook: cook.name, place: cook.place });
        else getMentor().say('quest.travel_anyway', { cook: cook.name });
        ctx.navigate({ name: 'visit', cookId: cook.id });
      };

      // Every cook is visitable (Ruling 3): no pin is locked. A cook whose dish the player's rules block stays on the map (§4.4).
      const labels: HTMLElement[] = [];
      const pins = Object.values(content.cooks).filter((c) => Object.hasOwn(MAP_PINS, c.id)).map((cook) => {
        const at = MAP_PINS[cook.id];
        const sprite = assets[`char.${cook.id}`];
        const state = pinState(cook.id, known);
        const label = h('span', { class: `map-pin-state pin-${state}`, id: `pin-state-${cook.id}`, 'data-state': state }, PIN_STATE_TEXT[state]);
        label.style.left = `${at.x}%`;
        label.style.top = `${at.y}%`;
        labels.push(label);
        const pin = h('button', { type: 'button', class: 'map-pin', 'data-cook': cook.id, 'data-state': state, 'aria-describedby': label.id },
          sprite ? h('img', { src: sprite, alt: '' }) : h('span', { class: 'map-pin-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'visually-hidden' }, 'Visit ', contentText('span', cook.name), ' — ', contentText('span', cook.place)));
        pin.style.left = `${at.x}%`;
        pin.style.top = `${at.y}%`;
        pin.addEventListener('click', () => { void choose(cook, pin); });
        return pin;
      });
      const layer = h('div', { class: 'map-pins' }, ...pins, ...labels);

      const backdropSlot = h('div', { class: 'map-backdrop' });
      const bar = h('div', { class: 'map-actions' });
      const footnote = pick(content.bureau.footnotes.filter((f) => f.tag === 'map'));
      el.replaceChildren(
        h('h1', null, 'World map'),
        backdropSlot,
        bar,
        ...(footnote ? [contentText('p', footnote.text, { class: 'map-footnote' })] : []),
      );

      let stopBar: (() => void) | null = null;
      const stopBackdrop = mountBackdrop(backdropSlot, { className: 'map-backdrop', src: assets['scene.map'], width: MAP_WIDTH, scene: 'Map', layer });
      // Set before anything else can throw: #stage now lives in this screen and must go home on unmount.
      cleanup = () => {
        alive = false;
        stopBar?.();
        stopBackdrop();
        // Leaving with the permit still open (the back button): decline it, so the page doesn't stay inert.
        leaving.abort();
      };
      // The quest-offered letter: a cook whose quest has just become open (its `unlock.requires` done) has written.
      if (view && !ctx.store.get().settings.familyTable) {
        const offered = Object.values(content.cooks).find((c) =>
          c.quest.unlock.requires.length > 0 && questStatus(c.quest, view) === 'open' && !offeredSaid.has(c.id));
        if (offered) { offeredSaid.add(offered.id); getMentor().say('quest.offered', { cook: offered.name }); }
      }
      stopBar = renderActionBar(bar, [
        { id: 'talk', label: 'Talk to the Pan', run: () => { const m = getMentor(); m.say('travel.map_remark'); m.open(); } },
        { id: 'home', label: 'Home kitchen', run: () => ctx.navigate({ name: 'kitchen' }) },
      ]);
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}

