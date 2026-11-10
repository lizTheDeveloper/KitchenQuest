import { h } from './dom';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
  const inerted: HTMLElement[] = [];
  for (const el of Array.from(doc.body.children)) {
    if (el instanceof HTMLElement && !el.contains(root) && !el.inert && el.tagName !== 'SCRIPT' && el.id !== 'announcer') {
      el.inert = true;
      inerted.push(el);
    }
  }
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
    for (const el of inerted) el.inert = false;
    if (opts.opener?.isConnected) opts.opener.focus();
    opts.onClose();
  };
  function onKey(ev: KeyboardEvent) {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return; }
    if (ev.key !== 'Tab') return;
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !(e as HTMLButtonElement).disabled);
    const first = items[0], last = items[items.length - 1];
    const active = doc.activeElement;
    if (!dialog.contains(active)) { ev.preventDefault(); first.focus(); }
    else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) close(); });
  doc.addEventListener('keydown', onKey, true);
  root.append(backdrop);
  opts.title.focus();
  return close;
}
