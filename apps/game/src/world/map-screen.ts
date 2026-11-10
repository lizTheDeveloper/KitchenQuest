import assets from 'virtual:kq-assets';
import { content } from '../content';
import type { CookFile } from '../content/types';
import { getMentor } from '../mentor';
import { registerScreen, type AppContext, type Screen } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { renderActionBar } from '../ui/action-bar';
import { showBureauForm } from '../ui/bureau-form';
import { contentText, h } from '../ui/dom';
import { mountBackdrop } from './backdrop';
import { MAP_PINS } from './pins';

/** scene.map is 384×216; shown at 2x (integer), shrinking with the page. */
const MAP_WIDTH = 768;

const pick = <T>(xs: readonly T[]): T | undefined => (xs.length === 0 ? undefined : xs[Math.floor(Math.random() * xs.length)]);

/** Form 9-T. Resolves true when the player stamped it. */
async function travelPermit(doc: Document, ctx: AppContext, cook: CookFile, signal: AbortSignal): Promise<boolean> {
  if (!Object.hasOwn(content.bureau.forms, 'travel')) throw new Error('forms.yaml has no travel form (9-T)');
  const form = content.bureau.forms.travel;
  const answer = await showBureauForm(doc.getElementById('overlay-root') ?? doc.body, {
    form,
    values: {
      bearer: 'One (1) apprentice, plus pan',
      destination: cook.place,
      host: cook.name,
      status: 'Guest. Invited.',
      purpose: 'To learn, if taught',
    },
    footnote: pick(form.footnotes ?? []),
    reducedMotion: isReducedMotion(ctx.store, doc.defaultView!),
    stamps: content.bureau.stamps,
    signal,
  });
  return answer === 'confirm';
}

function mapScreen(): Screen {
  let cleanup: (() => void) | null = null;
  return {
    title: 'World map',
    mount(el, _route, ctx) {
      const doc = el.ownerDocument;
      let alive = true;
      let permitOpen = false;
      const leaving = new AbortController();

      const choose = async (cook: CookFile, pin: HTMLButtonElement) => {
        if (permitOpen) return;
        permitOpen = true;
        pin.focus(); // some browsers don't focus a clicked button; the form returns focus to whatever had it
        const go = await travelPermit(doc, ctx, cook, leaving.signal);
        permitOpen = false;
        if (!alive || !go) return;
        getMentor().say('travel.depart', { cook: cook.name, place: cook.place });
        ctx.navigate({ name: 'visit', cookId: cook.id });
      };

      // Every cook is open to visit in M3. A cook whose dish the player's rules block stays on the map (§4.4).
      const pins = Object.values(content.cooks).filter((c) => Object.hasOwn(MAP_PINS, c.id)).map((cook) => {
        const at = MAP_PINS[cook.id];
        const sprite = assets[`char.${cook.id}`];
        const pin = h('button', { type: 'button', class: 'map-pin', 'data-cook': cook.id },
          sprite ? h('img', { src: sprite, alt: '' }) : h('span', { class: 'map-pin-dot', 'aria-hidden': 'true' }),
          h('span', { class: 'visually-hidden' }, 'Visit ', contentText('span', cook.name), ' — ', contentText('span', cook.place)));
        pin.style.left = `${at.x}%`;
        pin.style.top = `${at.y}%`;
        pin.addEventListener('click', () => { void choose(cook, pin); });
        return pin;
      });
      const layer = h('div', { class: 'map-pins' }, ...pins);

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
      stopBar = renderActionBar(bar, [
        { id: 'talk', label: 'Talk to the Pan', run: () => { const m = getMentor(); m.say('travel.map_remark'); m.open(); } },
        { id: 'home', label: 'Home kitchen', run: () => ctx.navigate({ name: 'kitchen' }) },
      ]);
    },
    unmount() { cleanup?.(); cleanup = null; },
  };
}

export function registerMapScreen(): void { registerScreen('map', mapScreen); }
