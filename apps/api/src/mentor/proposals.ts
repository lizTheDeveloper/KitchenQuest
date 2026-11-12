import { randomUUID } from 'node:crypto';
import { isSevereCard, type ProposalCard, type ProposalKind, type ServerCard } from '@kitchenquest/core';
import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor } from '../crypto/userkeys.js';
import { mentorProposals, type PROPOSAL_KINDS, type PROPOSAL_STATUSES } from '../db/schema.js';
import type { Db } from '../types.js';
import { PROPOSAL_TTL_MS } from './constants.js';

// The stored kinds are exactly core's ProposalKind (both directions).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const kindsAgree: Same<(typeof PROPOSAL_KINDS)[number], ProposalKind> = true;
void kindsAgree;

type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** The seal contexts of a proposal row (C-3): its card, and the undo payload of the write it made. */
const proposalSealContext = (userId: string, rowId: string) => ({ table: 'mentor_proposals', userId, rowId });
const proposalUndoSealContext = (userId: string, rowId: string) => ({ table: 'mentor_proposals.undo', userId, rowId });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LoadedProposal {
  id: string;
  userId: string;
  conversationId: string | null;
  turnSeq: number | null;
  kind: ProposalKind;
  severe: boolean;
  status: ProposalStatus;
  card: ProposalCard;
  expiresAt: Date;
  decidedAt: Date | null;
  writeRef: string | null;
  /** The confirmed write's undo payload, or null. */
  undo: unknown;
}

type Row = typeof mentorProposals.$inferSelect;

async function load(tx: Tx, keyring: Keyring, row: Row): Promise<LoadedProposal> {
  return {
    id: row.id,
    userId: row.userId,
    conversationId: row.conversationId,
    turnSeq: row.turnSeq,
    kind: row.kind as ProposalKind,
    severe: row.severe,
    status: row.status as ProposalStatus,
    card: await openFor<ProposalCard>(tx, keyring, proposalSealContext(row.userId, row.id), row.sealed),
    expiresAt: row.expiresAt,
    decidedAt: row.decidedAt,
    writeRef: row.writeRef,
    undo: row.undoSealed ? await openFor<unknown>(tx, keyring, proposalUndoSealContext(row.userId, row.id), row.undoSealed) : null,
  };
}

/** Proposals never decided ('open' or 'expired') whose `expires_at` has passed at `now`. */
export const undecidedExpired = (now: Date) =>
  and(inArray(mentorProposals.status, ['open', 'expired']), lte(mentorProposals.expiresAt, now));

/**
 * Records a card the server is about to show (sealed, open, expiring after
 * PROPOSAL_TTL_MS) and returns it as the wire's `ServerCard`. First deletes
 * the user's undecided proposals that have expired. Only a card
 * recorded here can later be confirmed (Step 8's guard). `id` may be given
 * (a fresh uuid) so the turn can store its messages, which name it, first
 * (README lock order: messages before mentor_proposals).
 */
export async function createProposal(
  tx: Tx,
  keyring: Keyring,
  p: { userId: string; conversationId: string | null; turnSeq: number | null; card: ProposalCard; id?: string },
  now: Date,
): Promise<ServerCard> {
  // Undecided cards are not kept past their expiry (data-inventory I-4); the
  // retention job does the same for everyone, at most an hour late.
  await tx.delete(mentorProposals).where(and(eq(mentorProposals.userId, p.userId), undecidedExpired(now)));
  const id = p.id ?? randomUUID();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS);
  await tx.insert(mentorProposals).values({
    id,
    userId: p.userId,
    conversationId: p.conversationId,
    turnSeq: p.turnSeq,
    kind: p.card.kind,
    severe: isSevereCard(p.card),
    status: 'open',
    sealed: await sealFor(tx, keyring, proposalSealContext(p.userId, id), p.card, now),
    createdAt: now,
    expiresAt,
  });
  return { proposalId: id, expiresAt: expiresAt.toISOString(), card: p.card };
}

/**
 * Locks the caller's proposal (FOR UPDATE) and returns it opened, or null when
 * it is not theirs (or gone). An open proposal past `expires_at` reads as
 * 'expired' and is updated so. Always LAST in the global lock order (Step 3,
 * pre-flight C13): the caller already holds the user row, any advisory lock
 * and the consent row.
 */
export async function lockProposal(tx: Tx, keyring: Keyring, userId: string, id: string, now: Date): Promise<LoadedProposal | null> {
  if (!UUID.test(id)) return null;
  const row = (
    await tx
      .select()
      .from(mentorProposals)
      .where(and(eq(mentorProposals.id, id), eq(mentorProposals.userId, userId)))
      .for('update')
  ).at(0);
  if (!row) return null;
  if (row.status === 'open' && row.expiresAt.getTime() <= now.getTime()) {
    await tx.update(mentorProposals).set({ status: 'expired' }).where(eq(mentorProposals.id, id));
    row.status = 'expired';
  }
  return load(tx, keyring, row);
}

/**
 * The kind and write ref of the caller's proposal, without a lock and without
 * opening it, so confirm and undo can take their locks first: the advisory
 * lock for the kind, and for an undo the written data row (`rules` /
 * `meal_logs`), which comes before `mentor_proposals` in the global order.
 */
export async function peekProposal(
  tx: Tx,
  _keyring: Keyring,
  userId: string,
  id: string,
): Promise<{ kind: ProposalKind; writeRef: string | null } | null> {
  if (!UUID.test(id)) return null;
  const row = (
    await tx
      .select({ kind: mentorProposals.kind, writeRef: mentorProposals.writeRef })
      .from(mentorProposals)
      .where(and(eq(mentorProposals.id, id), eq(mentorProposals.userId, userId)))
  ).at(0);
  return row ? { kind: row.kind as ProposalKind, writeRef: row.writeRef } : null;
}

/**
 * M7 Step 5 (Ruling 15): the card of the caller's proposal, opened, with no lock and nothing written; null when the id
 * is not a uuid or not theirs. The voice route speaks its code-built read-back (§7.6b.2), never anything the client sent.
 */
export async function readProposalCard(db: Pick<Db, 'select'>, keyring: Keyring, userId: string, id: string): Promise<ProposalCard | null> {
  if (!UUID.test(id)) return null;
  const row = (
    await db
      .select({ sealed: mentorProposals.sealed })
      .from(mentorProposals)
      .where(and(eq(mentorProposals.id, id), eq(mentorProposals.userId, userId)))
  ).at(0);
  return row ? openFor<ProposalCard>(db, keyring, proposalSealContext(userId, id), row.sealed) : null;
}

/** The caller's proposals still open (not expired at `now`) from one turn of one conversation, oldest first. No lock. */
export async function openProposalsOfTurn(
  tx: Tx,
  keyring: Keyring,
  userId: string,
  conversationId: string,
  turnSeq: number,
  now: Date,
): Promise<LoadedProposal[]> {
  if (!UUID.test(conversationId)) return [];
  const rows = await tx
    .select()
    .from(mentorProposals)
    .where(
      and(
        eq(mentorProposals.userId, userId),
        eq(mentorProposals.conversationId, conversationId),
        eq(mentorProposals.turnSeq, turnSeq),
        eq(mentorProposals.status, 'open'),
        gt(mentorProposals.expiresAt, now),
      ),
    )
    .orderBy(asc(mentorProposals.createdAt), asc(mentorProposals.id));
  const out: LoadedProposal[] = [];
  for (const row of rows) out.push(await load(tx, keyring, row));
  return out;
}

/** Whether the conversation has an open (unexpired) rule or meal card: half of the health gate (pre-flight C1). No lock, nothing opened. */
export async function hasOpenHealthProposal(tx: Tx, userId: string, conversationId: string, now: Date): Promise<boolean> {
  if (!UUID.test(conversationId)) return false;
  const rows = await tx
    .select({ id: mentorProposals.id })
    .from(mentorProposals)
    .where(
      and(
        eq(mentorProposals.userId, userId),
        eq(mentorProposals.conversationId, conversationId),
        eq(mentorProposals.status, 'open'),
        gt(mentorProposals.expiresAt, now),
        inArray(mentorProposals.kind, ['rule', 'meal']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The caller's proposals still open (not expired at `now`) in one conversation, any turn, oldest first. No lock. */
export async function openProposalsOfConversation(
  tx: Tx,
  keyring: Keyring,
  userId: string,
  conversationId: string,
  now: Date,
): Promise<LoadedProposal[]> {
  if (!UUID.test(conversationId)) return [];
  const rows = await tx
    .select()
    .from(mentorProposals)
    .where(
      and(
        eq(mentorProposals.userId, userId),
        eq(mentorProposals.conversationId, conversationId),
        eq(mentorProposals.status, 'open'),
        gt(mentorProposals.expiresAt, now),
      ),
    )
    .orderBy(asc(mentorProposals.createdAt), asc(mentorProposals.id));
  const out: LoadedProposal[] = [];
  for (const row of rows) out.push(await load(tx, keyring, row));
  return out;
}

/**
 * Records the decision on the caller's proposal (held by `lockProposal`):
 * status, `decided_at = now`, and the undo payload (sealed under its own
 * context; null clears it, e.g. once undone). `channel` and `writeRef` are
 * set when given and kept when null, so an undone row still records how it
 * was confirmed and what it wrote. Another user's id changes nothing.
 */
export async function markDecided(
  tx: Tx,
  id: string,
  status: 'confirmed' | 'rejected' | 'undone',
  channel: 'tap' | 'typed_yes' | null,
  writeRef: string | null,
  undo: unknown,
  keyring: Keyring,
  userId: string,
  now: Date,
): Promise<void> {
  if (!UUID.test(id)) return;
  const mine = and(eq(mentorProposals.id, id), eq(mentorProposals.userId, userId));
  const updated = await tx
    .update(mentorProposals)
    .set({
      status,
      // A null keeps what the confirm recorded (an 'undone' row still says how it was confirmed and what it wrote).
      channel: sql`coalesce(${channel}, ${mentorProposals.channel})`,
      writeRef: sql`coalesce(${writeRef}::uuid, ${mentorProposals.writeRef})`,
      undoSealed: null,
      decidedAt: now,
    })
    .where(mine)
    .returning({ id: mentorProposals.id });
  // Sealed only once the row is known to be the caller's, so no data key is made for anyone else.
  if (updated.length === 0 || undo === null || undo === undefined) return;
  const undoSealed = await sealFor(tx, keyring, proposalUndoSealContext(userId, id), undo, now);
  await tx.update(mentorProposals).set({ undoSealed }).where(mine);
}

/** A proposal as the export lists it: the card decrypted and its status; the undo payload and write ref stay out. */
export interface ExportedProposal {
  id: string;
  conversationId: string | null;
  turnSeq: number | null;
  kind: ProposalKind;
  severe: boolean;
  status: ProposalStatus;
  card: ProposalCard;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
}

/** All of the user's proposals, cards decrypted, oldest first (C-7). Throws if any cannot be opened. */
export async function loadProposalsForExport(db: Pick<Db, 'select'>, keyring: Keyring, userId: string): Promise<ExportedProposal[]> {
  const rows = await db
    .select()
    .from(mentorProposals)
    .where(eq(mentorProposals.userId, userId))
    .orderBy(asc(mentorProposals.createdAt), asc(mentorProposals.id));
  const out: ExportedProposal[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      conversationId: r.conversationId,
      turnSeq: r.turnSeq,
      kind: r.kind as ProposalKind,
      severe: r.severe,
      status: r.status as ProposalStatus,
      card: await openFor<ProposalCard>(db, keyring, proposalSealContext(userId, r.id), r.sealed),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      decidedAt: r.decidedAt,
    });
  }
  return out;
}
