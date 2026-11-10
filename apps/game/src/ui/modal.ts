import { h } from './dom';
import { inertOthers, trapFocus } from './focus-trap';

/**
 * A modal dialog over everything else: the rest of the page goes inert, Tab stays inside, Escape, the Close
 * button or a click on the backdrop closes it, and focus returns to `opener`. `title` is the dialog's heading
 * and gets focus when it opens; it goes first unless `body` already holds it. Returns a function that closes it.
 */
export function openModal(
  doc: Document,
  opts: { className: string; title: HTMLElement; body: Node; opener: HTMLElement | null; onClose(): void },
): () => void {
  const root = doc.getElementById('overlay-root') ?? doc.body;
  const restoreInert = inertOthers(root);
  const titleId = `${opts.className}-title`;
  opts.title.id = titleId;
  opts.title.tabIndex = -1;
  const closeBtn = h('button', { type: 'button', class: `btn btn-secondary ${opts.className}-close` }, 'Close');
  const dialog = h('div', { class: opts.className, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    opts.body.contains(opts.title) ? null : opts.title,
    opts.body,
    h('div', { class: `${opts.className}-buttons` }, closeBtn),
  );
  const backdrop = h('div', { class: 'overlay-backdrop' }, dialog);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    restoreInert();
    if (opts.opener?.isConnected) opts.opener.focus();
    opts.onClose();
  };
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    trapFocus(dialog, ev);
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  doc.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  opts.title.focus();
  return close;
}
