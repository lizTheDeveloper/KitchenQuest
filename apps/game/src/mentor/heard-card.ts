// M7 Step 9: the heard card (Ruling 4, §7.6). The words a transcript named, exactly as heard and spelled by code
// (§7.6b.2), each with up to MAX_ALTERNATIVES sound-alikes as chips. Only a tap on its buttons goes on: no spoken or
// typed yes ever confirms it (Ruling 12: heard cards are tap-only), and the card says so. Lazy: only voice draws it.
import type { HeardCheck } from '@kitchenquest/core/engine';
import { h } from '../ui/dom';

let seq = 0;
/** The button labels (Ruling 4), and the card's own tap-only note. */
export const HEARD_YES = "Yes, that's what I said";
export const HEARD_AGAIN = 'Say it again';
export const HEARD_TYPE = 'Type it instead';
export const HEARD_TAP_ONLY = 'Only a tap on this card confirms it; saying "yes" doesn\'t.';

/** "S-E-S-A-M-E" read letter by letter: "S, E, S, A, M, E"; words apart: "P, I, N, E, then N, U, T". */
export const spokenSpelling = (spelled: string): string => spelled.split(' ').map((w) => w.split('-').join(', ')).join(', then ');

export function renderHeardCard(check: HeardCheck, on: { yes(choice: (number | null)[]): void; again(): void; type(): void }): HTMLElement {
  const titleId = `heard-title-${++seq}`;
  const choice: (number | null)[] = check.terms.map(() => null);
  const terms = check.terms.map((t, i) => {
    const chips = t.alternatives.map((a, k) => {
      const chip = h('button', { type: 'button', class: 'btn btn-secondary heard-alt', 'aria-pressed': 'false' }, a.name);
      chip.setAttribute('aria-label', `${a.name}, spelled ${spokenSpelling(a.spelled)}`);
      chip.addEventListener('click', () => {
        // One alternative per term, or none (the words as heard): tapping the chosen one again clears it.
        choice[i] = choice[i] === k ? null : k;
        chips.forEach((c, n) => { c.setAttribute('aria-pressed', String(choice[i] === n)); });
      });
      return chip;
    });
    return h('li', { class: 'heard-term' },
      h('p', { class: 'heard-words' },
        h('strong', { class: 'heard-said' }, t.heard),
        ' ',
        h('span', { class: 'heard-spelled', 'aria-label': `spelled ${spokenSpelling(t.spelled)}` }, t.spelled)),
      chips.length === 0 ? null : h('div', { class: 'button-row heard-alts', role: 'group', 'aria-label': `Or did you say` }, ...chips));
  });
  const yes = h('button', { type: 'button', class: 'btn btn-primary heard-yes' }, HEARD_YES);
  const again = h('button', { type: 'button', class: 'btn btn-secondary heard-again' }, HEARD_AGAIN);
  const type = h('button', { type: 'button', class: 'btn btn-secondary heard-type' }, HEARD_TYPE);
  const all = () => [yes, again, type];
  const done = (fn: () => void) => () => { for (const b of all()) b.disabled = true; fn(); };
  yes.addEventListener('click', done(() => { on.yes([...choice]); }));
  again.addEventListener('click', done(() => { on.again(); }));
  type.addEventListener('click', done(() => { on.type(); }));
  return h('section', { class: 'pan-card heard-card', 'aria-labelledby': titleId },
    h('h3', { id: titleId, class: 'bureau-title' }, 'What I heard'),
    h('ul', { class: 'heard-terms' }, ...terms),
    h('p', { class: 'heard-note' }, HEARD_TAP_ONLY),
    h('div', { class: 'button-row' }, yes, again, type));
}
