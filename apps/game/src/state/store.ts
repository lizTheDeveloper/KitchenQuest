import {
  EMPTY_TOOLKIT, isValidDate, MEAL_SLOTS, type IntakeStep, type MealSlot, type PantryItem, type ProgressEvent, type ProgressSnapshot,
  type RewardGrant, type Rule, type Tier, type ToolkitState,
} from '@kitchenquest/core/engine';

/** The device log's cap (C15): over it, the oldest events fold into `progress.base` (progress/log.ts). */
export const MAX_DEVICE_EVENTS = 2000;

/**
 * The device's own progress history (Ruling 8): every event this device recorded and what it earned on the device,
 * a compacted `base` (C15, a totals snapshot that lowers nothing), and the ids not yet uploaded to an account
 * (`pendingUpload`, in log order). Content-free: ids, dates and numbers only.
 */
export interface DeviceProgress { events: ProgressEvent[]; grants: RewardGrant[]; base: ProgressSnapshot | null; pendingUpload: string[] }
export const EMPTY_PROGRESS: DeviceProgress = Object.freeze({ events: [], grants: [], base: null, pendingUpload: [] }) as unknown as DeviceProgress;

export interface PlayerSettings { showCalories: boolean; reducedMotion: 'system' | 'on' | 'off'; familyTable: boolean; iosNoteDismissed: boolean }
/** A signed-out player's profile, kept on this device (the same fields as M2's `/profile`). */
export interface LocalProfile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: { name: MealSlot; start: string; end: string }[] }
export interface PlayerState {
  v: 1; firstOpenedAt: string | null; lastOpenedAt: string | null; // ISO datetimes
  localRules: Rule[]; accountRules: Rule[] | null; account: { email: string } | null;
  /** M3's device toolkit. Read once into `progress` as `imported` events (Ruling 8); M5 never writes it. */
  toolkit: ToolkitState; cookProgress: { slug: string; step: number } | null;
  /** M5: the device progress log (Ruling 8, C15). */
  progress: DeviceProgress;
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
    toolkit: EMPTY_TOOLKIT, cookProgress: null, dialogueHistory: {}, progress: EMPTY_PROGRESS,
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
const isStrArray = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === 'string');
/** The shape only: core folds stored data defensively, so a field it can't read changes nothing (never a throw). */
const isProgress = (x: unknown): boolean =>
  isObj(x) &&
  Array.isArray(x.events) && x.events.every((e) => isObj(e) && typeof e.id === 'string' && typeof e.kind === 'string' && typeof e.at === 'string') &&
  Array.isArray(x.grants) && x.grants.every((g) => isObj(g) && typeof g.id === 'string' && typeof g.eventId === 'string' && typeof g.kind === 'string') &&
  (x.base === null || (isObj(x.base) && isObj(x.base.view))) &&
  isStrArray(x.pendingUpload);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Every core `IntakeStep`: a step core adds fails to compile here until it is listed. */
const INTAKE_STEP_SET: Readonly<Record<IntakeStep, true>> = { market_day: true, meals_per_week: true, region: true, allergies: true, pantry: true };
const isIntakeStep = (x: unknown): boolean => x === null || x === 'done' || (typeof x === 'string' && Object.hasOwn(INTAKE_STEP_SET, x));
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
  if (has('progress') && !isProgress(p.progress)) return null;
  if (has('rulesUnreadable') && typeof p.rulesUnreadable !== 'boolean') return null;
  if (has('signOutPending') && typeof p.signOutPending !== 'boolean') return null;
  if (has('localProfile') && p.localProfile !== null && !isLocalProfile(p.localProfile)) return null;
  if (has('localPantry') && !(Array.isArray(p.localPantry) && p.localPantry.every(isPantryRow))) return null;
  if (has('intake') && !(isObj(p.intake) && Object.hasOwn(p.intake, 'step') && isIntakeStep(p.intake.step))) return null;
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
    progress: has('progress') ? (p.progress as DeviceProgress) : d.progress,
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
    intake: has('intake') ? { step: (p.intake as { step: IntakeStep | 'done' | null }).step } : d.intake,
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

/** The event ids a compacted base already holds (core's snapshot facts, read defensively and never changed). */
function baseIds(base: ProgressSnapshot | null): Set<string> {
  const facts = base?.facts;
  const ids = isObj(facts) && Array.isArray(facts.ids) ? facts.ids : [];
  return new Set(ids.filter((id): id is string => typeof id === 'string'));
}

/** The base that holds more: the one covering more event ids (a base only grows), else the higher XP; ties → `b`. */
function higherBase(a: ProgressSnapshot | null, b: ProgressSnapshot | null): ProgressSnapshot | null {
  if (a === null) return b;
  if (b === null) return a;
  const na = baseIds(a).size, nb = baseIds(b).size;
  if (na !== nb) return na > nb ? a : b;
  return (Number(a.view.xp) || 0) > (Number(b.view.xp) || 0) ? a : b;
}

/**
 * Two copies of the device progress log as one (another tab's write, or an update over what is stored). Events are
 * a union by id over the events still held, in `a`'s order then `b`'s new ones: no held event is ever dropped. The
 * higher `base` is kept (never a lower one), and an event or grant it already covers is not held twice. A second
 * `imported` event for a technique already imported (two tabs reading the M3 toolkit at once) is the same record:
 * one is kept. Grants are a union by id; `pendingUpload` a union (or `b`'s alone with `pendingFrom: 'b'`, when `b` is
 * an update of `a`, so an upload marked done stays done), kept only for events still held.
 */
export function mergeProgress(a: DeviceProgress, b: DeviceProgress, opts: { pendingFrom?: 'both' | 'b' } = {}): DeviceProgress {
  if (a === b) return a;
  const base = higherBase(a.base, b.base);
  const covered = baseIds(base);
  const seen = new Set<string>();
  const importedTechniques = new Set<string>();
  const events: ProgressEvent[] = [];
  for (const e of [...a.events, ...b.events]) {
    if (seen.has(e.id) || covered.has(e.id)) continue;
    if (e.kind === 'imported') {
      if (importedTechniques.has(e.technique)) continue;
      importedTechniques.add(e.technique);
    }
    seen.add(e.id);
    events.push(e);
  }
  const grantIds = new Set<string>();
  const grants: RewardGrant[] = [];
  for (const g of [...a.grants, ...b.grants]) {
    if (grantIds.has(g.id) || !seen.has(g.eventId)) continue;
    grantIds.add(g.id);
    grants.push(g);
  }
  const pendingUpload = [...new Set(opts.pendingFrom === 'b' ? b.pendingUpload : [...a.pendingUpload, ...b.pendingUpload])].filter((id) => seen.has(id));
  return { events, grants, base, pendingUpload };
}

/** The first allowed event date (the API's floor, I4 ruling): an older M3 date is read as this. */
const PROGRESS_EPOCH = '2026-01-01';
const notBefore = (d: string): string => (d < PROGRESS_EPOCH ? PROGRESS_EPOCH : d);

/**
 * Ruling 8: each M3 toolkit record with no matching `imported` event (in the log, or already folded into its base)
 * becomes one, so nothing earned before M5 is lost. Ids are `crypto.randomUUID()`; the caller saves at once, so a
 * reload finds the event and never imports twice. The server checks each import against the catalogue again.
 */
export function importM3Toolkit(s: PlayerState, newId: () => string = () => crypto.randomUUID()): PlayerState {
  const records = Object.entries(s.toolkit.techniques);
  if (records.length === 0) return s;
  const done = new Set<string>(s.progress.events.flatMap((e) => (e.kind === 'imported' ? [e.technique] : [])));
  const folded = s.progress.base?.view.toolkit.techniques ?? {};
  const added: ProgressEvent[] = [];
  for (const [technique, r] of records) {
    if (done.has(technique) || Object.hasOwn(folded, technique)) continue;
    const firstAt = notBefore(r.firstAt), lastUsedAt = notBefore(r.lastUsedAt);
    added.push({ id: newId(), kind: 'imported', at: lastUsedAt, technique, tier: r.tier, firstAt, lastUsedAt: lastUsedAt < firstAt ? firstAt : lastUsedAt, recipes: [...r.recipes] });
  }
  if (added.length === 0) return s;
  return {
    ...s,
    progress: { ...s.progress, events: [...added, ...s.progress.events], pendingUpload: [...added.map((e) => e.id), ...s.progress.pendingUpload] },
  };
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
      progress: mergeProgress(stored.progress, mine.progress),
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
    if (r.kind === 'ok') {
      state = importM3Toolkit(r.state);
      persisted = true;
      // Saved at once, so the next read (this tab's or another's) finds the imports and never makes them again.
      if (state !== r.state) {
        try { storage.setItem(STORE_KEY, JSON.stringify(state)); } catch { memoryOnly = true; notice = 'unsaved'; }
      }
    }
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
      // Earned data never goes down: the toolkit, and every progress event still held (a compaction in `fn` is kept).
      state = { ...next, toolkit: mergeToolkit(base.toolkit, next.toolkit), progress: mergeProgress(base.progress, next.progress, { pendingFrom: 'b' }) };
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
