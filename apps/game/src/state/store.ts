import { EMPTY_TOOLKIT, type Rule, type ToolkitState } from '@kitchenquest/core/engine';

export interface PlayerSettings { showCalories: boolean; reducedMotion: 'system' | 'on' | 'off'; familyTable: boolean; iosNoteDismissed: boolean }
export interface PlayerState {
  v: 1; firstOpenedAt: string | null; lastOpenedAt: string | null; // ISO datetimes
  localRules: Rule[]; accountRules: Rule[] | null; account: { email: string } | null;
  toolkit: ToolkitState; cookProgress: { slug: string; step: number } | null;
  dialogueHistory: Record<string, number[]>; settings: PlayerSettings;
}
export const STORE_KEY = 'kq.player.v1';
const CORRUPT_KEY = `${STORE_KEY}.corrupt`;

export interface PlayerStore {
  get(): PlayerState;
  update(fn: (s: PlayerState) => PlayerState): PlayerState;
  subscribe(fn: (s: PlayerState) => void): () => void;
  readonly notice: 'corrupt' | null;
}

function freshState(): PlayerState {
  return {
    v: 1, firstOpenedAt: null, lastOpenedAt: null,
    localRules: [], accountRules: null, account: null,
    toolkit: EMPTY_TOOLKIT, cookProgress: null, dialogueHistory: {},
    settings: { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false },
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Merge a parsed object over defaults key by key; a value of the wrong shape falls back to the default. */
function merge(parsed: Record<string, unknown>): PlayerState {
  const d = freshState();
  const iso = (x: unknown, dflt: string | null) => (typeof x === 'string' ? x : dflt);
  const s = isObj(parsed.settings) ? parsed.settings : {};
  const ds = d.settings;
  return {
    v: 1,
    firstOpenedAt: iso(parsed.firstOpenedAt, d.firstOpenedAt),
    lastOpenedAt: iso(parsed.lastOpenedAt, d.lastOpenedAt),
    localRules: Array.isArray(parsed.localRules) ? (parsed.localRules as Rule[]) : d.localRules,
    accountRules: Array.isArray(parsed.accountRules) ? (parsed.accountRules as Rule[]) : d.accountRules,
    account: isObj(parsed.account) && typeof parsed.account.email === 'string' ? { email: parsed.account.email } : d.account,
    toolkit: isObj(parsed.toolkit) && isObj(parsed.toolkit.techniques) ? (parsed.toolkit as unknown as ToolkitState) : d.toolkit,
    cookProgress:
      isObj(parsed.cookProgress) && typeof parsed.cookProgress.slug === 'string' && typeof parsed.cookProgress.step === 'number'
        ? { slug: parsed.cookProgress.slug, step: parsed.cookProgress.step } : d.cookProgress,
    dialogueHistory: isObj(parsed.dialogueHistory) ? (parsed.dialogueHistory as Record<string, number[]>) : d.dialogueHistory,
    settings: {
      showCalories: typeof s.showCalories === 'boolean' ? s.showCalories : ds.showCalories,
      reducedMotion: s.reducedMotion === 'system' || s.reducedMotion === 'on' || s.reducedMotion === 'off' ? s.reducedMotion : ds.reducedMotion,
      familyTable: typeof s.familyTable === 'boolean' ? s.familyTable : ds.familyTable,
      iosNoteDismissed: typeof s.iosNoteDismissed === 'boolean' ? s.iosNoteDismissed : ds.iosNoteDismissed,
    },
  };
}

export function createStore(storage: Storage | null): PlayerStore {
  let notice: 'corrupt' | null = null;
  let state = freshState();
  const subs = new Set<(s: PlayerState) => void>();

  const keepCorrupt = (raw: string) => {
    notice = 'corrupt';
    try {
      // Never discard earned data silently, and never overwrite an earlier rescue copy.
      const key = storage!.getItem(CORRUPT_KEY) === null ? CORRUPT_KEY : `${CORRUPT_KEY}.${Date.now()}`;
      storage!.setItem(key, raw);
    } catch { /* storage unusable: the banner still tells the player */ }
  };

  let raw: string | null = null;
  try { raw = storage ? storage.getItem(STORE_KEY) : null; } catch { raw = null; }
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed) || (parsed.v !== undefined && parsed.v !== 1)) throw new Error('unknown shape');
      state = merge(parsed);
    } catch {
      keepCorrupt(raw);
      state = freshState();
    }
  }

  return {
    get: () => state,
    update(fn) {
      state = fn(state);
      try { storage?.setItem(STORE_KEY, JSON.stringify(state)); } catch { /* in-memory only */ }
      for (const f of [...subs]) f(state);
      return state;
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    get notice() { return notice; },
  };
}

export function safeLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}
