import {
  grantsForBatch, isHealthRevealing, type Catalogue, type FreshnessThresholds, type ProgressEvent, type ProgressView, type RewardGrant, type RewardsData, type RulesContext,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, ProgressPostResponse } from '../api/types';
import { content } from '../content';
import { applyServerErasure, dropEvents, partitionKey, partitionOf, withPartition, type PlayerState, type PlayerStore } from '../state/store';
import { catalogueOf } from './catalogue';
import { appendEvents, historyOf, markUploaded } from './log';

/** The API takes at most this many events per request (Step 5's MAX_EVENTS_PER_REQUEST). */
export const EVENTS_PER_REQUEST = 100;
/**
 * The gap kept between progress requests, so a device stays under the API's 60 a minute (Step 5's
 * PROGRESS_REQUESTS_PER_MINUTE): live events recorded meanwhile ride in the next request together (N2 carry).
 */
export const PROGRESS_REQUEST_GAP_MS = 1_100;
/** How long a live record waits for the server's grants before the device's own are used (the post carries on). */
const LIVE_WAIT_MS = 4_000;
/** How long a sign-out waits for its account's pending events to go up before it hides the partition anyway. */
const FLUSH_WAIT_MS = 3_000;

export interface ProgressSyncDeps {
  store: PlayerStore;
  client: ApiClient;
  online(): boolean;
  /** The player's rules and content (I3): passed to core so a cook's `standsInFor` claim can be kept. */
  context?: () => RulesContext | undefined;
  /** Accepted events with something set aside (core's or the server's warnings, e.g. `stand_in_dropped`). */
  onWarnings?: (w: { clientId: string; warnings: string[] }[]) => void;
  catalogue?: Catalogue;
  /**
   * M6 Step 9 fix round 1 (I1): whether the signed-in account holds `health_data` consent now. Without it (or without
   * this), a health-revealing guest event (a Protein Counter round, core `isHealthRevealing`) is never moved.
   */
  healthConsent?: () => Promise<boolean>;
  /** Called when the guest add held such events back: open the consent card; `retry` moves them once granted. */
  onHeldForConsent?: (retry: () => void) => void;
  rewards?: RewardsData;
  thresholds?: FreshnessThresholds;
  now?: () => number;
  gapMs?: number;
  liveWaitMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface ProgressSync {
  /**
   * Record events from the game's flow into the live partition (C1 ruling: the guest's signed out, the signed-in
   * account's otherwise). Core judges them on the device first (the same checks as the server, the daily cap
   * included, C14), and the accepted ones (`result.event`) join that partition. Signed out, the device's grants are
   * returned. Signed in, the events are posted (batched and paced) and the server's grants are returned; when the
   * server can't answer in time, the device's are, and the events stay queued for that account alone.
   */
  record(events: ProgressEvent[]): Promise<RewardGrant[]>;
  /**
   * Post the signed-in account's own pending events, once, in log order, 100 per request, with `upload: true`
   * (Step 5: older dates accepted). Never another partition's: guest progress goes up only through `addGuestProgress`.
   */
  uploadDeviceLog(): Promise<void>;
  /** Whether the guest partition holds progress the signed-in account could take (the "Add this device's progress" offer). */
  guestOffer(): boolean;
  /** After the player's explicit tap only (C1 ruling): post the guest partition's pending events to the signed-in account. */
  addGuestProgress(): Promise<boolean>;
  /** Before a sign-out: post what the account still holds, if online, waiting at most a few seconds. */
  flush(): Promise<void>;
  /**
   * Fix round 1 I2: a meal log was undone (DELETE /meals/:id): its `meal_logged` event, if still waiting on this device,
   * goes now and is never posted.
   */
  forgetMeal(mealLogId: string): void;
  /** Ask the account's view (GET /progress), when signed in; it is cached with that account's partition. */
  refreshAccountView(): Promise<void>;
  stop(): void;
}

/** Partition `key` with the server's grants in place of the device's for each accepted event listed (M6 final M1). */
function adoptGrants(s: PlayerState, key: string, accepted: { clientId: string; grants: RewardGrant[] }[]): PlayerState {
  const p = partitionOf(s, key);
  const ids = new Set(accepted.map((a) => a.clientId).filter((id) => p.events.some((e) => e.id === id)));
  if (ids.size === 0) return s;
  const server = accepted.filter((a) => ids.has(a.clientId)).flatMap((a) => (Array.isArray(a.grants) ? a.grants : []));
  // A deliberate removal of the device's grants: the epoch keeps a merge with an older copy from bringing them back.
  return withPartition(s, key, { ...p, grants: [...p.grants.filter((g) => !ids.has(g.eventId)), ...server], epoch: (p.epoch ?? 0) + 1 });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** The shape of a view the server sent; anything else is not used (the device view stands alone). */
function isProgressView(v: unknown): v is ProgressView {
  return isObj(v) && typeof v.xp === 'number' && typeof v.level === 'number' && typeof v.stamps === 'number' && isObj(v.trust) &&
    isObj(v.toolkit) && isObj(v.toolkit.techniques) && Array.isArray(v.questsDone) && isObj(v.questSteps) &&
    isObj(v.questStartedOn) && isObj(v.cookedOn) && isObj(v.framesCookedOn);
}

/** Seconds a 429 asks us to wait: the body's `retryAfterSeconds`, else the `retry-after` header, else a minute. */
function retryAfterMs(r: ApiResult<unknown>): number {
  if (r.ok) return 0;
  const d = r.error.details;
  const secs = isObj(d) && typeof d.retryAfterSeconds === 'number' ? d.retryAfterSeconds : r.error.retryAfter ?? 60;
  return Math.max(1, secs) * 1000;
}

export function createProgressSync(deps: ProgressSyncDeps): ProgressSync {
  const { store, client } = deps;
  const cat = deps.catalogue ?? catalogueOf();
  const rewards = deps.rewards ?? content.rewards;
  const thresholds = deps.thresholds ?? content.techniques.freshness;
  const now = deps.now ?? (() => Date.now());
  const gapMs = deps.gapMs ?? PROGRESS_REQUEST_GAP_MS;
  const liveWaitMs = deps.liveWaitMs ?? LIVE_WAIT_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let stopped = false;
  /** Meal logs undone in this session (I2): their events are never posted. */
  const forgotten = new Set<string>();
  let lastAt = -Infinity;
  /** A 429 keeps everything unsent until then (Step 5 N2). */
  let blockedUntil = 0;
  let retryTimer: unknown = null;
  let uploading: Promise<void> | null = null;
  /** The guest add in flight (N2): one at a time, and the offer is hidden meanwhile. */
  let adding: Promise<boolean> | null = null;
  const liveKey = () => partitionKey(store.get());

  const wait = (ms: number) => new Promise<void>((resolve) => { setTimer(resolve, ms); });

  /**
   * One request at a time, `gapMs` apart and never before a 429's wait is over. `as` is the account the events
   * belong to: checked again right before the request goes, so nothing is ever posted under another account (C1).
   */
  let chain: Promise<unknown> = Promise.resolve();
  const post = (as: string, events: ProgressEvent[], upload: boolean): Promise<ApiResult<ProgressPostResponse> | null> => {
    const run = async () => {
      const at = Math.max(lastAt + gapMs, blockedUntil);
      const delay = at - now();
      if (delay > 0) await wait(delay);
      if (stopped || liveKey() !== as || !deps.online()) return null;
      lastAt = now();
      // I2: a meal undone while its event waited is never posted.
      const send = events.filter((e) => e.kind !== 'meal_logged' || e.mealLogId === undefined || !forgotten.has(e.mealLogId));
      if (send.length === 0) return null;
      // M7 Step 7 fix round 1 (I1): with the erasure id this device last acted on, so the server refuses (`erased`) any
      // stall round or meal-log event recorded before a health_data delete this device has not yet applied.
      const seen = Object.hasOwn(store.get().accountProgress, as) ? store.get().accountProgress[as].erasure ?? null : null;
      const r = await client.postProgressEvents(send, upload ? true : undefined, seen);
      if (!r.ok && r.status === 429) {
        blockedUntil = now() + retryAfterMs(r);
        scheduleRetry(blockedUntil - now());
      }
      return r;
    };
    const p = chain.then(run);
    chain = p.catch(() => undefined);
    return p;
  };

  function scheduleRetry(ms: number) {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimer(() => { retryTimer = null; void sync.uploadDeviceLog(); }, ms);
  }

  /**
   * The account's view, cached with its own partition (M6), never another's. M7 Step 7 (M6 fix review N1): first, the
   * server's erasure id (`healthErasure`): one this device has not acted on means a `health_data` delete happened, here
   * or on another device, so the partition's stall rounds and meal-log events go (`applyServerErasure`).
   */
  function keepView(as: string, view: unknown, erasure?: unknown) {
    if (liveKey() !== as) return;
    if (typeof erasure === 'string' && erasure !== '') store.update((s) => (partitionKey(s) !== as ? s : applyServerErasure(s, as, erasure)));
    if (!isProgressView(view)) return;
    store.update((s) => (partitionKey(s) !== as ? s : withPartition(s, as, partitionOf(s, as), view)));
  }

  /**
   * What the server answered, applied: reported ids are done in `from`'s partition, the view kept, warnings surfaced.
   * An answer that lands after its account signed out (N1): the server holds those events now, so they leave the
   * hidden partition outright, as the sign-out prune would have removed them.
   */
  function landed(as: string, from: string | null, sent: ProgressEvent[], r: ProgressPostResponse) {
    const ids = sent.map((e) => e.id);
    // M6 Step 9 fix round 1 (M8): an event the server refused is never filed under the account; it and the device's
    // grants for it leave the partition (a refused Protein Counter round without consent, say).
    const refused = Array.isArray(r.rejected) ? r.rejected.map((x) => x.clientId).filter((id) => ids.includes(id)) : [];
    if (from !== null && refused.length > 0) store.update((s) => dropEvents(s, from, refused));
    // I2: a meal_logged waited here only until the server answered (accepted, duplicate or refused, unknown_meal_log
    // included); the server holds the record now, so it leaves the device at once (Task 9 minimisation).
    const meals = sent.filter((e) => e.kind === 'meal_logged').map((e) => e.id);
    if (from !== null && meals.length > 0) store.update((s) => dropEvents(s, from, meals));
    // M6 final M1: a stall round's grants are the server's. The device judged first-correct from its own history only,
    // so a question first answered right on another device earned XP here that the server refused: the server's
    // grants replace the device's for each stall round it accepted (the shown view is the max with the server's).
    if (from !== null && Array.isArray(r.accepted)) {
      const rounds = new Set(sent.filter((e) => e.kind === 'stall_round').map((e) => e.id));
      const server = r.accepted.filter((a) => rounds.has(a.clientId));
      if (server.length > 0) store.update((s) => adoptGrants(s, from, server));
    }
    // Every id sent was answered (accepted, duplicate or refused for good), so none is posted again.
    if (from !== null && liveKey() !== as) store.update((s) => dropEvents(s, from, ids));
    else markUploaded(store, from, ids);
    keepView(as, r.view, r.healthErasure);
    if (Array.isArray(r.warnings) && r.warnings.length > 0) deps.onWarnings?.(r.warnings);
  }

  // Live events recorded while a request is waiting go together in the next one (N2: batched and paced).
  let buffer: { as: string; events: ProgressEvent[]; done: (r: ApiResult<ProgressPostResponse> | null) => void }[] = [];
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (buffer.length > 0 && !stopped) {
        const as = buffer[0].as;
        const take: typeof buffer = [];
        let n = 0;
        while (buffer.length > 0 && buffer[0].as === as && (take.length === 0 || n + buffer[0].events.length <= EVENTS_PER_REQUEST)) {
          const next = buffer.shift()!;
          take.push(next);
          n += next.events.length;
        }
        const events = take.flatMap((t) => t.events);
        let r: ApiResult<ProgressPostResponse> | null = null;
        try {
          r = await post(as, events, false);
          if (r?.ok) landed(as, as, events, r.data);
        } finally {
          for (const t of take) t.done(r);
        }
      }
    } finally {
      pumping = false;
    }
  }
  const postLive = (as: string, events: ProgressEvent[]) =>
    new Promise<ApiResult<ProgressPostResponse> | null>((resolve) => { buffer.push({ as, events, done: resolve }); void pump(); });

  /**
   * M7 Step 7 fix round 1 (I1): before any upload (sign-in, the retry after a 429 or a reconnect, the guest add), the
   * account's current erasure id is read (GET /progress) and applied, so rounds recorded before a health_data delete on
   * another device are erased here and never posted. False when the server can't be read: nothing is uploaded then.
   */
  async function learnErasure(as: string): Promise<boolean> {
    if (stopped || liveKey() !== as || !deps.online()) return false;
    const r = await client.getProgress();
    if (!r.ok) return false;
    keepView(as, r.data.view, r.data.healthErasure);
    return liveKey() === as;
  }

  /** Post partition `from`'s pending events as account `as`, in order, 100 at a time, as an upload. */
  async function uploadFrom(as: string, from: string | null): Promise<boolean> {
    if (!(await learnErasure(as))) return false;
    // Fix round 1 (I1): the guest's health-revealing events go to an account only with its health_data consent.
    let held = new Set<string>();
    if (from === null) {
      const g = partitionOf(store.get(), null);
      const pendingIds = new Set(g.pendingUpload);
      const revealing = g.events.filter((e) => pendingIds.has(e.id) && isHealthRevealing(e, cat)).map((e) => e.id);
      if (revealing.length > 0 && !(await (deps.healthConsent?.() ?? Promise.resolve(false)).catch(() => false))) {
        held = new Set(revealing);
        deps.onHeldForConsent?.(() => { void sync.addGuestProgress(); });
      }
    }
    while (!stopped && liveKey() === as && deps.online() && blockedUntil <= now()) {
      const p = partitionOf(store.get(), from);
      const pending = new Set(p.pendingUpload);
      const events = p.events.filter((e) => pending.has(e.id) && !held.has(e.id)).slice(0, EVENTS_PER_REQUEST);
      if (events.length === 0) return true;
      const r = await post(as, events, true);
      if (r === null || !r.ok) return false; // offline, switched account, 429 (a retry is scheduled) or a server error: kept
      if (from === null) {
        // N5: the guest's progress the player chose to add moves to the account: shown with it (while it is still
        // signed in), never posted again, and gone from the guest partition (the account's server holds it now).
        const g = partitionOf(store.get(), null);
        const sentIds = new Set(events.map((e) => e.id));
        // Fix round 1 (I1): only what the server took (accepted or a duplicate) moves. A refused event stays with the
        // guest, never filed under the account and never offered again.
        const refused = new Set(Array.isArray(r.data.rejected) ? r.data.rejected.map((x) => x.clientId) : []);
        const ids = new Set([...sentIds].filter((id) => !refused.has(id)));
        const moved = events.filter((e) => ids.has(e.id));
        if (liveKey() === as) appendEvents(store, as, moved, g.grants.filter((x) => ids.has(x.eventId)), { pending: false, cat });
        keepView(as, r.data.view, r.data.healthErasure);
        if (Array.isArray(r.data.warnings) && r.data.warnings.length > 0) deps.onWarnings?.(r.data.warnings);
        markUploaded(store, null, sentIds); // never posted again, even if the removal below were undone
        store.update((st) => dropEvents(st, null, ids));
      } else landed(as, from, events, r.data);
    }
    return false;
  }

  const sync: ProgressSync = {
    async record(events) {
      if (stopped || events.length === 0) return [];
      const s = store.get();
      if (s.settings.familyTable) return []; // §19, Ruling 25: Family Table mode keeps nothing
      const key = partitionKey(s);
      const results = grantsForBatch(events, historyOf(partitionOf(s, key)), cat, rewards, thresholds, deps.context?.());
      const ok = results.filter((r) => r.problems.length === 0);
      const warned = ok.filter((r) => r.warnings.length > 0).map((r) => ({ clientId: r.event.id, warnings: [...r.warnings] }));
      if (warned.length > 0) deps.onWarnings?.(warned);
      // Store `result.event` (a dropped claim removed), never the event as sent. Meal logs are account-only.
      const kept = ok.filter((r) => r.event.kind !== 'meal_logged');
      appendEvents(store, key, kept.map((r) => r.event), kept.flatMap((r) => r.grants), { cat });
      // I2: signed in, a meal_logged waits in that account's partition (never the guest's), holding only its own
      // fields and no grant (nothing is shown from it), until the server accepts or refuses it; then it leaves.
      if (key !== null) {
        const meals = ok.flatMap((r): ProgressEvent[] => (r.event.kind === 'meal_logged'
          ? [{ id: r.event.id, kind: 'meal_logged', at: r.event.at, minute: r.event.minute, ...(r.event.mealLogId === undefined ? {} : { mealLogId: r.event.mealLogId }) }]
          : []));
        appendEvents(store, key, meals, [], { cat });
      }
      const local = ok.flatMap((r) => r.grants);
      // M6 final M1: signed in, a stall round's XP is announced only from the server's grants. When the server can't
      // answer in time, the device's stall XP is not said (its stamp and round lines still are).
      const rounds = new Set(ok.filter((r) => r.event.kind === 'stall_round').map((r) => r.event.id));
      const said = key === null ? local : local.filter((g) => !(g.kind === 'xp' && rounds.has(g.eventId)));
      if (key === null || !deps.online() || blockedUntil > now()) return said;

      // Signed in: the server decides. An event the device already holds is not sent again here.
      const send = results.filter((r) => !r.problems.includes('duplicate_id')).map((r) => r.event);
      if (send.length === 0) return said;
      if (send.length > EVENTS_PER_REQUEST) { void sync.uploadDeviceLog(); return said; } // too many for one live post
      const ids = new Set(send.map((e) => e.id));
      const timeout = new Promise<'late'>((resolve) => { setTimer(() => resolve('late'), liveWaitMs); });
      const r = await Promise.race([postLive(key, send), timeout]);
      if (r === 'late' || r === null || !r.ok) return said;
      return r.data.accepted.filter((a) => ids.has(a.clientId)).flatMap((a) => a.grants);
    },

    uploadDeviceLog() {
      if (uploading) return uploading;
      const as = liveKey();
      if (as === null) return Promise.resolve();
      uploading = uploadFrom(as, as).then(() => undefined).finally(() => { uploading = null; });
      return uploading;
    },

    guestOffer() {
      const s = store.get();
      return adding === null && partitionKey(s) !== null && !s.settings.familyTable && partitionOf(s, null).pendingUpload.length > 0;
    },

    addGuestProgress() {
      if (adding) return adding;
      const as = liveKey();
      if (as === null || stopped) return Promise.resolve(false);
      adding = uploadFrom(as, null).finally(() => { adding = null; });
      return adding;
    },

    async flush() {
      if (liveKey() === null || !deps.online()) return;
      await Promise.race([sync.uploadDeviceLog(), wait(FLUSH_WAIT_MS)]);
    },

    forgetMeal(mealLogId) {
      forgotten.add(mealLogId);
      const key = liveKey();
      if (key === null) return;
      const ids = partitionOf(store.get(), key).events
        .filter((e) => e.kind === 'meal_logged' && e.mealLogId === mealLogId).map((e) => e.id);
      if (ids.length > 0) store.update((s) => dropEvents(s, key, ids));
    },

    async refreshAccountView() {
      const as = liveKey();
      if (stopped || as === null || !deps.online()) return;
      const r = await client.getProgress();
      if (r.ok) keepView(as, r.data.view, r.data.healthErasure);
    },

    stop() {
      stopped = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      for (const b of buffer) b.done(null);
      buffer = [];
    },
  };
  return sync;
}
