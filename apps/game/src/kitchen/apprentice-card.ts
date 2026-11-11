import type { ProgressView } from '@kitchenquest/core/engine';
import { h } from '../ui/dom';

/** Stamps are earned in M5 and spent nowhere until M10's cosmetics (Ruling 17): the card says so, with no price and no shop. */
const OUTFITTER_NOTE = "*Stamps are kept with your papers. The Bureau's outfitter opens later.";

/**
 * The apprentice's card in the kitchen: the level and the stamps, quietly. No bar to the next level, no XP still
 * to go, no streak, no daily target and no count of anything not yet done (Step 9, audit M-1). Step 11 adds the
 * Shared Table tally here.
 */
export function renderApprenticeCard(view: Pick<ProgressView, 'level' | 'stamps'>): HTMLElement {
  return h('section', { class: 'apprentice-card', 'aria-labelledby': 'apprentice-card-title' },
    h('h2', { id: 'apprentice-card-title', tabindex: -1 }, 'Your apprentice papers'),
    h('p', { class: 'apprentice-level' }, `Apprentice level ${view.level}`),
    h('p', { class: 'apprentice-stamps' }, view.stamps === 1 ? 'One Bureau Stamp' : `Bureau Stamps: ${view.stamps}`),
    h('p', { class: 'bureau-footnote' }, OUTFITTER_NOTE),
  );
}

/**
 * C1 ruling: progress played signed out on this device joins an account only after this explicit tap, never on
 * its own. "Not now" hides it for this page load.
 */
export function renderGuestOffer(opts: { add(): Promise<boolean>; dismiss(): void }): HTMLElement {
  const status = h('p', { class: 'guest-offer-status', role: 'status' });
  const add = h('button', { type: 'button', class: 'btn btn-primary', 'data-guest': 'add' }, 'Add it to my account');
  const later = h('button', { type: 'button', class: 'btn btn-secondary', 'data-guest': 'later', onclick: () => opts.dismiss() }, 'Not now');
  add.addEventListener('click', () => {
    add.disabled = true;
    later.disabled = true;
    void opts.add().then((ok) => {
      if (ok) return;
      add.disabled = false;
      later.disabled = false;
      status.textContent = "That didn't go through. Your progress is still on this device; try again later.";
    });
  });
  return h('section', { class: 'guest-offer', 'aria-labelledby': 'guest-offer-title' },
    h('h2', { id: 'guest-offer-title' }, "Add this device's progress to your account?"),
    h('p', null, 'What you cooked and learned here while signed out stays on this device unless you add it.'),
    h('div', { class: 'button-row' }, add, later), status);
}
