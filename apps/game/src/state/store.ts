import {
  EMPTY_TOOLKIT, isValidDate, MEAL_SLOTS, type IntakeStep, type MarketRunView, type MealSlot, type PantryItem, type Plan, type ProgressEvent,
  type ProgressSnapshot, type ProgressView, type RewardGrant, type Rule, type Tier, type ToolkitState,
} from '@kitchenquest/core/engine';
import { sha256Hex } from './sha256';

/** How long a plan (and its run) stays on the device after its week ends: the server's retention (H-11, Ruling 18). */
const PLAN_RETENTION_WEEKS = 8;
const DAY_MS = 86_400_000;
/** The player's LOCAL calendar date as YYYY-MM-DD (as recipes/rules.ts `localDate`, which re-exports this). */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The device week without plans and runs whose week ended more than PLAN_RETENTION_WEEKS before `today`. */
export function retainedWeek(w: PlayerState['localWeek'], today: string): PlayerState['localWeek'] {
  const oldest = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * (PLAN_RETENTION_WEEKS + 1) * DAY_MS).toISOString().slice(0, 10);
  const plans = w.plans.filter((p) => p.weekStart >= oldest);
  const runs = w.runs.filter((r) => r.weekStart >= oldest);
  return plans.length === w.plans.length && runs.length === w.runs.length ? w : { plans, runs };
}

/**
 * M5 final I3: `s` with old device weeks gone (H-11's 8 weeks, as data-inventory L-5 says). The store applies it when
 * it loads and on each sign-in and sign-out, so a week nothing saves again still leaves on time.
 */
const withRetainedWeek = (s: PlayerState, today: string): PlayerState => {
  const localWeek = retainedWeek(s.localWeek, today);
  return localWeek === s.localWeek ? s : { ...s, localWeek };
};

/** The device log's cap (C15): over it, the oldest events fold into `progress.base` (progress/log.ts). */
export const MAX_DEVICE_EVENTS = 2000;

/**
 * The device's own progress history (Ruling 8): every event this device recorded and what it earned on the device,
 * a compacted `base` (C15, a totals snapshot that lowers nothing), and the ids not yet uploaded to an account
 * (`pendingUpload`, in log order). Content-free: ids, dates and numbers only.
 */
export interface DeviceProgress {
  events: ProgressEvent[]; grants: RewardGrant[]; base: ProgressSnapshot | null; pendingUpload: string[];
  /**
   * Bumped whenever events are deliberately removed (a sign-out prune, synced events of a signed-out account, guest
   * progress moved to an account). A higher epoch replaces a lower one outright on merge, so a removal is never undone
   * by another tab's older copy.
   */
  epoch?: number;
}
const EMPTY_PROGRESS: DeviceProgress = { events: [], grants: [], base: null, pendingUpload: [] };

/**
 * One account's progress on this device (C1 ruling): its own log, and the last account view the server sent (M6:
 * shown while `/progress` hasn't answered, so nothing drops after a reload). Read, shown and synced only while that
 * account is signed in; hidden (never deleted, never shown, never uploaded elsewhere) while it isn't.
 */
interface AccountPartition {
  progress: DeviceProgress;
  view: ProgressView | null;
}

const keyCache = new Map<string, string>();
/** An account's partition key: the SHA-256 (hex) of its email, so no storage key ever holds an email. */
export function accountKey(email: string): string {
  let k = keyCache.get(email);
  if (k === undefined) { k = sha256Hex(email); keyCache.set(email, k); }
  return k;
}

/** Which partition is live: the signed-in account's (its hashed key), else the guest's (null). */
export const partitionKey = (s: Pick<PlayerState, 'account'>): string | null => (s.account ? accountKey(s.account.email) : null);

/**
 * After a sign-out (and its flush): the server holds the record, so everything already synced leaves the account's
 * partition, and its cached view with it. Only events still waiting for upload stay (with their grants), for that
 * same account's next sign-in, when the view is rebuilt from the server. The epoch makes the prune stick on merge.
 */
export function prunePartition(s: PlayerState, key: string): PlayerState {
  if (!Object.hasOwn(s.accountProgress, key)) return s;
  const old = s.accountProgress[key];
  const pending = new Set(old.progress.pendingUpload);
  const events = old.progress.events.filter((e) => pending.has(e.id));
  // Already minimal (a start-up sweep over a pruned partition): nothing to write.
  if (old.view === null && old.progress.base === null && events.length === old.progress.events.length) return s;
  const ids = new Set(events.map((e) => e.id));
  const progress: DeviceProgress = {
    events, grants: old.progress.grants.filter((g) => ids.has(g.eventId)), base: null, pendingUpload: events.map((e) => e.id),
    epoch: (old.progress.epoch ?? 0) + 1,
  };
  return { ...s, accountProgress: { ...s.accountProgress, [key]: { progress, view: null } } };
}

/** Remove events (and their grants) from partition `key` for good: they are the server's now (N1, N5). */
export function dropEvents(s: PlayerState, key: string | null, ids: Iterable<string>): PlayerState {
  const gone = new Set(ids);
  const p = partitionOf(s, key);
  if (!p.events.some((e) => gone.has(e.id))) return s;
  return withPartition(s, key, {
    events: p.events.filter((e) => !gone.has(e.id)),
    grants: p.grants.filter((g) => !gone.has(g.eventId)),
    base: p.base,
    pendingUpload: p.pendingUpload.filter((id) => !gone.has(id)),
    epoch: (p.epoch ?? 0) + 1,
  });
}

/** A grant key core's fold uses up for a stall round's weekly stamp (fold.ts `key('stall', …)`): it names the stall. */
const STALL_KEY = '["stall",';

/**
 * M6 final review I1: after a `health_data` withdraw-with-delete, account `key`'s health-revealing records leave this
 * device too, as the server erased them: every `stall_round` (Protein Counter rounds among them) and `meal_logged`
 * event, the answered question ids a compacted base holds (`marketAnswered`, and the stall stamp keys that name a
 * stall), and the cached account view's `marketAnswered` (the server's next view replaces it). Every grant stays, so
 * XP, level and stamps never drop (core folds a grant whose event is gone, as `eraseEvents` does). The epoch makes the
 * erasure stick on merge with another tab's older copy.
 */
export function eraseHealthEvents(s: PlayerState, key: string): PlayerState {
  if (!Object.hasOwn(s.accountProgress, key)) return s;
  const old = s.accountProgress[key];
  const p = old.progress;
  const gone = new Set(p.events.filter((e) => e.kind === 'stall_round' || e.kind === 'meal_logged').map((e) => e.id));
  let base = p.base;
  if (base !== null) {
    const facts = isObj(base.facts) ? base.facts : {};
    const keys = Array.isArray(facts.keys) ? facts.keys : [];
    base = {
      view: { ...base.view, marketAnswered: {} },
      facts: { ...facts, keys: keys.filter((k) => !(typeof k === 'string' && k.startsWith(STALL_KEY))) },
    };
  }
  const view = old.view === null ? null : { ...old.view, marketAnswered: {} };
  const progress: DeviceProgress = {
    events: p.events.filter((e) => !gone.has(e.id)),
    grants: p.grants,
    base,
    pendingUpload: p.pendingUpload.filter((id) => !gone.has(id)),
    epoch: (p.epoch ?? 0) + 1,
  };
  return { ...s, accountProgress: { ...s.accountProgress, [key]: { progress, view } } };
}

/** A partition's log: the guest's is `progress`; an account's lives in `accountProgress` (empty until it has one). */
export function partitionOf(s: PlayerState, key: string | null): DeviceProgress {
  if (key === null) return s.progress;
  return Object.hasOwn(s.accountProgress, key) ? s.accountProgress[key].progress : EMPTY_PROGRESS;
}

/** The cached account view of `key`'s partition, or null. */
export function accountViewOf(s: PlayerState, key: string): ProgressView | null {
  return Object.hasOwn(s.accountProgress, key) ? s.accountProgress[key].view : null;
}

/** `s` with one partition changed: `p` is its new log; `view` (when given) its cached account view. */
export function withPartition(s: PlayerState, key: string | null, p: DeviceProgress, view?: ProgressView | null): PlayerState {
  if (key === null) return { ...s, progress: p };
  const old: AccountPartition = Object.hasOwn(s.accountProgress, key) ? s.accountProgress[key] : { progress: EMPTY_PROGRESS, view: null };
  return { ...s, accountProgress: { ...s.accountProgress, [key]: { ...old, progress: p, view: view === undefined ? old.view : view } } };
}

export interface PlayerSettings {
  showCalories: boolean; reducedMotion: 'system' | 'on' | 'off'; familyTable: boolean; iosNoteDismissed: boolean;
  /** Use-It-Up Rescue nudges in the kitchen (audit M-14: "can be turned off"). On by default. */
  rescueNudges: boolean;
}
/** A market run kept on this device (C40's shape) and the pantry row each tick added, by list key (Ruling 16). */
export interface LocalRun extends MarketRunView { pantryIds: Record<string, string> }
/**
 * Signed out, the week lives here (Step 10): each plan week's plan and its market run, in the API's shapes. Kept for
 * PLAN_RETENTION_WEEKS after the week, like the server's. Dish slugs, dates and list rows only: never a status.
 */
interface LocalWeek { plans: Plan[]; runs: LocalRun[] }
/**
 * Today's Use-It-Up nudge (RESCUE_NUDGES_PER_DAY) for one partition: the local date, the pantry row it named and
 * whether the player answered it (Cook, Compost or Not now). A date and an id only; another day starts afresh.
 */
interface RescueNudge { on: string; itemId: string; answered: boolean }
/**
 * M5 final m11: one nudge record per partition (the account key, or 'guest'), so A, then B, then A again on one
 * device is still one nudge a day for A. Pruned to today on each write.
 */
type RescueNudges = Record<string, RescueNudge>;
/** A signed-out player's profile, kept on this device (the same fields as M2's `/profile`). */
export interface LocalProfile { marketDays: number[]; mealsPerWeek: number | null; country: string | null; region: string | null; mealWindows: { name: MealSlot; start: string; end: string }[] }
export interface PlayerState {
  v: 1; firstOpenedAt: string | null; lastOpenedAt: string | null; // ISO datetimes
  localRules: Rule[]; accountRules: Rule[] | null; account: { email: string } | null;
  /** M3's device toolkit. Read once into `progress` as `imported` events (Ruling 8); M5 never writes it. */
  toolkit: ToolkitState; cookProgress: { slug: string; step: number } | null;
  /** M5: the guest partition, progress played signed out on this device (Ruling 8, C15). */
  progress: DeviceProgress;
  /** M5 (C1 ruling): each account's own partition, by account key; only the signed-in account's is ever read. */
  accountProgress: Record<string, AccountPartition>;
  dialogueHistory: Record<string, number[]>; settings: PlayerSettings & { aiMentor: boolean };
  /** Signed out, the Pan's profile and pantry cards are written here (M4). */
  localProfile: LocalProfile | null; localPantry: (PantryItem & { id: string })[];
  /** Signed out, the week's plan and market run (Step 10). */
  localWeek: LocalWeek;
  /** Today's Use-It-Up nudge, or null (Step 10). */
  rescue: RescueNudges;
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
    toolkit: EMPTY_TOOLKIT, cookProgress: null, dialogueHistory: {}, progress: EMPTY_PROGRESS, accountProgress: {},
    settings: { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, aiMentor: true, rescueNudges: true },
    rulesUnreadable: false, signOutPending: false,
    localProfile: null, localPantry: [], localWeek: { plans: [], runs: [] }, rescue: {}, intake: { step: null }, aiDisclosureSeen: false, aiHealthOffered: false,
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
  isStrArray(x.pendingUpload) &&
  (x.epoch === undefined || (typeof x.epoch === 'number' && Number.isInteger(x.epoch) && x.epoch >= 0));
const isPartitions = (x: unknown): boolean =>
  isObj(x) && Object.values(x).every((a) => isObj(a) && isProgress(a.progress) && (a.view === null || isObj(a.view)));
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Every core `IntakeStep`: a step core adds fails to compile here until it is listed. */
const INTAKE_STEP_SET: Readonly<Record<IntakeStep, true>> = { market_day: true, meals_per_week: true, region: true, allergies: true, pantry: true };
const isIntakeStep = (x: unknown): boolean => x === null || x === 'done' || (typeof x === 'string' && Object.hasOwn(INTAKE_STEP_SET, x));
const isPantryRow = (x: unknown): boolean =>
  isObj(x) && typeof x.id === 'string' && typeof x.name === 'string' && isStrOrNull(x.ingredientId) &&
  (x.addedOn === undefined || typeof x.addedOn === 'string') && (x.source === undefined || x.source === 'told' || x.source === 'market');
/** The shape only: core `validatePlan` judges a stored plan against the canon when it is read (week/local-week.ts). */
const isPlanShape = (x: unknown): boolean =>
  isObj(x) && typeof x.weekStart === 'string' && isObjArray(x.items) && typeof x.hard === 'boolean' && typeof x.slot === 'string';
const isRunShape = (x: unknown): boolean =>
  isObj(x) && typeof x.id === 'string' && typeof x.weekStart === 'string' && isObjArray(x.items) && isStrOrNull(x.doneAt) &&
  isObj(x.pantryIds) && Object.values(x.pantryIds).every((v) => typeof v === 'string');
const isLocalWeek = (x: unknown): boolean =>
  isObj(x) && Array.isArray(x.plans) && x.plans.every(isPlanShape) && Array.isArray(x.runs) && x.runs.every(isRunShape);
const isNudge = (x: unknown): boolean => isObj(x) && typeof x.on === 'string' && typeof x.itemId === 'string' && typeof x.answered === 'boolean';
/** The M5 Step 10 shape (one record with its `key`), or null. */
const isOldRescue = (x: unknown): x is RescueNudge & { key: string } => isObj(x) && typeof x.key === 'string' && isNudge(x);
const isRescue = (x: unknown): boolean => x === null || isOldRescue(x) || (isObj(x) && Object.values(x).every(isNudge));
/** The stored nudges as M5 final's map: Step 10's single record (or null) becomes its partition's entry. */
function rescueOf(x: unknown): RescueNudges {
  if (x === null) return {};
  if (isOldRescue(x)) return { [x.key]: { on: x.on, itemId: x.itemId, answered: x.answered } };
  return Object.fromEntries(Object.entries(x as RescueNudges));
}
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
  if (has('accountProgress') && !isPartitions(p.accountProgress)) return null;
  if (has('rulesUnreadable') && typeof p.rulesUnreadable !== 'boolean') return null;
  if (has('signOutPending') && typeof p.signOutPending !== 'boolean') return null;
  if (has('localProfile') && p.localProfile !== null && !isLocalProfile(p.localProfile)) return null;
  if (has('localPantry') && !(Array.isArray(p.localPantry) && p.localPantry.every(isPantryRow))) return null;
  if (has('localWeek') && !isLocalWeek(p.localWeek)) return null;
  if (has('rescue') && !isRescue(p.rescue)) return null;
  if (has('intake') && !(isObj(p.intake) && Object.hasOwn(p.intake, 'step') && isIntakeStep(p.intake.step))) return null;
  if (has('aiDisclosureSeen') && typeof p.aiDisclosureSeen !== 'boolean') return null;
  if (has('aiHealthOffered') && typeof p.aiHealthOffered !== 'boolean') return null;
  if (has('settings') && !isObj(p.settings)) return null;
  const s = (isObj(p.settings) ? p.settings : {});
  const ds = d.settings;
  for (const k of ['showCalories', 'familyTable', 'iosNoteDismissed', 'aiMentor', 'rescueNudges'] as const) {
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
    // A Map, then fromEntries: keys stay own data keys.
    accountProgress: has('accountProgress') ? Object.fromEntries(Object.entries(p.accountProgress as Record<string, AccountPartition>)) : d.accountProgress,
    settings: {
      showCalories: (s.showCalories as boolean | undefined) ?? ds.showCalories,
      reducedMotion: (s.reducedMotion) ?? ds.reducedMotion,
      familyTable: (s.familyTable as boolean | undefined) ?? ds.familyTable,
      iosNoteDismissed: (s.iosNoteDismissed as boolean | undefined) ?? ds.iosNoteDismissed,
      aiMentor: (s.aiMentor as boolean | undefined) ?? ds.aiMentor,
      rescueNudges: (s.rescueNudges as boolean | undefined) ?? ds.rescueNudges,
    },
    rulesUnreadable: (has('rulesUnreadable') ? p.rulesUnreadable : d.rulesUnreadable) as boolean,
    signOutPending: (has('signOutPending') ? p.signOutPending : d.signOutPending) as boolean,
    localProfile: has('localProfile') ? (p.localProfile as LocalProfile | null) : d.localProfile,
    localPantry: has('localPantry') ? (p.localPantry as (PantryItem & { id: string })[]) : d.localPantry,
    localWeek: has('localWeek') ? (p.localWeek as LocalWeek) : d.localWeek,
    rescue: has('rescue') ? rescueOf(p.rescue) : d.rescue,
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
  // A deliberate removal (a higher epoch) wins outright: what it removed never comes back from an older copy.
  const ea = a.epoch ?? 0, eb = b.epoch ?? 0;
  if (ea !== eb) return ea > eb ? a : b;
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
  // A grant goes with its event, except one whose event neither copy holds (M6 final I1: an erased stall round or meal
  // log keeps its grants, so XP never drops); a grant the base already covers, or of a skipped repeat import, goes.
  const listed = new Set([...a.events, ...b.events].map((e) => e.id));
  const grantIds = new Set<string>();
  const grants: RewardGrant[] = [];
  for (const g of [...a.grants, ...b.grants]) {
    if (grantIds.has(g.id) || covered.has(g.eventId) || (!seen.has(g.eventId) && listed.has(g.eventId))) continue;
    grantIds.add(g.id);
    grants.push(g);
  }
  const pendingUpload = [...new Set(opts.pendingFrom === 'b' ? b.pendingUpload : [...a.pendingUpload, ...b.pendingUpload])].filter((id) => seen.has(id));
  return { events, grants, base, pendingUpload, ...(ea > 0 ? { epoch: ea } : {}) };
}

/**
 * Partition by partition (C1 ruling): the guest's with the guest's, each account's with that same account's, never
 * across. An account's cached view is `b`'s when it has one (the newer write), else `a`'s.
 */
export function mergePartitions(
  a: Pick<PlayerState, 'progress' | 'accountProgress'>, b: Pick<PlayerState, 'progress' | 'accountProgress'>, opts: { pendingFrom?: 'both' | 'b' } = {},
): Pick<PlayerState, 'progress' | 'accountProgress'> {
  const accounts = new Map<string, AccountPartition>(Object.entries(a.accountProgress));
  for (const [key, pb] of Object.entries(b.accountProgress)) {
    const pa = accounts.get(key);
    const ea = pa?.progress.epoch ?? 0, eb = pb.progress.epoch ?? 0;
    // A pruned partition (a higher epoch) replaces the older copy outright, view included: nothing removed comes back.
    if (!pa || eb > ea) accounts.set(key, pb);
    else if (ea > eb) accounts.set(key, pa);
    else accounts.set(key, { progress: mergeProgress(pa.progress, pb.progress, opts), view: pb.view ?? pa.view });
  }
  return { progress: mergeProgress(a.progress, b.progress, opts), accountProgress: Object.fromEntries(accounts) };
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
      ...mergePartitions(stored, mine),
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
  /** The clock for on-device week retention (I3). */
  now: () => Date = () => new Date(),
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
      state = withRetainedWeek(importM3Toolkit(r.state), localDate(now()));
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
      // I3: a sign-in or a sign-out is a retention point for the device week.
      if ((base.account?.email ?? null) !== (next.account?.email ?? null)) next = withRetainedWeek(next, localDate(now()));
      // Earned data never goes down: the toolkit, and every progress event still held (a compaction in `fn` is kept).
      state = { ...next, toolkit: mergeToolkit(base.toolkit, next.toolkit), ...mergePartitions(base, next, { pendingFrom: 'b' }) };
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
