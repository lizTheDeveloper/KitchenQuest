import {
  EMPTY_TOOLKIT, isValidDate, MEAL_SLOTS, type IntakeStep, type MealSlot, type PantryItem, type Rule, type Tier, type ToolkitState,
} from '@kitchenquest/core/engine';

export interface PlayerSettings { showCalories: boolean; reducedMotion: 'system' | 'on' | 'off'; familyTable: boolean; iosNoteDismissed: boolean }
/** A signed-out player's profile, kept on this device (the same fields as M2's `/profile`). */
export interface LocalProfile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: { name: MealSlot; start: string; end: string }[] }
export interface PlayerState {
  v: 1; firstOpenedAt: string | null; lastOpenedAt: string | null; // ISO datetimes
  localRules: Rule[]; accountRules: Rule[] | null; account: { email: string } | null;
  toolkit: ToolkitState; cookProgress: { slug: string; step: number } | null;
  dialogueHistory: Record<string, number[]>; settings: PlayerSettings & { aiMentor: boolean };
  /** Signed out, the Pan's profile and pantry cards are written here (M4). */
  localProfile: LocalProfile | null; localPantry: (PantryItem & { id: string })[];
  /** Form 1-A: null = not started. */
  intake: { step: IntakeStep | 'done' | null };
  aiDisclosureSeen: boolean; aiHealthOffered: boolean;
  /** Set when stored data could not be read, so rules may have been lost. Rule checks must show ❓ until the
   *  player re-enters or confirms their rules (the only thing that clears it). Survives reloads. */
  rulesUnreadable: boolean;
  /** The player signed out but the server never heard (offline): finish the sign-out before asking /me again,
   *  so the old session can't sign this device back in. Cleared when logout succeeds or a new sign-in lands. */
  signOutPending: boolean;
}
export const STORE_KEY = 'kq.player.v1';
const CORRUPT_KEY = `${STORE_KEY}.corrupt`;
/** Rescue copies kept: `.corrupt` (newest), `.corrupt.1`, `.corrupt.2`. */
const RESCUE_KEYS = [CORRUPT_KEY, `${CORRUPT_KEY}.1`, `${CORRUPT_KEY}.2`];

export interface PlayerStore {
  get(): PlayerState;
  update(fn: (s: PlayerState) => PlayerState): PlayerState;
  /** Replace device rules with `rules` and clear rulesUnreadable in ONE update. This write is authoritative for localRules:
   *  the rebase does not merge this tab's in-memory rule versions back in (toolkit is still merged). */
  confirmRules(rules: Rule[]): PlayerState;
  subscribe(fn: (s: PlayerState) => void): () => void;
  /**
   * From now on this tab never touches storage again (changes stay in memory, other tabs' writes are ignored).
   * "Delete everything" calls it first, so nothing this tab does while deleting can write the data back.
   */
  stopSaving(): void;
  /** 'corrupt': stored data was unreadable. 'unsaved': a write failed, so changes live in memory only. */
  readonly notice: 'corrupt' | 'unsaved' | null;
}

function freshState(): PlayerState {
  return {
    v: 1, firstOpenedAt: null, lastOpenedAt: null,
    localRules: [], accountRules: null, account: null,
    toolkit: EMPTY_TOOLKIT, cookProgress: null, dialogueHistory: {},
    settings: { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: true },
    rulesUnreadable: false, signOutPending: false,
    localProfile: null, localPantry: [], intake: { step: null }, aiDisclosureSeen: false, aiHealthOffered: false,
  };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isStrOrNull = (x: unknown) => x === null || typeof x === 'string';
const isTechniqueRecord = (r: unknown): boolean =>
  isObj(r) && (r.tier === 'seen' || r.tier === 'tried' || r.tier === 'yours') &&
  typeof r.firstAt === 'string' && isValidDate(r.firstAt) && typeof r.lastUsedAt === 'string' && isValidDate(r.lastUsedAt) &&
  Array.isArray(r.recipes) && r.recipes.every((x) => typeof x === 'string');
const isObjArray = (x: unknown) => Array.isArray(x) && x.every(isObj);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const INTAKE_STEPS: readonly unknown[] = ['market_day', 'meals_per_week', 'region', 'allergies', 'pantry', 'done', null];
const isPantryRow = (x: unknown): boolean =>
  isObj(x) && typeof x.id === 'string' && typeof x.name === 'string' && isStrOrNull(x.ingredientId);
const isMealWindow = (x: unknown): boolean =>
  isObj(x) && (MEAL_SLOTS as readonly unknown[]).includes(x.name) && typeof x.start === 'string' && HHMM.test(x.start) &&
  typeof x.end === 'string' && HHMM.test(x.end);
const isLocalProfile = (x: unknown): boolean =>
  isObj(x) && Array.isArray(x.marketDays) && x.marketDays.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
  (x.mealsPerWeek === null || (typeof x.mealsPerWeek === 'number' && Number.isInteger(x.mealsPerWeek))) &&
  isStrOrNull(x.country) && isStrOrNull(x.region) && Array.isArray(x.mealWindows) && x.mealWindows.every(isMealWindow);

/**
 * Merge a parsed object over defaults key by key. A key that is ABSENT takes its default (older or partial
 * saves); a key that is PRESENT with the wrong shape returns null, because silently defaulting it would
 * discard data. The caller treats null like corrupt JSON.
 */
function merge(p: Record<string, unknown>): PlayerState | null {
  const d = freshState();
  const has = (k: string) => p[k] !== undefined;
  if (has('v') && p.v !== 1) return null;
  if (has('firstOpenedAt') && !isStrOrNull(p.firstOpenedAt)) return null;
  if (has('lastOpenedAt') && !isStrOrNull(p.lastOpenedAt)) return null;
  if (has('localRules') && !isObjArray(p.localRules)) return null;
  if (has('accountRules') && p.accountRules !== null && !isObjArray(p.accountRules)) return null;
  if (has('account') && p.account !== null && !(isObj(p.account) && typeof p.account.email === 'string')) return null;
  if (has('toolkit') && !(isObj(p.toolkit) && isObj(p.toolkit.techniques) && Object.values(p.toolkit.techniques).every(isTechniqueRecord))) return null;
  if (has('cookProgress') && p.cookProgress !== null && !(isObj(p.cookProgress) && typeof p.cookProgress.slug === 'string' && typeof p.cookProgress.step === 'number')) return null;
  if (has('dialogueHistory') && !isObj(p.dialogueHistory)) return null;
  if (has('rulesUnreadable') && typeof p.rulesUnreadable !== 'boolean') return null;
  if (has('signOutPending') && typeof p.signOutPending !== 'boolean') return null;
  if (has('localProfile') && p.localProfile !== null && !isLocalProfile(p.localProfile)) return null;
  if (has('localPantry') && !(Array.isArray(p.localPantry) && p.localPantry.every(isPantryRow))) return null;
  if (has('intake') && !(isObj(p.intake) && INTAKE_STEPS.includes(p.intake.step ?? null))) return null;
  if (has('aiDisclosureSeen') && typeof p.aiDisclosureSeen !== 'boolean') return null;
  if (has('aiHealthOffered') && typeof p.aiHealthOffered !== 'boolean') return null;
  if (has('settings') && !isObj(p.settings)) return null;
  const s = (isObj(p.settings) ? p.settings : {});
  const ds = d.settings;
  for (const k of ['showCalories', 'familyTable', 'iosNoteDismissed', 'aiMentor'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'boolean') return null;
  }
  if (s.reducedMotion !== undefined && s.reducedMotion !== 'system' && s.reducedMotion !== 'on' && s.reducedMotion !== 'off') return null;
  return {
    v: 1,
    firstOpenedAt: (has('firstOpenedAt') ? p.firstOpenedAt : d.firstOpenedAt) as string | null,
    lastOpenedAt: (has('lastOpenedAt') ? p.lastOpenedAt : d.lastOpenedAt) as string | null,
    localRules: has('localRules') ? (p.localRules as Rule[]) : d.localRules,
    accountRules: has('accountRules') ? (p.accountRules as Rule[] | null) : d.accountRules,
    account: has('account') ? (p.account as { email: string } | null) : d.account,
    toolkit: has('toolkit') ? (p.toolkit as ToolkitState) : d.toolkit,
    cookProgress: has('cookProgress') ? (p.cookProgress as { slug: string; step: number } | null) : d.cookProgress,
    dialogueHistory: has('dialogueHistory') ? (p.dialogueHistory as Record<string, number[]>) : d.dialogueHistory,
    settings: {
      showCalories: (s.showCalories as boolean | undefined) ?? ds.showCalories,
      reducedMotion: (s.reducedMotion) ?? ds.reducedMotion,
      familyTable: (s.familyTable as boolean | undefined) ?? ds.familyTable,
      iosNoteDismissed: (s.iosNoteDismissed as boolean | undefined) ?? ds.iosNoteDismissed,
      aiMentor: (s.aiMentor as boolean | undefined) ?? ds.aiMentor,
    },
    rulesUnreadable: (has('rulesUnreadable') ? p.rulesUnreadable : d.rulesUnreadable) as boolean,
    signOutPending: (has('signOutPending') ? p.signOutPending : d.signOutPending) as boolean,
    localProfile: has('localProfile') ? (p.localProfile as LocalProfile | null) : d.localProfile,
    localPantry: has('localPantry') ? (p.localPantry as (PantryItem & { id: string })[]) : d.localPantry,
    intake: has('intake') ? { step: ((p.intake as { step?: IntakeStep | 'done' | null }).step ?? null) } : d.intake,
    aiDisclosureSeen: (has('aiDisclosureSeen') ? p.aiDisclosureSeen : d.aiDisclosureSeen) as boolean,
    aiHealthOffered: (has('aiHealthOffered') ? p.aiHealthOffered : d.aiHealthOffered) as boolean,
  };
}

const RANK: Record<Tier, number> = { seen: 0, tried: 1, yours: 2 };

/** Union of two toolkits where nothing earned can go down: max tier, earliest firstAt, latest lastUsedAt. */
function mergeToolkit(a: ToolkitState, b: ToolkitState): ToolkitState {
  // A Map, then fromEntries: technique ids such as "__proto__" or "constructor" stay own data keys.
  const out = new Map(Object.entries(a.techniques));
  for (const [id, r] of Object.entries(b.techniques)) {
    const o = out.get(id);
    out.set(id, !o ? r : {
      tier: RANK[o.tier] >= RANK[r.tier] ? o.tier : r.tier,
      firstAt: o.firstAt < r.firstAt ? o.firstAt : r.firstAt,
      lastUsedAt: o.lastUsedAt > r.lastUsedAt ? o.lastUsedAt : r.lastUsedAt,
      recipes: [...new Set([...o.recipes, ...r.recipes])],
    });
  }
  return { techniques: Object.fromEntries(out) };
}

/**
 * Union two rule lists by id. Identical rules collapse. The same id with different contents keeps BOTH
 * versions and reports a conflict: the caller then marks rules unreadable, so no one is told "safe".
 */
function mergeRules(stored: Rule[], mine: Rule[]): { rules: Rule[]; conflict: boolean } {
  const rules = [...stored];
  let conflict = false;
  for (const r of mine) {
    const same = stored.filter((x) => x.id === r.id);
    if (same.length === 0) rules.push(r);
    else if (!same.some((x) => JSON.stringify(x) === JSON.stringify(r))) { rules.push(r); conflict = true; }
  }
  return { rules, conflict };
}

/**
 * What is stored now, plus anything this tab holds that storage lacks. Nothing earned or declared is dropped.
 * `conflict` is true when this rebase itself found two versions of one rule.
 */
function rebase(stored: PlayerState, mine: PlayerState, rulesAuthoritative = false): { state: PlayerState; conflict: boolean } {
  // confirmRules replaces the rules outright: this tab's in-memory versions are not merged back in.
  const { rules, conflict } = rulesAuthoritative ? { rules: stored.localRules, conflict: false } : mergeRules(stored.localRules, mine.localRules);
  return {
    state: {
      ...stored,
      localRules: rules,
      toolkit: mergeToolkit(stored.toolkit, mine.toolkit),
      rulesUnreadable: stored.rulesUnreadable || conflict,
    },
    conflict,
  };
}

type Stored = { kind: 'none' } | { kind: 'ok'; state: PlayerState } | { kind: 'bad'; raw: string } | { kind: 'error' };

function readStored(storage: Storage): Stored {
  let raw: string | null;
  try { raw = storage.getItem(STORE_KEY); } catch { return { kind: 'error' }; }
  if (raw === null) return { kind: 'none' };
  try {
    const parsed: unknown = JSON.parse(raw);
    const state = isObj(parsed) ? merge(parsed) : null;
    return state ? { kind: 'ok', state } : { kind: 'bad', raw };
  } catch {
    return { kind: 'bad', raw };
  }
}

/**
 * `storage` null or unusable means in-memory only. `events` (pass `window`) lets the store follow writes
 * from other tabs.
 */
export function createStore(
  storage: Storage | null,
  events?: Pick<EventTarget, 'addEventListener'>,
  /** Called when another tab deleted this device's data (pass a page reload). */
  onWiped?: () => void,
): PlayerStore {
  let notice: 'corrupt' | 'unsaved' | null = null;
  let persisted = false; // storage has held our data, so "gone" later means deleted
  let state = freshState();
  // True when we must never write to storage: it can't be read, or the original couldn't be backed up.
  let memoryOnly = storage === null;
  let stoppedSaving = false;
  const subs = new Set<(s: PlayerState) => void>();
  const notify = () => { for (const f of [...subs]) f(state); };

  /** Copy unreadable data aside, newest first, keeping 3. Returns false (and goes memory-only) on any failure. */
  const keepCorrupt = (raw: string): boolean => {
    notice = 'corrupt';
    try {
      if (storage!.getItem(CORRUPT_KEY) === raw) return true; // already rescued
      for (let i = RESCUE_KEYS.length - 1; i > 0; i--) {
        const older = storage!.getItem(RESCUE_KEYS[i - 1]);
        if (older !== null) storage!.setItem(RESCUE_KEYS[i], older);
      }
      storage!.setItem(CORRUPT_KEY, raw);
      return true;
    } catch {
      memoryOnly = true;
      return false;
    }
  };

  if (storage) {
    const r = readStored(storage);
    if (r.kind === 'ok') { state = r.state; persisted = true; }
    else if (r.kind === 'bad') {
      keepCorrupt(r.raw);
      state = { ...freshState(), rulesUnreadable: true };
    } else if (r.kind === 'error') {
      memoryOnly = true;
      state = { ...freshState(), rulesUnreadable: true };
    }
  }

  const wipe = () => {
    state = freshState();
    persisted = false;
    notify();
    onWiped?.();
  };

  events?.addEventListener('storage', (ev) => {
    if (memoryOnly || stoppedSaving || !storage) return;
    const key = (ev as Event & { key?: string | null }).key;
    if (key !== STORE_KEY && key !== null) return;
    const r = readStored(storage);
    if (r.kind === 'none' && persisted) { wipe(); return; }
    if (r.kind !== 'ok') return;
    state = rebase(r.state, state).state;
    notify();
  });

  const apply = (fn: (s: PlayerState) => PlayerState, rulesAuthoritative: boolean): PlayerState => {
      let base = state;
      let conflict = false;
      let wiped = false;
      let next: PlayerState | null = null;
      if (!memoryOnly && storage) {
        // Another tab may have written since we last looked: build on what is stored now.
        const r = readStored(storage);
        if (r.kind === 'ok') ({ state: base, conflict } = rebase(r.state, state, rulesAuthoritative));
        else if (r.kind === 'none' && persisted) {
          // Deleted in another tab: never resurrect the old data. But a rule declared in this change must not
          // vanish silently, so apply the change to a fresh state and keep it when it declares rules.
          base = freshState();
          next = fn(base);
          if (next.localRules.length === 0) { wipe(); return state; }
          wiped = true;
        }
        else if (r.kind === 'bad') keepCorrupt(r.raw);
        else if (r.kind === 'error') memoryOnly = true;
      }
      next ??= fn(base);
      state = { ...next, toolkit: mergeToolkit(base.toolkit, next.toolkit) }; // earned toolkit data never goes down
      // A conflict found by this very rebase was never seen by the caller, so this update cannot clear the flag.
      if (conflict) state = { ...state, rulesUnreadable: true };
      if (!memoryOnly && storage) {
        try { storage.setItem(STORE_KEY, JSON.stringify(state)); persisted = true; }
        catch {
          // Memory is now ahead of storage; rebasing on the stale stored copy would drop changes.
          memoryOnly = true;
          notice = 'unsaved';
        }
      }
      notify();
      if (wiped && !memoryOnly) onWiped?.(); // reload onto what was just saved; if the write failed, stay put
      return state;
  };

  return {
    get: () => state,
    update: (fn) => apply(fn, false),
    // One update: the rules are replaced and the flag cleared together, so a conflict this tab still holds in memory
    // (the M3 carry-over) can't be rebased back in and re-set rulesUnreadable.
    confirmRules: (rules) => apply((s) => ({ ...s, localRules: [...rules], rulesUnreadable: false }), true),
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    stopSaving() { stoppedSaving = true; memoryOnly = true; },
    get notice() { return notice; },
  };
}

export function safeLocalStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

/** Remove everything Kitchen Quest keeps on this device, rescue copies included. Returns the keys removed. */
export function deleteDeviceData(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k !== null && k.startsWith('kq.')) keys.push(k);
  }
  for (const k of keys) storage.removeItem(k);
  return keys;
}
