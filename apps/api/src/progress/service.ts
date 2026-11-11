import {
  deriveProgress,
  grantsForBatch,
  isValidDate,
  type Catalogue,
  type FreshnessThresholds,
  type ProgressEvent,
  type ProgressView,
  type RewardGrant,
  type RewardsData,
  type RulesContext,
} from '@kitchenquest/core';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import { lockUserProgress } from '../db/advisory-locks.js';
import { PROGRESS_KINDS } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { eraseMealEventIn, insertEvents, loadHistory, type Tx } from './store.js';

/** At most this many events in one POST /progress/events (more is a 400); a device log goes up in chunks. */
export const MAX_EVENTS_PER_REQUEST = 100;
/** A live post's oldest `at`: today − 30. A sign-in upload (`upload: true`, Ruling 8, C14) has no lower bound. */
const LIVE_DAYS_BACK = 30;
/** The newest `at` for any post: the player's local date may be a day past the server's UTC date (as for meals). */
const DAYS_AHEAD = 1;

const ID_MAX = 128;
const REF_MAX = 200;
const MAX_CLAIMS = 20;
const MAX_IMPORTED_RECIPES = 100;

const id = z.string().min(1).max(ID_MAX);
const day = z.string().max(10);
const ref = z.string().max(REF_MAX);
const num = z.number();
const claims = z.array(ref).max(MAX_CLAIMS).optional();

/**
 * Core's `ProgressEvent`, exactly: one strict shape per kind, so a key outside the shape (an amount, a level, trust,
 * a grant) never reaches the ledger. Values are only ids, dates, numbers and booleans; every id is then checked
 * against the catalogue by core `grantsFor`, so no free text can land in `progress_events.body`.
 */
const EventShape = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('lesson'), at: day, recipe: ref }).strict(),
  z.object({ id, kind: z.literal('drill'), at: day, quest: ref, step: num, technique: ref }).strict(),
  z.object({ id, kind: z.literal('cooked'), at: day, recipe: ref, planned: z.boolean(), standsInFor: claims }).strict(),
  z.object({ id, kind: z.literal('frame_cooked'), at: day, frame: ref, technique: ref, standsInFor: claims }).strict(),
  z.object({ id, kind: z.literal('quest_step'), at: day, quest: ref, step: num }).strict(),
  z.object({ id, kind: z.literal('quest_done'), at: day, quest: ref }).strict(),
  z.object({ id, kind: z.literal('recognized'), at: day, quest: ref, technique: ref }).strict(),
  z.object({ id, kind: z.literal('market_run'), at: day, weekStart: day }).strict(),
  z.object({ id, kind: z.literal('meal_logged'), at: day, minute: num }).strict(),
  z
    .object({
      id,
      kind: z.literal('imported'),
      at: day,
      technique: ref,
      tier: z.enum(['seen', 'tried', 'yours']),
      firstAt: day,
      lastUsedAt: day,
      recipes: z.array(ref).max(MAX_IMPORTED_RECIPES),
    })
    .strict(),
]);

/** The body of POST /progress/events. Strict: a key beside `events` and `upload` (`{ xp: 999 }`) is a 400. */
export const EventsBody = z
  .object({
    events: z.array(z.unknown()).max(MAX_EVENTS_PER_REQUEST),
    upload: z.literal(true).optional(),
  })
  .strict();

export interface ProgressDeps {
  catalogue: Catalogue;
  rewards: RewardsData;
  thresholds: FreshnessThresholds;
  /**
   * The player's rules and content (I3), loaded only when an event carries a `standsInFor` claim: core keeps the claim
   * only when it holds for them. Without it a claim is dropped (`stand_in_dropped`) and the cook earns as any cook.
   */
  rules?: () => Promise<RulesContext>;
}

export interface RecordResult {
  accepted: { clientId: string; grants: RewardGrant[] }[];
  /** Client ids already recorded (an offline replay, a sign-in upload of events already sent): nothing new is stored. */
  duplicate: string[];
  /** Events not recorded, each with why (core's `ProgressProblem`s, `bad_event` for a shape outside the event's, `upload_only`). */
  rejected: { clientId: string; problems: string[] }[];
  /** Accepted events with something set aside, e.g. `stand_in_dropped` (the claim was dropped, never the event). */
  warnings: { clientId: string; warnings: string[] }[];
  view: ProgressView;
}

const DAY_MS = 86_400_000;
/** `date` (YYYY-MM-DD) moved by `days` whole calendar days. */
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const clientIdOf = (raw: unknown): string => {
  const v = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof v === 'string' ? v.slice(0, ID_MAX) : '';
};

/**
 * Records a batch of progress events for the player, inside the caller's transaction (Ruling 7). Order:
 * `lockLiveUser` (401) → advisory `progress:` (the last advisory lock) → load the whole history (`base: null`; the
 * account never compacts) → per event, in the order sent: a shape outside core's `ProgressEvent` → rejected
 * `bad_event`; a client id already recorded, or repeated in the batch → `duplicate` (idempotent replay, nothing
 * stored); an `at` outside the window → rejected `bad_date`; an `imported` event outside a sign-in upload →
 * rejected `upload_only`, and a second import of a technique already imported → `duplicate` → then the rest, sorted
 * by `at` (stable), go through core `grantsForBatch` with the player's rules: an event with problems is rejected and
 * stores nothing; the others are stored as core returned them (a dropped claim stripped) with their grants.
 *
 * The daily cap is per event (C14): core's `too_many_events` rejects only an event past MAX_PROGRESS_EVENTS_PER_DAY
 * for its `at`, and the rest of the batch is still recorded. Never fails the whole batch for one bad event.
 *
 * Window: a live post (`upload: false`) needs `at` within [today − 30, today + 1]; a sign-in upload (`upload: true`,
 * Ruling 8) accepts any valid `at` up to today + 1, still validated against the catalogue and idempotent by client id.
 * Audits 'progress.record' with counts only (no ids, slugs or quests), when anything was recorded.
 */
export async function recordEventsIn(
  tx: Tx,
  deps: ProgressDeps,
  userId: string,
  events: unknown[],
  today: string,
  at: Date,
  opts: { upload: boolean },
  requestId?: string,
): Promise<RecordResult> {
  await lockLiveUser(tx, userId);
  await lockUserProgress(tx, userId);
  const history = await loadHistory(tx, userId);

  // Erased events' ids stay seen through their grants (I2 ruling), so a replay of one is a duplicate too.
  const seen = new Set([...history.events.map((e) => e.id), ...history.grants.map((g) => g.eventId)]);
  const importedTechniques = new Set(history.events.flatMap((e) => (e.kind === 'imported' ? [e.technique] : [])));
  const oldest = opts.upload ? null : addDays(today, -LIVE_DAYS_BACK);
  const newest = addDays(today, DAYS_AHEAD);

  const rejected: RecordResult['rejected'] = [];
  const duplicate: string[] = [];
  const candidates: ProgressEvent[] = [];
  for (const raw of events) {
    const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string' || !(PROGRESS_KINDS as readonly string[]).includes(kind)) {
      rejected.push({ clientId: clientIdOf(raw), problems: [typeof raw === 'object' && raw !== null ? 'unknown_kind' : 'bad_event'] });
      continue;
    }
    const parsed = EventShape.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ clientId: clientIdOf(raw), problems: ['bad_event'] });
      continue;
    }
    // zod drops an absent optional key; an explicit `standsInFor: undefined` goes too, so core sees the shape.
    const e = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as ProgressEvent;
    if (seen.has(e.id)) {
      duplicate.push(e.id);
      continue;
    }
    if (isValidDate(e.at) && (e.at > newest || (oldest !== null && e.at < oldest))) {
      rejected.push({ clientId: e.id, problems: ['bad_date'] });
      continue;
    }
    if (e.kind === 'imported') {
      if (!opts.upload) {
        rejected.push({ clientId: e.id, problems: ['upload_only'] });
        continue;
      }
      if (importedTechniques.has(e.technique)) {
        duplicate.push(e.id);
        continue;
      }
      importedTechniques.add(e.technique);
    }
    seen.add(e.id);
    candidates.push(e);
  }
  // Array.prototype.sort is stable: events of the same day keep the order they were sent in.
  candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const rules = deps.rules && candidates.some((e) => Object.hasOwn(e, 'standsInFor')) ? await deps.rules() : undefined;
  const results = grantsForBatch(candidates, history, deps.catalogue, deps.rewards, deps.thresholds, rules);

  const kept = results.filter((r) => r.problems.length === 0);
  for (const r of results) if (r.problems.length > 0) rejected.push({ clientId: r.event.id, problems: [...r.problems] });
  await insertEvents(tx, userId, kept, at);
  if (kept.length > 0) {
    await audit(
      tx,
      {
        actorKind: 'user',
        actorId: userId,
        subjectUserId: userId,
        action: 'progress.record',
        target: `accepted:${kept.length} duplicate:${duplicate.length} rejected:${rejected.length}`,
        requestId,
      },
      at,
    );
  }
  const view = deriveProgress(
    { events: [...history.events, ...kept.map((r) => r.event)], grants: [...history.grants, ...kept.flatMap((r) => r.grants)], base: null },
    deps.catalogue,
  );
  return {
    accepted: kept.map((r) => ({ clientId: r.event.id, grants: r.grants })),
    duplicate,
    rejected,
    warnings: kept.filter((r) => r.warnings.length > 0).map((r) => ({ clientId: r.event.id, warnings: [...r.warnings] })),
    view,
  };
}

/**
 * Erases one `meal_logged` event by the client id the game gave it (a meal-log undo, spec §6), inside the caller's
 * transaction: `lockLiveUser` (401) → `progress:` → delete. Its grants stay, so XP, level and the day's nourishment
 * count never drop, and nothing of the event is kept. 404 when no `meal_logged` event of the player's has that id
 * (every other kind is never erased). Audits 'progress.erase' with the kind only.
 */
export async function eraseMealEventFor(tx: Tx, userId: string, clientId: string, at: Date, requestId?: string): Promise<void> {
  await lockLiveUser(tx, userId);
  await lockUserProgress(tx, userId);
  if (clientId.length === 0 || clientId.length > ID_MAX || !(await eraseMealEventIn(tx, userId, clientId))) {
    throw new ApiError(404, 'not_found', 'Meal-log event not found');
  }
  await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'progress.erase', target: 'meal_logged', requestId }, at);
}

/** The view of the player's stored history (GET /progress). */
export async function progressViewOf(db: Pick<Tx, 'select'>, userId: string, catalogue: Catalogue): Promise<ProgressView> {
  return deriveProgress(await loadHistory(db, userId), catalogue);
}
