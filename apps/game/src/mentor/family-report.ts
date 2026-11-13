// M7 Ruling 17: the device's Family Table report to the API (per device since Step 9 fix round 2). A lazy module:
// mountMentor loads it after first paint.
import type { ApiClient } from '../api/client';
import { deviceId } from '../state/device-id';
import type { PlayerState, PlayerStore } from '../state/store';

/** Fix round 1 (I-4): a Family Table report that failed is sent again after this long, doubling to the cap. */
const FAMILY_TABLE_RETRY_MS = 5_000;
const FAMILY_TABLE_RETRY_MAX_MS = 300_000;

/**
 * M7 Ruling 17: the device's Family Table setting goes to the API's per-user voice block now (a signed-in start), on
 * every change, and on signing in, so the server refuses voice even if a device bug opened a socket. Signed out there is
 * no account to block. Fix round 1 (I-4): only a 2xx confirms a report; a failed one (offline, a 429, a 5xx, a throw) is
 * sent again with a growing backoff, and at once on `online`, until it lands, the setting changes or the player signs
 * out. Meanwhile the device itself refuses the microphone in Family Table (the controller throws; talk.ts hides), so
 * the guarantee never rests on the report alone. Fix round 2: every report names this install (`deviceId`), and the
 * server lifts the block only when the device that set it reports off, so a second device's start-up `{on:false}`
 * clears nothing. Returns the unsubscribe.
 */
export function reportFamilyTable(
  store: PlayerStore, client: Pick<ApiClient, 'setFamilyTable'>,
  opts: {
    setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void; events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
    /** Fix round 2: this install's id (state/device-id.ts), so the server's block is per device. */
    deviceId?: () => string;
  } = {},
): () => void {
  const device = opts.deviceId ?? (() => deviceId());
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t: unknown) => { clearTimeout(t as ReturnType<typeof setTimeout>); });
  const keyOf = (s: PlayerState) => (s.account === null ? null : `${s.account.email}|${String(s.settings.familyTable)}`);
  let confirmed: string | null = null;
  let sending: string | null = null;
  let timer: unknown = null;
  let backoff = FAMILY_TABLE_RETRY_MS;
  const stopTimer = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const attempt = () => {
    const s = store.get();
    const key = keyOf(s);
    // Fix round 3 (N-5): one report at a time, so the server hears them in order; the next goes once this settles.
    if (key === null || key === confirmed || sending !== null) return;
    stopTimer();
    sending = key;
    /** done: the answer is final (a 2xx; or N-4, a 4xx other than 429: 404 is a server without voice, 400 a bad report). */
    const settle = (done: boolean) => {
      sending = null;
      if (done) { confirmed = key; backoff = FAMILY_TABLE_RETRY_MS; }
      const now = keyOf(store.get());
      if (now !== key) { attempt(); return; } // the setting or the account moved on meanwhile: report that now
      if (done) return;
      timer = setTimer(() => { timer = null; attempt(); }, backoff);
      backoff = Math.min(backoff * 2, FAMILY_TABLE_RETRY_MAX_MS);
    };
    const retryable = (status: number) => status === 0 || status === 429 || status >= 500;
    client.setFamilyTable(s.settings.familyTable, device()).then((r) => { settle(r.ok || !retryable(r.status)); }, () => { settle(false); });
  };
  const onStore = (s: PlayerState) => {
    const key = keyOf(s);
    if (key === null) { stopTimer(); confirmed = null; backoff = FAMILY_TABLE_RETRY_MS; return; }
    if (key === confirmed) { stopTimer(); return; }
    if (timer !== null && sending === null && key === lastTried) return; // waiting out the backoff for this report
    if (key !== lastTried) { backoff = FAMILY_TABLE_RETRY_MS; stopTimer(); }
    lastTried = key;
    attempt();
  };
  let lastTried: string | null = keyOf(store.get());
  const onOnline = () => { if (timer !== null) { stopTimer(); attempt(); } };
  const events = opts.events ?? (typeof window === 'undefined' ? undefined : window);
  events?.addEventListener('online', onOnline);
  attempt();
  const unsubscribe = store.subscribe(onStore);
  return () => { unsubscribe(); stopTimer(); events?.removeEventListener('online', onOnline); };
}
