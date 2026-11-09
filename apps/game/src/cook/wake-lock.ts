export type WakeState = 'on' | 'off' | 'unsupported' | 'denied';

interface Sentinel { release(): Promise<void>; addEventListener?(type: 'release', fn: () => void): void }
interface WakeLockApi { request(type: 'screen'): Promise<Sentinel> }

/**
 * Keeps the screen awake while cooking. The browser drops the lock when the tab is hidden, so it is
 * taken again when the tab becomes visible, for as long as it is enabled.
 */
export function createWakeLock(nav: Navigator, doc: Document, onChange?: (s: WakeState) => void) {
  let state: WakeState = 'off';
  let enabled = false;
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

  return {
    async enable(): Promise<WakeState> {
      enabled = true;
      doc.addEventListener('visibilitychange', onVisible);
      return acquire();
    },
    async disable(): Promise<void> {
      enabled = false;
      doc.removeEventListener('visibilitychange', onVisible);
      const s = sentinel;
      sentinel = null;
      if (state !== 'unsupported') set('off');
      try { await s?.release(); } catch { /* already released */ }
    },
    get state(): WakeState { return state; },
  };
}
