import type { BureauForm } from '../content/types';
import { contentText, h } from './dom';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function showBureauForm(
  root: HTMLElement,
  opts: {
    form: BureauForm; values: Record<string, string>; footnote?: string; reducedMotion: boolean;
    /** The Bureau file's `stamps` map; the stamp text is `stamps[form.stamp]`. */
    stamps?: Record<string, string>;
  },
): Promise<'confirm' | 'decline'> {
  const { form } = opts;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Everything outside the dialog becomes inert (no focus, no clicks, hidden from screen readers).
  const inerted: HTMLElement[] = [];
  for (const el of Array.from(root.ownerDocument.body.children)) {
    if (el instanceof HTMLElement && !el.contains(root) && !el.inert && el.tagName !== 'SCRIPT' && el.id !== 'announcer') {
      el.inert = true;
      inerted.push(el);
    }
  }
  const titleId = 'bureau-form-title';

  return new Promise((resolve) => {
    let settled = false;
    const finish = (answer: 'confirm' | 'decline') => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      for (const el of inerted) el.inert = false;
      opener?.focus();
      resolve(answer);
    };

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
      dl,
      opts.footnote ? contentText('p', opts.footnote, { class: 'bureau-footnote' }) : null,
      h('div', { class: 'bureau-buttons' }, confirmBtn, declineBtn),
      stampEl,
    );
    const backdrop = h('div', { class: 'overlay-backdrop' }, dialog);
    const doc = root.ownerDocument;

    function onKey(ev: KeyboardEvent) {
      if (settled) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish('decline'); return; }
      if (ev.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !(e as HTMLButtonElement).disabled);
      if (items.length === 0) { ev.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = doc.activeElement;
      if (!dialog.contains(active)) { ev.preventDefault(); first.focus(); }
      else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
    }

    doc.addEventListener('keydown', onKey, true);
    root.append(backdrop);
    // Focus the heading, not Confirm: a stray Enter or Space must never stamp a safety form.
    dialog.querySelector<HTMLElement>(`#${titleId}`)!.focus();
  });
}
