import {
  grantsForBatch, type Catalogue, type FreshnessThresholds, type ProgressEvent, type ProgressView, type RewardGrant, type RewardsData, type RulesContext,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, ProgressPostResponse } from '../api/types';
import { content } from '../content';
import type { PlayerStore } from '../state/store';
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
export const LIVE_WAIT_MS = 4_000;

export interface ProgressSyncDeps {
  store: PlayerStore;
  client: ApiClient;
  online(): boolean;
  /** The player's rules and content (I3): passed to core so a cook's `standsInFor` claim can be kept. */
  context?: () => RulesContext | undefined;
  /** Each account view the server sends (GET /progress, or a POST's `view`). */
  onAccountView?: (view: ProgressView) => void;
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
   * Record events from the game's own flow. Core judges them on the device first (the same checks as the server,
   * the daily cap included, C14) and the accepted ones join the device log. Signed out, the device's grants are
   * returned. Signed in, the events are posted (batched and paced) and the server's grants are returned; when the
   * server can't answer in time, the device's are, and the events stay queued for upload.
   */
  record(events: ProgressEvent[]): Promise<RewardGrant[]>;
  /**
   * On sign-in, and to replay: post every device event not yet uploaded, once, in log order, 100 per request, with
   * `upload: true` (Step 5: older dates and imports accepted). Duplicates are fine: ids make a replay a no-op.
   */
  uploadDeviceLog(): Promise<void>;
  /** Ask the account's view (GET /progress), when signed in. */
  refreshAccountView(): Promise<void>;
  stop(): void;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
/** The shape of a view the server sent; anything else is not used (the device view stands alone). */
export function isProgressView(v: unknown): v is ProgressView {
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
  const signedIn = () => store.get().account !== null;

  const wait = (ms: number) => new Promise<void>((resolve) => { setTimer(resolve, ms); });

  /** One request at a time, `gapMs` apart and never before a 429's wait is over. */
  let chain: Promise<unknown> = Promise.resolve();
  const post = (events: ProgressEvent[], upload: boolean): Promise<ApiResult<ProgressPostResponse>> => {
    const run = async () => {
      const at = Math.max(lastAt + gapMs, blockedUntil);
      const delay = at - now();
      if (delay > 0) await wait(delay);
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

  /** What the server answered, applied: reported ids are done, the view is kept, warnings surfaced. */
  function landed(sent: ProgressEvent[], r: ProgressPostResponse) {
    // Every id sent was answered (accepted, duplicate or refused for good), so none is posted again.
    markUploaded(store, sent.map((e) => e.id));
    if (isProgressView(r.view)) deps.onAccountView?.(r.view);
    if (Array.isArray(r.warnings) && r.warnings.length > 0) deps.onWarnings?.(r.warnings);
  }

  // Live events recorded while a request is waiting go together in the next one (N2: batched and paced).
  let buffer: { events: ProgressEvent[]; done: (r: ApiResult<ProgressPostResponse> | null) => void }[] = [];
  let pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (buffer.length > 0 && !stopped) {
        const take: typeof buffer = [];
        let n = 0;
        while (buffer.length > 0 && (take.length === 0 || n + buffer[0].events.length <= EVENTS_PER_REQUEST)) {
          const next = buffer.shift()!;
          take.push(next);
          n += next.events.length;
        }
        const events = take.flatMap((t) => t.events);
        let r: ApiResult<ProgressPostResponse> | null = null;
        try {
          r = await post(events, false);
          if (r.ok) landed(events, r.data);
        } finally {
          for (const t of take) t.done(r);
        }
      }
    } finally {
      pumping = false;
    }
  }
  const postLive = (events: ProgressEvent[]) =>
    new Promise<ApiResult<ProgressPostResponse> | null>((resolve) => { buffer.push({ events, done: resolve }); void pump(); });

  const sync: ProgressSync = {
    async record(events) {
      if (stopped || events.length === 0) return [];
      const s = store.get();
      if (s.settings.familyTable) return []; // §19, Ruling 25: Family Table mode keeps nothing
      const results = grantsForBatch(events, historyOf(s.progress), cat, rewards, thresholds, deps.context?.());
      const ok = results.filter((r) => r.problems.length === 0);
      const warned = ok.filter((r) => r.warnings.length > 0).map((r) => ({ clientId: r.event.id, warnings: [...r.warnings] }));
      if (warned.length > 0) deps.onWarnings?.(warned);
      // Store `result.event` (a dropped claim removed), never the event as sent. Meal logs are account-only.
      const kept = ok.filter((r) => r.event.kind !== 'meal_logged');
      appendEvents(store, kept.map((r) => r.event), kept.flatMap((r) => r.grants), { cat });
      const local = ok.flatMap((r) => r.grants);
      if (s.account === null || !deps.online() || blockedUntil > now()) return local;

      // Signed in: the server decides. An event the device already holds is not sent again here.
      const send = results.filter((r) => !r.problems.includes('duplicate_id')).map((r) => r.event);
      if (send.length === 0) return local;
      if (send.length > EVENTS_PER_REQUEST) { void sync.uploadDeviceLog(); return local; } // too many for one live post
      const ids = new Set(send.map((e) => e.id));
      const timeout = new Promise<'late'>((resolve) => { setTimer(() => resolve('late'), liveWaitMs); });
      const r = await Promise.race([postLive(send), timeout]);
      if (r === 'late' || r === null || !r.ok) return local;
      return r.data.accepted.filter((a) => ids.has(a.clientId)).flatMap((a) => a.grants);
    },

    uploadDeviceLog() {
      if (uploading) return uploading;
      uploading = (async () => {
        while (!stopped && signedIn() && deps.online() && blockedUntil <= now()) {
          const p = store.get().progress;
          const pending = new Set(p.pendingUpload);
          const events = p.events.filter((e) => pending.has(e.id)).slice(0, EVENTS_PER_REQUEST);
          if (events.length === 0) break;
          const r = await post(events, true);
          if (!r.ok) break; // offline, signed out, 429 (a retry is scheduled) or a server error: kept for later
          landed(events, r.data);
        }
      })().finally(() => { uploading = null; });
      return uploading;
    },

    async refreshAccountView() {
      if (stopped || !signedIn() || !deps.online()) return;
      const r = await client.getProgress();
      if (r.ok && isProgressView(r.data.view) && signedIn()) deps.onAccountView?.(r.data.view);
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
