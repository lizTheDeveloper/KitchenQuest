/** How long the live region stays empty before the new message, so screen readers hear a repeat as new. */
export const ANNOUNCE_GAP_MS = 50;

const pending = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * Say `message` through a live region (#announcer). The region is cleared first and the message set a moment
 * later: setting both in one task is coalesced, so an identical message (a second timer done) would be silent.
 */
export function announce(region: HTMLElement | null, message: string): void {
  if (!region) return;
  const waiting = pending.get(region);
  if (waiting !== undefined) clearTimeout(waiting);
  region.textContent = '';
  pending.set(region, setTimeout(() => { pending.delete(region); region.textContent = message; }, ANNOUNCE_GAP_MS));
}
