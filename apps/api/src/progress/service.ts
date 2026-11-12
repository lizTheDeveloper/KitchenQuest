import {
  deriveProgress,
  grantsForBatch,
  isHealthRevealing,
  isValidDate,
  MAX_ROUND_ANSWERS,
  type Catalogue,
  type FreshnessThresholds,
  type GrantResult,
  type ProgressEvent,
  type ProgressHistory,
  type ProgressView,
  type RewardGrant,
  type RewardsData,
  type RulesContext,
} from '@kitchenquest/core';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Keyring } from '../crypto/keyring.js';
import { lockUserProgress } from '../db/advisory-locks.js';
import { mealLogs, PROGRESS_KINDS } from '../db/schema.js';
import { insertEvents, loadHistory, type Tx } from './store.js';

/** At most this many events in one POST /progress/events (more is a 400); a device log goes up in chunks. */
export const MAX_EVENTS_PER_REQUEST = 100;
/** A live post's oldest `at`: today − 30. A sign-in upload (`upload: true`, Ruling 8, C14) goes back to the epoch. */
const LIVE_DAYS_BACK = 30;
/** The newest `at` for any post: the player's local date may be a day past the server's UTC date (as for meals). */
const DAYS_AHEAD = 1;
/** No event, and no imported record's date, is older than this (I4 ruling): before M3, nothing was played. */
const PROGRESS_EPOCH = '2026-01-01';

const REF_MAX = 200;
const MAX_CLAIMS = 20;
const MAX_IMPORTED_RECIPES = 100;

/** Client ids are opaque UUIDs (I3 ruling): no text the client chose outlives an erasure in a grant's `eventId`. */
const id = z.uuid();
const day = z.string().max(10);
const ref = z.string().max(REF_MAX);
const num = z.number();
const claims = z.array(ref).max(MAX_CLAIMS).optional();
/** A stall round's caps (M6 Step 6): a stall id, each question id, and a pick (a file option index, 3–4 options). */
const STALL_MAX = 40;
const QUESTION_MAX = 80;
const MAX_PICK = 3;

/**
 * Core's `ProgressEvent`, exactly: one strict shape per kind, so a key outside the shape (an amount, a level, trust,
 * a grant) never reaches the ledger. Values are only ids, dates, numbers and booleans; every id is then checked
 * against the catalogue by core `grantsFor` (and a meal log against the player's own logs), so no free text can land
 * in `progress_events.body`.
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
  z.object({ id, kind: z.literal('meal_logged'), at: day, minute: num, mealLogId: z.uuid() }).strict(),
  // M6: no key beside the stall and the answers (a forged "correct" flag or a score is `bad_event`); core
  // then decides each answer against the stall file and the player's rules.
  z
    .object({
      id,
      kind: z.literal('stall_round'),
      at: day,
      stall: z.string().max(STALL_MAX),
      answers: z
        .array(z.object({ q: z.string().max(QUESTION_MAX), pick: z.number().int().min(0).max(MAX_PICK) }).strict())
        .min(1)
        .max(MAX_ROUND_ANSWERS),
    })
    .strict(),
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
  /** Seals and opens the bodies of sealed kinds (every `stall_round`, M6 Step 6) with the player's data key. */
  keyring: Keyring;
  catalogue: Catalogue;
  rewards: RewardsData;
  thresholds: FreshnessThresholds;
  /**
   * The player's rules and content (I3), loaded only when an event carries a `standsInFor` claim or the batch holds a
   * `stall_round` (M6): core keeps the claim only when it holds for them, and accepts a round only when every question
   * is one their rules would show. Without it a claim is dropped (`stand_in_dropped`) and the cook earns as any cook,
   * and a round is rejected `rules_unknown`.
   */
  rules?: () => Promise<RulesContext>;
  /**
   * Share-locks the player's active `health_data` grant and says whether there is one (the app's `consentHeldIn`;
   * progress/ imports nothing from consent/). Asked only when the batch holds a `meal_logged` event: those are
   * accepted only with `health_data`, the gate of POST /meals (I1 ruling). Also asked when the batch holds an event core
   * `isHealthRevealing` names (a Protein Counter round, M6 Ruling 17): those need it too. Absent → neither is accepted.
   */
  healthConsent?: () => Promise<boolean>;
  /** The daily write cap (the app's `assertUnderWriteCap` on 'progress.record'): throws a 429 before anything is read or written. */
  writeCap?: () => Promise<void>;
}

export interface RecordResult {
  accepted: { clientId: string; grants: RewardGrant[] }[];
  /**
   * Client ids already recorded (an offline replay, a sign-in upload of events already sent), or an event already
   * covered by a recorded one (a second import of a technique, a second event for one meal log): nothing new stored.
   */
  duplicate: string[];
  /**
   * Events not recorded, each with why: core's `ProgressProblem`s, `bad_event` (a shape outside the event's, a client
   * id that is not a UUID), `unknown_kind`, `bad_date` (outside the window or before the epoch), `upload_only`,
   * `consent_required` (a meal-log event, or a health-revealing stall round, without `health_data`), `unknown_meal_log`
   * (not the player's own log of that day), `rules_unknown` (a stall round whose player's rules couldn't be read).
   */
  rejected: { clientId: string; problems: string[] }[];
  /** Accepted events with something set aside, e.g. `stand_in_dropped` (the claim was dropped, never the event). */
  warnings: { clientId: string; warnings: string[] }[];
  view: ProgressView;
}

const DAY_MS = 86_400_000;
/** `date` (YYYY-MM-DD) moved by `days` whole calendar days. */
const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The id to report a rejected event under: only ever an id of the accepted form, else ''. */
const clientIdOf = (raw: unknown): string => {
  const v = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof v === 'string' && id.safeParse(v).success ? v.toLowerCase() : '';
};

/**
 * What an event claims that only one recorded event may hold: an import's technique (once per technique, Ruling 8),
 * a meal-log event's log (one per log, I1 ruling). null for the other kinds.
 */
const claimOf = (e: ProgressEvent): string | null =>
  e.kind === 'imported' ? `import:${e.technique}` : e.kind === 'meal_logged' && e.mealLogId !== undefined ? `meal:${e.mealLogId}` : null;

/**
 * Core over the batch, so that a `duplicate` is only ever reported against what was stored or accepted (M3): a
 * repeated client id comes back from core as `duplicate_id` only when an earlier one in the batch was accepted, and an
 * event whose claim (technique, meal log) an earlier accepted event of the batch holds is set aside and the batch is
 * run again without it (core is pure, and an import or meal log grants or claims little, so this ends fast).
 */
function evaluate(candidates: ProgressEvent[], history: ProgressHistory, deps: ProgressDeps, rules: RulesContext | undefined) {
  let pending = candidates;
  const covered: string[] = [];
  for (;;) {
    const results = grantsForBatch(pending, history, deps.catalogue, deps.rewards, deps.thresholds, rules);
    const held = new Set<string>();
    const drop = new Set<number>();
    results.forEach((r, i) => {
      const claim = claimOf(r.event);
      if (claim === null || r.problems.length > 0) return;
      if (held.has(claim)) drop.add(i);
      else held.add(claim);
    });
    if (drop.size === 0) return { results, covered };
    for (const i of drop) covered.push(pending[i].id);
    pending = pending.filter((_, i) => !drop.has(i));
  }
}

/**
 * Records a batch of progress events for the player, inside the caller's transaction (Ruling 7). Order:
 * `lockLiveUser` (401) → advisory `progress:` (the last advisory lock) → the daily write cap (429) → when the batch has
 * a `meal_logged` event or a health-revealing `stall_round`, the `health_data` grant (share-locked: the consent row comes after the advisory locks) →
 * load the whole history (`base: null`; the account never compacts) → per event, in the order sent:
 * - a shape outside core's `ProgressEvent`, or a client id that is not a UUID → rejected `bad_event` (`unknown_kind`
 *   for a kind core doesn't have);
 * - a client id already stored (an erased event's id stays seen through its grants) → `duplicate`;
 * - an `at` before PROGRESS_EPOCH, past today + 1 or, live, before today − 30 → rejected `bad_date`;
 * - an `imported` event outside a sign-in upload → `upload_only`; one whose dates are before the epoch → `bad_date`;
 *   a technique already imported → `duplicate`;
 * - a `meal_logged` event without `health_data` → `consent_required`; one whose `mealLogId` is not the player's own
 *   log eaten on `at` → `unknown_meal_log`; a log that already has its event → `duplicate`;
 * - a `stall_round` core `isHealthRevealing` names (any Protein Counter question, or one the catalogue doesn't hold:
 *   fail closed) without `health_data` → `consent_required`; a base round needs no consent (M6 Ruling 17);
 * then the rest, sorted by `at` (stable), go through core `grantsForBatch` with the player's rules (fetched when an
 * event claims `standsInFor` or the batch holds a `stall_round`; see `evaluate`):
 * an event with problems is rejected and stores nothing; the others are stored as core returned them (a dropped claim
 * stripped) with their grants; every `stall_round` sealed (`insertEvents`).
 *
 * The daily cap is per event (C14): core's `too_many_events` rejects only an event past MAX_PROGRESS_EVENTS_PER_DAY
 * for its `at`, and the rest of the batch is still recorded. Never fails the whole batch for one bad event.
 * Audits 'progress.record' with counts only (no ids, slugs or quests), when anything was recorded; the write cap counts those.
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
  await deps.writeCap?.();

  const rejected: RecordResult['rejected'] = [];
  const parsed: ProgressEvent[] = [];
  for (const raw of events) {
    const kind = typeof raw === 'object' && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
    if (typeof kind !== 'string' || !(PROGRESS_KINDS as readonly string[]).includes(kind)) {
      rejected.push({ clientId: clientIdOf(raw), problems: [typeof raw === 'object' && raw !== null ? 'unknown_kind' : 'bad_event'] });
      continue;
    }
    const shaped = EventShape.safeParse(raw);
    if (!shaped.success) {
      rejected.push({ clientId: clientIdOf(raw), problems: ['bad_event'] });
      continue;
    }
    // zod drops an absent optional key; an explicit `standsInFor: undefined` goes too, so core sees the shape. Ids are
    // compared in lower case, so one UUID is one event however the client spells it.
    const e = Object.fromEntries(Object.entries(shaped.data).filter(([, v]) => v !== undefined)) as ProgressEvent;
    e.id = e.id.toLowerCase();
    if (e.kind === 'meal_logged') e.mealLogId = e.mealLogId?.toLowerCase();
    parsed.push(e);
  }

  // Consent before the data rows (the lock order), and only when a meal-log event or a health-revealing round asks for it.
  const meals = parsed.filter((e): e is Extract<ProgressEvent, { kind: 'meal_logged' }> => e.kind === 'meal_logged');
  const revealing = new Set(parsed.filter((e) => isHealthRevealing(e, deps.catalogue)));
  const health = (meals.length > 0 || revealing.size > 0) && deps.healthConsent !== undefined ? await deps.healthConsent() : false;
  const eatenOn = new Map<string, string>();
  if (health && meals.length > 0) {
    const ids = [...new Set(meals.map((m) => m.mealLogId ?? ''))];
    const own = await tx
      .select({ id: mealLogs.id, eatenOn: mealLogs.eatenOn })
      .from(mealLogs)
      .where(and(eq(mealLogs.userId, userId), inArray(mealLogs.id, ids)));
    for (const r of own) eatenOn.set(r.id, r.eatenOn);
  }

  const history = await loadHistory(tx, deps.keyring, userId);
  const seen = new Set([...history.events.map((e) => e.id), ...history.grants.map((g) => g.eventId)]);
  const claimed = new Set(history.events.map(claimOf).filter((c): c is string => c !== null));
  const oldest = opts.upload ? PROGRESS_EPOCH : [PROGRESS_EPOCH, addDays(today, -LIVE_DAYS_BACK)].sort()[1];
  const newest = addDays(today, DAYS_AHEAD);
  const inWindow = (d: string) => !isValidDate(d) || (d >= oldest && d <= newest);

  const duplicate: string[] = [];
  const candidates: ProgressEvent[] = [];
  for (const e of parsed) {
    if (seen.has(e.id)) {
      duplicate.push(e.id);
      continue;
    }
    if (!inWindow(e.at)) {
      rejected.push({ clientId: e.id, problems: ['bad_date'] });
      continue;
    }
    if (e.kind === 'imported') {
      if (!opts.upload) {
        rejected.push({ clientId: e.id, problems: ['upload_only'] });
        continue;
      }
      if ([e.firstAt, e.lastUsedAt].some((d) => isValidDate(d) && d < PROGRESS_EPOCH)) {
        rejected.push({ clientId: e.id, problems: ['bad_date'] });
        continue;
      }
    }
    if (e.kind === 'meal_logged') {
      if (!health) {
        rejected.push({ clientId: e.id, problems: ['consent_required'] });
        continue;
      }
      if (eatenOn.get(e.mealLogId ?? '') !== e.at) {
        rejected.push({ clientId: e.id, problems: ['unknown_meal_log'] });
        continue;
      }
    }
    if (revealing.has(e) && !health) {
      rejected.push({ clientId: e.id, problems: ['consent_required'] });
      continue;
    }
    const claim = claimOf(e);
    if (claim !== null && claimed.has(claim)) {
      duplicate.push(e.id);
      continue;
    }
    candidates.push(e);
  }
  // Array.prototype.sort is stable: events of the same day keep the order they were sent in.
  candidates.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  const needsRules = candidates.some((e) => Object.hasOwn(e, 'standsInFor') || e.kind === 'stall_round');
  const rules = deps.rules && needsRules ? await deps.rules() : undefined;
  const { results, covered } = evaluate(candidates, history, deps, rules);
  duplicate.push(...covered);

  const kept: GrantResult[] = [];
  for (const r of results) {
    if (r.problems.length === 0) kept.push(r);
    // core says duplicate_id only when an earlier event of this batch with that id was accepted.
    else if (r.problems.includes('duplicate_id')) duplicate.push(r.event.id);
    else rejected.push({ clientId: r.event.id, problems: [...r.problems] });
  }
  await insertEvents(tx, deps.keyring, userId, kept, at);
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

/** The view of the player's stored history (GET /progress); call it inside one read transaction (M1). */
export async function progressViewOf(db: Pick<Tx, 'select'>, keyring: Keyring, userId: string, catalogue: Catalogue): Promise<ProgressView> {
  return deriveProgress(await loadHistory(db, keyring, userId), catalogue);
}
