import { getMentor, getMentorServices } from '../mentor';
import { routeHref } from '../shell/router';
import { contentText, h } from '../ui/dom';
import type { WeekFailure } from './source';

/**
 * Pieces the week screens share (M5 Step 10): the screen's status line and what a refused week write shows. Plans
 * and runs are health data (Step 6 ruling): a 403 `consent_required` opens the Pan with the health consent card,
 * exactly as a refused rule card does.
 */

/** The polite status line under a week screen's heading: written lines only. */
export function statusLine(id?: string): { el: HTMLElement; show(text: string): void } {
  const el = h('p', { class: 'week-note', role: 'status', 'data-content': '', ...(id ? { id, tabindex: -1 } : {}) });
  return { el, show(text) { el.textContent = text; } };
}

/** A consent card's answer handler that runs `fn` only on a grant (never on "Not now" or a notice that didn't load). */
export const grantedOnly = (fn?: () => void) => (answer: string): void => { if (answer === 'granted') fn?.(); };

/** Open the Pan with `consent.health_first` and the health consent card; `onGranted` runs once it is filed. */
export function askHealthConsent(onGranted?: () => void): void {
  const { dialogue } = getMentorServices();
  const pan = getMentor();
  const onAnswer = grantedOnly(onGranted);
  pan.show({ items: [{ kind: 'said', said: dialogue.say('consent.health_first') }, { kind: 'consent', purpose: 'health_data', onAnswer }], cards: [], intents: [], actions: [], notice: null });
  pan.open();
}

const NOT_DONE = "That didn't go through, so nothing changed. Try again in a moment.";
const RULES_TEXT = "Your rules couldn't be read just now, so nothing is checked or saved. Open Your rules to look them over.";

/** What a refused week write shows: the consent card, a rules link, or a plain line. Never silent. */
export function showFailure(f: WeekFailure, status: { show(text: string): void }, line: (t: string, v: Record<string, string>) => string): void {
  switch (f.kind) {
    case 'consent': status.show(line('consent.health_first', {})); askHealthConsent(); return;
    case 'rules': status.show(RULES_TEXT); return;
    case 'family_table': return; // nothing is written in Family Table mode, and no control asks to (C31)
    case 'limited': status.show(line('write.daily_limit', {})); return; // M5 final m2: paused until tomorrow
    case 'closed':
    case 'invalid':
    case 'network': status.show(NOT_DONE); return;
  }
}

/** The link under a rules error. */
export const rulesLink = (): HTMLElement => h('p', null, h('a', { href: routeHref({ name: 'rules' }) }, 'Open Your rules'));

/** A week screen's footnote from its Bureau form (content). */
export const footnote = (text: string): HTMLElement => contentText('p', text, { class: 'bureau-footnote' });
