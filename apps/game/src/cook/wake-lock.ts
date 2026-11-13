export type WakeState = 'on' | 'off' | 'unsupported' | 'denied';

interface Sentinel { release(): Promise<void>; addEventListener?(type: 'release', fn: () => void): void }
interface WakeLockApi { request(type: 'screen'): Promise<Sentinel> }

/**
 * Keeps the screen awake while cooking. The browser drops the lock when the tab is hidden, so it is
 * taken again when the tab becomes visible, for as long as it is enabled.
 * M7 Step 10: hands-free cook mode also holds it (`hold`): the lock stays while either the player's toggle or a hold
 * wants it, so turning "Keep screen awake" off mid hands-free keeps the screen on until hands-free ends.
 */
export function createWakeLock(nav: Navigator, doc: Document, onChange?: (s: WakeState) => void) {
  let state: WakeState = 'off';
  let enabled = false;
  let user = false;
  let held = false;
  let sentinel: Sentinel | null = null;
  let pending = false;
  const set = (s: WakeState) => { if (s !== state) { state = s; onChange?.(s); } };

  async function acquire(): Promise<WakeState> {
    const api = (nav as unknown as { wakeLock?: WakeLockApi }).wakeLock;
    if (!api) { set('unsupported'); return state; }
    if (pending || sentinel) return state;
    pending = true;
    try {
      const s = await api.request('screen');
      const old = sentinel as Sentinel | null;
      if (old) await old.release().catch(() => {}); // never leave an earlier lock behind
      if (!enabled) { await s.release().catch(() => {}); return state; }
      sentinel = s;
      s.addEventListener?.('release', () => { if (sentinel === s) { sentinel = null; if (state === 'on') set('off'); } });
      set('on');
    } catch {
      if (enabled) set('denied');
    } finally {
      pending = false;
    }
    return state;
  }

  const onVisible = () => {
    if (enabled && doc.visibilityState === 'visible' && !sentinel && !pending) void acquire();
  };

  async function apply(): Promise<WakeState> {
    if (user || held) {
      enabled = true;
      doc.addEventListener('visibilitychange', onVisible);
      return acquire();
    }
    enabled = false;
    doc.removeEventListener('visibilitychange', onVisible);
    const s = sentinel;
    sentinel = null;
    if (state !== 'unsupported') set('off');
    try { await s?.release(); } catch { /* already released */ }
    return state;
  }

  return {
    enable(): Promise<WakeState> { user = true; return apply(); },
    async disable(): Promise<void> { user = false; await apply(); },
    /** Hands-free is on (true) or off: held, the lock stays whatever the player's toggle says. */
    hold(on: boolean): Promise<WakeState> { held = on; return apply(); },
    get held(): boolean { return held; },
    /** The player's own choice (the toggle), whatever a hold does meanwhile. */
    get wanted(): boolean { return user; },
    get state(): WakeState { return state; },
  };
}
