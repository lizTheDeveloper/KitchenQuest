import type { BureauForm } from '../content/types';
import { contentText, h } from '../ui/dom';
import { bureauSlip } from './cards-view';

let seq = 0;

/**
 * A consent card in the Pan panel (Form 3-C): the API's notice text verbatim, never rewritten (C-30 draft wording),
 * in a `[data-content]` element, with the form's own buttons. Saying no costs nothing: play goes on.
 */
export function renderConsentCard(purpose: 'health_data' | 'ai_health' | 'voice', opts: {
  form: BureauForm; notice: { version: string; text: string }; onAgree(): void | Promise<void>; onDecline(): void;
}): HTMLElement {
  const { form } = opts;
  const label = form.fields.find((f) => f.key === 'notice')?.label ?? 'What this covers';
  // Fix round 1 (I2): agreeing and saying no look the same; neither is the "default" choice.
  const agree = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-secondary consent-agree' });
  const decline = contentText('button', form.buttons.decline ?? 'Not now', { type: 'button', class: 'btn btn-secondary consent-decline' });
  const el = bureauSlip(form, `consent-title-${++seq}`,
    h('dl', { class: 'bureau-fields' },
      h('div', { class: 'bureau-field' }, contentText('dt', label), h('dd', null, contentText('p', opts.notice.text, { class: 'consent-notice' })))),
    ...(form.footnotes ?? []).slice(0, 1).map((f) => contentText('p', f, { class: 'bureau-footnote' })),
    h('div', { class: 'bureau-buttons' }, agree, decline));
  el.classList.add('consent-card');
  el.dataset.purpose = purpose;
  let busy = false;
  agree.addEventListener('click', () => {
    if (busy) return;
    busy = true;
    agree.disabled = true;
    decline.disabled = true;
    void Promise.resolve(opts.onAgree()).finally(() => { busy = false; agree.disabled = false; decline.disabled = false; });
  });
  decline.addEventListener('click', () => { if (!busy) opts.onDecline(); });
  return el;
}
