const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Make everything in `root`'s document outside `root` inert (no focus, no clicks, hidden from screen readers),
 * except scripts and the live #announcer. Returns a function that undoes exactly what it changed.
 */
export function inertOthers(root: HTMLElement): () => void {
  const inerted: HTMLElement[] = [];
  for (const el of Array.from(root.ownerDocument.body.children)) {
    if (el instanceof HTMLElement && !el.contains(root) && !el.inert && el.tagName !== 'SCRIPT' && el.id !== 'announcer') {
      el.inert = true;
      inerted.push(el);
    }
  }
  return () => { for (const el of inerted) el.inert = false; };
}

/**
 * Keep Tab inside `container`: call from a keydown handler. Wraps at both ends, pulls focus back in when it is
 * outside, and holds it still when nothing inside can take it. Returns true when the key was a Tab.
 */
export function trapFocus(container: HTMLElement, ev: KeyboardEvent): boolean {
  if (ev.key !== 'Tab') return false;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((e) => !(e as HTMLButtonElement).disabled);
  if (items.length === 0) { ev.preventDefault(); return true; }
  const first = items[0], last = items[items.length - 1];
  const active = container.ownerDocument.activeElement;
  if (!container.contains(active)) { ev.preventDefault(); first.focus(); }
  else if (ev.shiftKey && active === first) { ev.preventDefault(); last.focus(); }
  else if (!ev.shiftKey && active === last) { ev.preventDefault(); first.focus(); }
  return true;
}
