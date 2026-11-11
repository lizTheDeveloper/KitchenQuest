import type { BureauForm } from '../content/types';
import { contentText, h } from './dom';
import { inertOthers, trapFocus } from './focus-trap';

export function showBureauForm(
  root: HTMLElement,
  opts: {
    form: BureauForm; values: Record<string, string>; footnote?: string; reducedMotion: boolean;
    /** Written text shown above the fields (Step 11: `rule.void_confirm` before a severe rule is removed). */
    lead?: string;
    /** The Bureau file's `stamps` map; the stamp text is `stamps[form.stamp]`. */
    stamps?: Record<string, string>;
    /** Aborted when the screen behind it goes away (the back button): the form is declined and removed. */
    signal?: AbortSignal;
  },
): Promise<'confirm' | 'decline'> {
  const { form } = opts;
  if (opts.signal?.aborted) return Promise.resolve('decline');
  const doc = root.ownerDocument;
  const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
  // Everything outside the dialog becomes inert (no focus, no clicks, hidden from screen readers).
  const restoreInert = inertOthers(root);
  const titleId = 'bureau-form-title';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: 'confirm' | 'decline', aborted = false) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      opts.signal?.removeEventListener('abort', onAbort);
      backdrop.remove();
      restoreInert();
      if (!aborted) opener?.focus(); // leaving: the next screen owns focus
      resolve(answer);
    };
    const onAbort = () => finish('decline', true);
    opts.signal?.addEventListener('abort', onAbort);

    const confirmBtn = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-primary' });
    const declineBtn = form.buttons.decline
      ? contentText('button', form.buttons.decline, { type: 'button', class: 'btn btn-secondary', onclick: () => finish('decline') })
      : null;
    const stampText = opts.stamps?.[form.stamp] ?? form.stamp.toUpperCase();
    const stampEl = contentText('div', stampText, { class: 'bureau-stamp', 'aria-hidden': 'true' });

    confirmBtn.addEventListener('click', () => {
      if (settled) return;
      if (opts.reducedMotion) { finish('confirm'); return; }
      confirmBtn.disabled = true;
      if (declineBtn) declineBtn.disabled = true;
      dialog.classList.add('is-stamping');
      setTimeout(() => finish('confirm'), 650);
    });

    const dl = h('dl', { class: 'bureau-fields' });
    for (const f of form.fields) {
      dl.append(
        h('div', { class: 'bureau-field' },
          contentText('dt', f.label),
          h('dd', null,
            h('span', { class: 'bureau-value' }, opts.values[f.key] ?? '—'),
            f.hint ? contentText('span', f.hint, { class: 'bureau-hint' }) : null)),
      );
    }

    const dialog = h('div', { class: 'bureau-form', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`),
      contentText('h2', form.title, { id: titleId, class: 'bureau-title', tabindex: -1 }),
      form.title_aside ? contentText('p', form.title_aside, { class: 'bureau-aside' }) : null,
      opts.lead ? contentText('p', opts.lead, { class: 'bureau-lead' }) : null,
      dl,
      opts.footnote ? contentText('p', opts.footnote, { class: 'bureau-footnote' }) : null,
      h('div', { class: 'bureau-buttons' }, confirmBtn, declineBtn),
      stampEl,
    );
    const backdrop = h('div', { class: 'overlay-backdrop' }, dialog);

    function onKey(ev: KeyboardEvent) {
      if (settled) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish('decline'); return; }
      trapFocus(dialog, ev);
    }

    doc.addEventListener('keydown', onKey, true);
    root.append(backdrop);
    // Focus the heading, not Confirm: a stray Enter or Space must never stamp a safety form.
    dialog.querySelector<HTMLElement>(`#${titleId}`)!.focus();
  });
}
