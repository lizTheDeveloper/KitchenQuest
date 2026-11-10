import {
  confirmedLines,
  isSevereCard,
  rejectedLine,
  trailSummary,
  undoneLine,
  UNDO_WINDOW_MS,
  withSeverity,
  type ConfirmResponse,
  type PantryItem,
  type ProposalKind,
  type ReplyPart,
  type Severity,
  type TrailEntry,
} from '@kitchenquest/core';
import { and, desc, eq, gte } from 'drizzle-orm';
import { audit } from '../audit/audit.js';
import { lockLiveUser } from '../auth/live-user.js';
import type { Catalog } from '../catalog.js';
import { lockConsentIn, type Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { mentorProposals } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { createMealLogIn, deleteMealLogIn } from '../meals/service.js';
import { changePantryIn, lockUserPantry, restorePantryIn } from '../pantry/service.js';
import { applyProfilePatchIn } from '../profile/routes.js';
import { createRuleIn, deleteRuleIn, lockUserRules } from '../rules/service.js';
import { line } from './lines.js';
import { lockProposal, markDecided, peekProposal } from './proposals.js';

/**
 * The write guard (spec §7.6b.1). A proposal card becomes a write only here,
 * and only by a tap (`POST /mentor/proposals/:id/confirm`) or, for a single
 * non-severe card, a strict typed "yes" in the next turn (`runTurn`). The
 * model has no route to either. A severe card needs a tap, always (§7.6).
 * Every write runs through the service its REST route uses. Undo is §7.0's
 * "second short window" (UNDO_WINDOW_MS).
 *
 * Lock order (README, pre-flight C13): live user → the kind's advisory lock
 * (`rules:` or `pantry:`) → `health_data` consent (rule and meal cards; never
 * for an undo) → the proposal row (`lockProposal`). No conversation row is
 * ever taken (Step 6 carry), and the services re-take only locks already held.
 */

/** What the guard needs of the turn's deps (`TurnDeps` has both): sealing, and the graph and rule terms. */
export interface ConfirmDeps {
  keyring: Keyring;
  catalog: Catalog;
}

const notFound = () => new ApiError(404, 'not_found', 'Proposal not found');
const closed = () => new ApiError(409, 'proposal_closed', 'This card is no longer open');

/** Takes the locks a proposal of `kind` needs before its row: the advisory lock, then consent when `withConsent`. */
async function lockForKind(tx: Tx, userId: string, kind: ProposalKind, withConsent: boolean, at: Date): Promise<void> {
  if (kind === 'rule') await lockUserRules(tx, userId);
  if (kind === 'pantry') await lockUserPantry(tx, userId);
  if (withConsent && (kind === 'rule' || kind === 'meal')) await lockConsentIn(tx, userId, 'health_data', at);
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
): Promise<ConfirmResponse> {
  await lockLiveUser(tx, userId);
  const peeked = await peekProposal(tx, deps.keyring, userId, proposalId);
  if (peeked === null) throw notFound();
  await lockForKind(tx, userId, peeked.kind, true, at);
  const p = await lockProposal(tx, deps.keyring, userId, proposalId, at);
  if (p === null) throw notFound();
  if (p.status !== 'open') throw closed();
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
