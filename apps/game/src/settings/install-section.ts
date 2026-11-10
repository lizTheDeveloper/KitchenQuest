import { content } from '../content';
import { createDialogue } from '../mentor';
import { installOffer, iosNoteVisible, isIos, isStandalone } from '../pwa/install';
import type { PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';

function env(win: Window): { ios: boolean; standalone: boolean } {
  return { ios: isIos(win.navigator.userAgent, win.navigator.maxTouchPoints), standalone: isStandalone(win) };
}

/** One Pan line per page load, so the kitchen and Settings say the same thing. Kept in memory only. */
let iosLine: string | null = null;

/**
 * The Bureau's slip explaining Add to Home Screen on iPhone and iPad, or null when it shouldn't show.
 * "Got it" dismisses it for good on this device.
 */
export function iosNote(win: Window, store: PlayerStore, headingLevel: 'h2' | 'h3'): HTMLElement | null {
  if (!iosNoteVisible(store.get().settings, env(win))) return null;
  iosLine ??= createDialogue(content.pan).say('intake.ios_home_screen').text;
  const ok = h('button', { type: 'button', class: 'btn btn-primary' }, 'Got it');
  const note = h('section', { class: 'ios-note', 'aria-label': 'Add to Home Screen' },
    h(headingLevel, { class: 'ios-note-title' }, 'Add to Home Screen'),
    h('p', { class: 'ios-note-speaker' }, 'The Pan says:'),
    contentText('p', iosLine, { class: 'ios-note-line' }),
    ok);
  ok.addEventListener('click', () => {
    note.remove();
    store.update((s) => ({ ...s, settings: { ...s.settings, iosNoteDismissed: true } }));
  });
  return note;
}

/** Settings → Install. Returns the section and a function to stop following the browser's install offer. */
export function installSection(win: Window, store: PlayerStore): { el: HTMLElement; stop: () => void } {
  const body = h('div', { id: 'install-section' });
  const render = () => {
    const e = env(win);
    if (e.standalone) { body.replaceChildren(h('p', null, 'Installed.')); return; }
    if (e.ios) {
      body.replaceChildren(iosNote(win, store, 'h3') ??
        h('p', null, "On an iPhone or iPad, tap Share, then 'Add to Home Screen'."));
      return;
    }
    if (installOffer.available()) {
      const btn = h('button', { type: 'button', class: 'btn btn-primary', id: 'install-app' }, 'Install Kitchen Quest');
      btn.addEventListener('click', () => { void installOffer.prompt(); });
      body.replaceChildren(btn);
      return;
    }
    body.replaceChildren(h('p', null, 'Kitchen Quest works offline once it has loaded. If your browser offers to install it, a button will appear here.'));
  };
  render();
  const stop = installOffer.subscribe(render);
  const el = h('section', { class: 'panel', 'aria-labelledby': 'set-install' }, h('h2', { id: 'set-install' }, 'Install'), body);
  return { el, stop };
}
