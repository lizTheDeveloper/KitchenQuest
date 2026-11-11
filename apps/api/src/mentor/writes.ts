import {
  blockedDishLine,
  confirmedLines,
  markOffered,
  planBasis,
  rebasePlanCard,
  isSevereCard,
  rejectedLine,
  trailSummary,
  undoneLine,
  UNDO_WINDOW_MS,
  withSeverity,
  type ConfirmResponse,
  type PantryItem,
  type Plan,
  type PlanCard,
  type ProposalKind,
  type ReplyPart,
  type ServerCard,
  type Severity,
  type TrailEntry,
} from '@kitchenquest/core';
import { and, desc, eq, gte } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { mealLogs, mentorProposals, rules } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { createMealLogIn, deleteMealLogIn } from '../meals/service.js';
import { lockUserPlan, lockUserProgress } from '../db/advisory-locks.js';
import { changePantryIn, lockUserPantry, restorePantryIn } from '../pantry/service.js';
import { applyProfilePatchIn } from '../profile/routes.js';
import { createRuleIn, deleteRuleIn, lockUserRules } from '../rules/service.js';
import type { Db } from '../types.js';
import { checksFor, restorePlanIn, savePlanIn, type WeekDeps } from '../week/plan-service.js';
import { loadPlan } from '../week/store.js';
import { line } from './lines.js';
import { planCardContext, type WeekSource } from './plan-turn.js';
import { createProposal, lockProposal, markDecided, peekProposal } from './proposals.js';

/**
 * The write guard (spec §7.6b.1). A proposal card becomes a write only here,
 * and only by a tap (`POST /mentor/proposals/:id/confirm`) or, for a single
 * non-severe card, a strict typed "yes" in the next turn (`runTurn`). The
 * model has no route to either. A severe card needs a tap, always (§7.6).
 * Every write runs through the service its REST route uses. Undo is §7.0's
 * "second short window" (UNDO_WINDOW_MS).
 *
 * Lock order (README, pre-flight C13, M5): live user → the kind's advisory lock
 * (`rules:` for a rule card, `pantry:` for a pantry card, `plan:` for a plan card, `progress:` for a meal card,
 * confirm and undo: a meal log's delete cascades to its `meal_logged` progress event) → `health_data` consent (rule,
 * meal and plan cards; for an undo only a plan card's, which the plan service needs) → for an undo of a rule or meal, the written row (`rules` /
 * `meal_logs`, fix round 1 C1; a meal log's progress event goes with it) → the proposal row (`lockProposal`). No conversation row is
 * ever taken (Step 6 carry), and the services re-take only locks already held.
 */

/** What the guard needs of the turn's deps (`TurnDeps` has all): sealing, and the graph and rule terms. */
export interface ConfirmDeps {
  keyring: Keyring;
  catalog: Catalog;
  /** The week's content and recipe index, for a plan card (M5 Step 8). A plan card can't be written without it. */
  week?: WeekSource;
}

async function weekDepsOf(tx: Tx, deps: ConfirmDeps): Promise<WeekDeps> {
  if (deps.week === undefined) throw new Error('mentor writes: a plan card needs the week deps');
  return { keyring: deps.keyring, catalog: deps.catalog, loop: deps.week.loop, recipes: await deps.week.recipes.current(tx) };
}

const notFound = () => new ApiError(404, 'not_found', 'Proposal not found');
const closed = () => new ApiError(409, 'proposal_closed', 'This card is no longer open');

/** Takes the locks a proposal of `kind` needs before its row: the advisory lock, then consent when `withConsent`. */
async function lockForKind(tx: Tx, userId: string, kind: ProposalKind, withConsent: boolean, at: Date): Promise<void> {
  if (kind === 'rule') await lockUserRules(tx, userId);
  if (kind === 'pantry') await lockUserPantry(tx, userId);
  // M5 Step 8: a plan card writes through savePlanIn (and its undo through restorePlanIn), which take `plan:` and,
  // plans being health data (Step 6 ruling), the health_data grant, for the undo too. Both are taken here, before
  // the proposal row, in the global order.
  if (kind === 'plan') {
    await lockUserPlan(tx, userId);
    await lockConsentIn(tx, userId, 'health_data', at);
  }
  // A meal confirm or undo writes or deletes a meal log, whose delete cascades to its progress event (M5 I1):
  // `progress:` is the last advisory lock, before the consent row.
  if (kind === 'meal') await lockUserProgress(tx, userId);
  if (withConsent && (kind === 'rule' || kind === 'meal')) await lockConsentIn(tx, userId, 'health_data', at);
}

/** The plan undo payload: the week, and the plan that stood before the confirm (null: there was none, so undo deletes). */
interface PlanUndo {
  weekStart: string;
  previous: Plan | null;
}

/**
 * The plan a plan card saves: its week and items, its `hard`, and the week's One More Technique slot as stored now
 * (an offer the card shows marks an unanswered week 'offered'). Before anything is written its items are checked
 * with the player's rules as they are now: a dish that became ⛔ since the card was built (a rule added in between)
 * is 400 `plan_invalid` with `details.parts`, the `plan.blocked_dish` lines, and nothing is saved.
 */
async function planOfCard(tx: Tx, week: WeekDeps, userId: string, card: PlanCard): Promise<Plan> {
  const stored = await loadPlan(tx, week.keyring, userId, card.weekStart);
  // Fix round 1 M2: the week changed since the card was shown (an edit on Form 7-W): never saved over it.
  if (planBasis(stored) !== card.basis) throw new ApiError(409, 'plan_changed', 'This week changed since the card was shown');
  // M5 final m1: an offer the card shows marks an unanswered week 'offered', pinned to that technique and dish.
  const kept: Plan = { weekStart: card.weekStart, items: card.items, hard: card.hard, slot: stored?.slot ?? 'unanswered', ...(stored?.offer ? { offer: stored.offer } : {}) };
  const plan = markOffered(kept, card.offer);
  const blocked = (await checksFor(tx, week, userId, plan)).filter((c) => c.status === 'blocked');
  if (blocked.length > 0) {
    const slugs = [...new Set(blocked.map((c) => c.item.slug))];
    const parts: ReplyPart[] = slugs.map((slug) => ({
      kind: 'line',
      line: blockedDishLine(slug, blocked.find((c) => c.item.slug === slug)!.findings, week.recipes, week.catalog.graph),
    }));
    throw new ApiError(400, 'plan_invalid', 'A dish in this plan is now blocked by your rules', { problems: slugs.map((x) => `blocked: ${x}`), parts });
  }
  return plan;
}

/** The pantry undo payload: the rows the confirm removed (put back on undo) and the ids it added (removed on undo). */
interface PantryUndo {
  removed: (PantryItem & { id: string })[];
  addedIds: string[];
}

/**
 * Confirms the caller's open proposal and makes its write, inside the caller's
 * transaction. Throws 401 (account gone), 404 `not_found` (not theirs, or
 * gone: a purged card), 403 `consent_required` (rule and meal cards; the card
 * stays open, so a tap after granting works), 409 `proposal_closed` (decided
 * or expired), 400 `tap_required` (a severe card on any channel but a tap),
 * 400 `bad_request` (an edit on a card that is not a rule, or the service's
 * validation). Any throw rolls the transaction back, so the card stays open.
 * With `inConversation` given (the tap names the conversation the player is in
 * now), a proposal from any other conversation, or from none, is 409
 * `proposal_closed`: a card from before a clear is never written (fix round 5, H2).
 */
export async function confirmProposalIn(
  tx: Tx,
  deps: ConfirmDeps,
  userId: string,
  proposalId: string,
  channel: 'tap' | 'typed_yes',
  edits: { severity?: Severity } | undefined,
  at: Date,
  requestId?: string,
  inConversation?: string | null,
  /** The player's local date (Step 6 I2), for a plan card's week window; the UTC date of `at` when absent. */
  today?: string,
): Promise<ConfirmResponse> {
  await lockLiveUser(tx, userId);
  const peeked = await peekProposal(tx, deps.keyring, userId, proposalId);
  if (peeked === null) throw notFound();
  await lockForKind(tx, userId, peeked.kind, true, at);
  const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
  if (p === null) throw notFound();
  if (p.status !== 'open') throw closed();
  if (inConversation !== undefined && (p.conversationId === null || p.conversationId !== inConversation)) throw closed();
  // The stored flag and the card itself: either one makes it severe.
  if ((p.severe || isSevereCard(p.card)) && channel !== 'tap')
    throw new ApiError(400, 'tap_required', 'A severe rule needs a tap on its card');

  let card = p.card;
  if (edits?.severity !== undefined) {
    if (card.kind !== 'rule') throw new ApiError(400, 'bad_request', 'Only a rule card takes a severity edit');
    card = withSeverity(card, edits.severity, deps.catalog.graph, deps.catalog.ruleTerms);
  }

  let writeRef: string | null = null;
  let undo: unknown = null;
  let removedNames: string[] = [];
  switch (card.kind) {
    case 'rule': {
      const rule = await createRuleIn(tx, deps, userId, card.rule, at, requestId);
      writeRef = rule.id;
      break;
    }
    case 'meal': {
      const meal = await createMealLogIn(tx, deps, userId, card.meal, at, requestId);
      writeRef = meal.id;
      break;
    }
    case 'profile': {
      const { before } = await applyProfilePatchIn(tx, userId, card.patch, at);
      // Only the keys the card changed are put back on undo.
      undo = Object.fromEntries(Object.keys(card.patch).map((k) => [k, before[k as keyof typeof before]]));
      break;
    }
    case 'plan': {
      // M5 Step 8: the whole week the card shows, through the plan service (shape, week window, rules re-checked).
      const week = await weekDepsOf(tx, deps);
      const plan = await planOfCard(tx, week, userId, card);
      const { plan: saved, previous } = await savePlanIn(tx, week, userId, plan, at, requestId, today);
      writeRef = saved.id;
      undo = { weekStart: plan.weekStart, previous } satisfies PlanUndo;
      break;
    }
    case 'pantry': {
      // Exactly the rows resolved when the card was proposed; names are never matched again (Step 5 carry).
      const { removed, addedIds } = await changePantryIn(
        tx,
        deps,
        userId,
        { add: card.add, removeNames: [], removeIds: card.removeIds ?? [] },
        at,
        requestId,
      );
      undo = { removed, addedIds } satisfies PantryUndo;
      removedNames = removed.map((r) => r.name);
      break;
    }
  }
  // The lines come from core, as the client's card writer says them (pre-flight C14).
  const parts: ReplyPart[] = confirmedLines(card, removedNames).map((l) => ({ kind: 'line', line: l }));
  await markDecided(tx, p.id, 'confirmed', channel, writeRef, undo, deps.keyring, userId, at);
  await audit(
    tx,
    { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.confirm', target: p.id, requestId },
    at,
  );
  const trail: TrailEntry = {
    id: p.id,
    origin: 'server',
    kind: card.kind,
    summary: trailSummary(card),
    undoUntil: new Date(at.getTime() + UNDO_WINDOW_MS).toISOString(),
  };
  return { trail, parts };
}

/**
 * A confirm in its own transaction (the tap route and the typed yes). A plan card the rules now refuse (400
 * `plan_invalid`) is closed in a second transaction, so it can never be confirmed later, and the error is rethrown
 * with its `plan.blocked_dish` lines: nothing is half-saved, and the card is done (M5 Step 8).
 */
export async function confirmProposal(
  db: Db,
  deps: ConfirmDeps,
  userId: string,
  proposalId: string,
  channel: 'tap' | 'typed_yes',
  edits: { severity?: Severity } | undefined,
  at: Date,
  requestId?: string,
  inConversation?: string | null,
  today?: string,
  /** Where a re-offered card goes (a typed yes: the current turn); the stale card's own turn when absent. */
  reoffer?: { conversationId: string; turnSeq: number },
): Promise<ConfirmResponse> {
  try {
    return await db.transaction((tx) => confirmProposalIn(tx, deps, userId, proposalId, channel, edits, at, requestId, inConversation, today));
  } catch (e) {
    if (e instanceof ApiError && e.code === 'plan_changed') {
      const offered = await reofferPlanCard(db, deps, userId, proposalId, at, today ?? at.toISOString().slice(0, 10), requestId, reoffer);
      throw new ApiError(409, 'plan_changed', e.message, offered);
    }
    if (e instanceof ApiError && e.code === 'plan_invalid') {
      await db.transaction(async (tx) => {
        await lockLiveUser(tx, userId);
        const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
        if (p === null || p.status !== 'open' || p.kind !== 'plan') return;
        await markDecided(tx, p.id, 'rejected', null, null, null, deps.keyring, userId, at);
        await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.reject', target: p.id, requestId }, at);
      });
    }
    throw e;
  }
}

/**
 * Fix round 1 M2: a plan card whose week changed since it was shown is closed (rejected), and the same new items are
 * offered again on the week as it is now, re-checked: a fresh card (stored like any card) with its read-back, or
 * only the lines when nothing would change. Live user → `plan:` → health_data → the proposal rows, the global order.
 */
async function reofferPlanCard(
  db: Db,
  deps: ConfirmDeps,
  userId: string,
  proposalId: string,
  at: Date,
  today: string,
  requestId: string | undefined,
  reoffer: { conversationId: string; turnSeq: number } | undefined,
): Promise<{ card?: ServerCard; parts: ReplyPart[] }> {
  if (deps.week === undefined) throw new Error('mentor writes: a plan card needs the week deps');
  const week = deps.week;
  return db.transaction(async (tx) => {
    await lockLiveUser(tx, userId);
    await lockUserPlan(tx, userId);
    await lockConsentIn(tx, userId, 'health_data', at);
    const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
    if (p === null || p.status !== 'open' || p.card.kind !== 'plan') return { parts: [line('card.rejected')] };
    await markDecided(tx, p.id, 'rejected', null, null, null, deps.keyring, userId, at);
    await audit(tx, { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.reject', target: p.id, requestId }, at);
    const fresh = rebasePlanCard(p.card, await planCardContext(tx, { keyring: deps.keyring, catalog: deps.catalog, week }, userId, today));
    if ('none' in fresh) return { parts: fresh.none.map((l): ReplyPart => ({ kind: 'line', line: l })) };
    const card = await createProposal(
      tx,
      deps.keyring,
      { userId, conversationId: reoffer?.conversationId ?? p.conversationId, turnSeq: reoffer?.turnSeq ?? p.turnSeq, card: fresh },
      at,
    );
    return { card, parts: fresh.readback.map((l): ReplyPart => ({ kind: 'line', line: l })) };
  });
}

/**
 * Turns down the caller's open proposal; nothing is written. 401, 404
 * `not_found`, 409 `proposal_closed` as confirm. No advisory or consent lock:
 * nothing health is written (user row → proposal row, in the global order).
 */
export async function rejectProposalIn(
  tx: Tx,
  deps: ConfirmDeps,
  userId: string,
  proposalId: string,
  at: Date,
  requestId?: string,
): Promise<{ parts: ReplyPart[] }> {
  await lockLiveUser(tx, userId);
  const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
  if (p === null) throw notFound();
  if (p.status !== 'open') throw closed();
  await markDecided(tx, p.id, 'rejected', null, null, null, deps.keyring, userId, at);
  await audit(
    tx,
    { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.reject', target: p.id, requestId },
    at,
  );
  return { parts: [{ kind: 'line', line: rejectedLine(p.kind) }] };
}

/**
 * Reverses the write a confirmed proposal made, within UNDO_WINDOW_MS of the
 * confirm. A proposal that has vanished (forgotten, deleted by a `health_data`
 * withdraw, or not the caller's) answers `undo.nothing`, never an error (Step
 * 6 carry). 409 `proposal_closed` when it is not confirmed (undone included),
 * then 409 `undo_window_closed` past the window (pre-flight C44). No consent
 * is needed. A pantry that has filled up since (too_many_items) answers
 * `pantry.undo_full` and changes nothing, and the write stays undoable.
 * Nothing earned is touched (§6). `undone` says whether a write was reversed.
 *
 * It restores the value from BEFORE the confirm, even if the player edited it
 * since (fix round 1, M2): a profile card puts back its patched keys only (keys
 * it did not touch stay as they are now); a pantry card puts back exactly the
 * rows it removed and removes exactly the ids it added, so items added since
 * stay. The short window (UNDO_WINDOW_MS) bounds this.
 */
export async function undoWriteIn(
  tx: Tx,
  deps: ConfirmDeps,
  userId: string,
  proposalId: string,
  at: Date,
  requestId?: string,
): Promise<{ parts: ReplyPart[]; undone: boolean }> {
  const nothing = { parts: [line('undo.nothing')], undone: false };
  await lockLiveUser(tx, userId);
  const peeked = await peekProposal(tx, deps.keyring, userId, proposalId);
  if (peeked === null) return nothing;
  await lockForKind(tx, userId, peeked.kind, false, at);
  // Fix round 1 (C1): the written row is locked before the proposal row, in table order
  // (rules → meal_logs → … → mentor_proposals), as a withdraw-with-delete deletes them. Locking
  // the proposal first and then deleting the rule deadlocked against it (40P01). A withdraw that
  // committed first leaves no row here and no proposal below: nothing to undo. A status or window
  // check that fails below throws and rolls back, which releases this lock.
  if (peeked.writeRef !== null) await lockWrittenRow(tx, userId, peeked.kind, peeked.writeRef);
  const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
  if (p === null) return nothing;
  if (p.status !== 'confirmed') throw closed();
  if (p.decidedAt === null || at.getTime() > p.decidedAt.getTime() + UNDO_WINDOW_MS) {
    throw new ApiError(409, 'undo_window_closed', 'The time to undo this has passed');
  }
  // A 404 from a delete means the row is already gone (the player removed it another way): the undo still holds.
  const goneIsFine = async (f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  };
  switch (p.card.kind) {
    case 'rule':
      if (p.writeRef !== null) await goneIsFine(() => deleteRuleIn(tx, userId, p.writeRef!, at, requestId));
      break;
    case 'meal':
      if (p.writeRef !== null) await goneIsFine(() => deleteMealLogIn(tx, userId, p.writeRef!, at, requestId));
      break;
    case 'profile':
      await applyProfilePatchIn(tx, userId, p.undo ?? {}, at);
      break;
    case 'plan': {
      // The week's plan as it was before the confirm, or none (Step 6's restorePlanIn).
      const u = p.undo as PlanUndo | null;
      if (u !== null) await restorePlanIn(tx, await weekDepsOf(tx, deps), userId, u.weekStart, u.previous, at, requestId);
      break;
    }
    case 'pantry': {
      const u = (p.undo ?? { removed: [], addedIds: [] }) as PantryUndo;
      try {
        await restorePantryIn(tx, deps, userId, u.removed, u.addedIds, at, requestId);
      } catch (e) {
        // Thrown before anything is deleted or inserted, so the transaction is still clean.
        if (e instanceof ApiError && e.code === 'too_many_items')
          return { parts: [line('pantry.undo_full')], undone: false };
        throw e;
      }
      break;
    }
  }
  await markDecided(tx, p.id, 'undone', null, null, null, deps.keyring, userId, at);
  await audit(
    tx,
    { actorKind: 'user', actorId: userId, subjectUserId: userId, action: 'mentor.undo', target: p.id, requestId },
    at,
  );
  return {
    parts: [{ kind: 'line', line: undoneLine(p.card) }],
    undone: true,
  };
}

/** Locks (FOR UPDATE) the rule or meal log a confirmed card wrote, if it is still there. Other kinds have no such row. */
async function lockWrittenRow(tx: Tx, userId: string, kind: ProposalKind, writeRef: string): Promise<void> {
  const table = kind === 'rule' ? rules : kind === 'meal' ? mealLogs : null;
  if (table === null) return;
  await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, writeRef), eq(table.userId, userId)))
    .for('update');
}

/** The caller's newest confirmed proposal still within UNDO_WINDOW_MS at `at`, or null. No lock. */
export async function latestUndoable(tx: Tx, userId: string, at: Date): Promise<string | null> {
  const rows = await tx
    .select({ id: mentorProposals.id })
    .from(mentorProposals)
    .where(
      and(
        eq(mentorProposals.userId, userId),
        eq(mentorProposals.status, 'confirmed'),
        gte(mentorProposals.decidedAt, new Date(at.getTime() - UNDO_WINDOW_MS)),
      ),
    )
    .orderBy(desc(mentorProposals.decidedAt), desc(mentorProposals.id))
    .limit(1);
  return rows.at(0)?.id ?? null;
}
