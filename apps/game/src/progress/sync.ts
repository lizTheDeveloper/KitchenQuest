import {
  grantsForBatch, type Catalogue, type FreshnessThresholds, type ProgressEvent, type ProgressView, type RewardGrant, type RewardsData, type RulesContext,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, ProgressPostResponse } from '../api/types';
import { content } from '../content';
import { partitionKey, partitionOf, withPartition, type PlayerStore } from '../state/store';
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
  /** Ask the account's view (GET /progress), when signed in; it is cached with that account's partition. */
  refreshAccountView(): Promise<void>;
  stop(): void;
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
  let lastAt = -Infinity;
  /** A 429 keeps everything unsent until then (Step 5 N2). */
  let blockedUntil = 0;
  let retryTimer: unknown = null;
  let uploading: Promise<void> | null = null;
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
      const r = await client.postProgressEvents(events, upload ? true : undefined);
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

  /** The account's view, cached with its own partition (M6), never another's. */
  function keepView(as: string, view: unknown) {
    if (!isProgressView(view) || liveKey() !== as) return;
    store.update((s) => (partitionKey(s) !== as ? s : withPartition(s, as, partitionOf(s, as), view)));
  }

  /** What the server answered, applied: reported ids are done in `from`'s partition, the view kept, warnings surfaced. */
  function landed(as: string, from: string | null, sent: ProgressEvent[], r: ProgressPostResponse) {
    // Every id sent was answered (accepted, duplicate or refused for good), so none is posted again.
    markUploaded(store, from, sent.map((e) => e.id));
    keepView(as, r.view);
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

  /** Post partition `from`'s pending events as account `as`, in order, 100 at a time, as an upload. */
  async function uploadFrom(as: string, from: string | null): Promise<boolean> {
    while (!stopped && liveKey() === as && deps.online() && blockedUntil <= now()) {
      const p = partitionOf(store.get(), from);
      const pending = new Set(p.pendingUpload);
      const events = p.events.filter((e) => pending.has(e.id)).slice(0, EVENTS_PER_REQUEST);
      if (events.length === 0) return true;
      const r = await post(as, events, true);
      if (r === null || !r.ok) return false; // offline, switched account, 429 (a retry is scheduled) or a server error: kept
      landed(as, from, events, r.data);
      if (from === null) {
        // The guest's progress the player chose to add now belongs to this account too: shown with it, never posted again.
        const g = partitionOf(store.get(), null);
        const ids = new Set(events.map((e) => e.id));
        appendEvents(store, as, events, g.grants.filter((x) => ids.has(x.eventId)), { pending: false, cat });
      }
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
      const local = ok.flatMap((r) => r.grants);
      if (key === null || !deps.online() || blockedUntil > now()) return local;

      // Signed in: the server decides. An event the device already holds is not sent again here.
      const send = results.filter((r) => !r.problems.includes('duplicate_id')).map((r) => r.event);
      if (send.length === 0) return local;
      if (send.length > EVENTS_PER_REQUEST) { void sync.uploadDeviceLog(); return local; } // too many for one live post
      const ids = new Set(send.map((e) => e.id));
      const timeout = new Promise<'late'>((resolve) => { setTimer(() => resolve('late'), liveWaitMs); });
      const r = await Promise.race([postLive(key, send), timeout]);
      if (r === 'late' || r === null || !r.ok) return local;
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
      return partitionKey(s) !== null && !s.settings.familyTable && partitionOf(s, null).pendingUpload.length > 0;
    },

    async addGuestProgress() {
      const as = liveKey();
      if (as === null || stopped) return false;
      return uploadFrom(as, null);
    },

    async flush() {
      if (liveKey() === null || !deps.online()) return;
      await Promise.race([sync.uploadDeviceLog(), wait(FLUSH_WAIT_MS)]);
    },

    async refreshAccountView() {
      const as = liveKey();
      if (stopped || as === null || !deps.online()) return;
      const r = await client.getProgress();
      if (r.ok) keepView(as, r.data.view);
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
