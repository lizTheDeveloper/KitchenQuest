import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Tx } from '../consent/ledger.js';
import type { Keyring } from '../crypto/keyring.js';
import { openFor, sealFor } from '../crypto/userkeys.js';
import { conversations, mentorProposals, messages } from '../db/schema.js';
import type { Db } from '../types.js';
import { CONVERSATION_IDLE_MS, HISTORY_MESSAGES, TRANSCRIPT_RETENTION_DAYS } from './constants.js';
import type { MemoryHistory, StoredMessage } from './memory.js';

export type { StoredMessage } from './memory.js';

/** The seal context of a message row (C-3): bound to the table, owner and row. */
const messageSealContext = (userId: string, rowId: string) => ({ table: 'messages', userId, rowId });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The memory key of one conversation; `${userId}:` prefixes all of a user's. */
const memoryKey = (userId: string, conversationId: string) => `${userId}:${conversationId}`;

/**
 * The caller's conversation when `id` is theirs and its last turn was within
 * CONVERSATION_IDLE_MS, else a new one. Never another user's: an id that is
 * not theirs (or no uuid, or gone) starts a new conversation.
 */
export async function openConversation(tx: Tx, userId: string, id: string | null, now: Date): Promise<{ id: string; turnSeq: number }> {
  if (id !== null && UUID.test(id)) {
    const row = (
      await tx
        .select({ id: conversations.id, turnSeq: conversations.turnSeq })
        .from(conversations)
        .where(
          and(
            eq(conversations.id, id),
            eq(conversations.userId, userId),
            gt(conversations.lastTurnAt, new Date(now.getTime() - CONVERSATION_IDLE_MS)),
          ),
        )
    ).at(0);
    if (row) return row;
  }
  const [created] = await tx
    .insert(conversations)
    .values({ userId, startedAt: now, lastTurnAt: now, turnSeq: 0 })
    .returning({ id: conversations.id, turnSeq: conversations.turnSeq });
  return created;
}

/** Starts the next turn: `turn_seq + 1` and `last_turn_at = now`. Returns the new turn number. */
export async function bumpTurn(tx: Tx, conversationId: string, now: Date): Promise<number> {
  const row = (
    await tx
      .update(conversations)
      .set({ turnSeq: sql`${conversations.turnSeq} + 1`, lastTurnAt: now })
      .where(eq(conversations.id, conversationId))
      .returning({ turnSeq: conversations.turnSeq })
  ).at(0);
  if (!row) throw new Error('bumpTurn: no such conversation');
  return row.turnSeq;
}

/**
 * Appends `msgs` to the conversation. Persists them, sealed per row, only when
 * `persist` (the player has `health_data` consent, C-12); otherwise they go to
 * `memory` alone and nothing is stored. A persisting append holds the
 * conversation row (FOR UPDATE), so concurrent appends number their messages
 * one after the other; it throws if the conversation is not the caller's.
 *
 * The caller decides `persist` while holding the `health_data` consent row
 * (`lockConsentIn`, or a share-locked `hasConsent` read in the same
 * transaction), never from a read taken before it: a concurrent
 * withdraw-with-delete then either waits for this append and deletes what it
 * stored, or commits first and the turn sees no consent and keeps the
 * messages in memory only. Deciding from an earlier read could store
 * messages just after a withdrawal deleted them.
 */
export async function appendMessages(
  tx: Tx,
  keyring: Keyring,
  memory: MemoryHistory,
  userId: string,
  conversationId: string,
  msgs: StoredMessage[],
  persist: boolean,
  now: Date,
): Promise<void> {
  if (!persist) {
    memory.push(memoryKey(userId, conversationId), msgs, now.getTime());
    return;
  }
  if (msgs.length === 0) return;
  const owned = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .for('update');
  if (owned.length === 0) throw new Error("appendMessages: not the caller's conversation");
  const [last] = await tx
    .select({ seq: sql<number>`coalesce(max(${messages.seq}), 0)::int` })
    .from(messages)
    .where(eq(messages.conversationId, conversationId));
  let seq = last.seq;
  const rows = [];
  for (const msg of msgs) {
    const id = randomUUID();
    rows.push({
      id,
      conversationId,
      userId,
      seq: ++seq,
      role: msg.role,
      sealed: await sealFor(tx, keyring, messageSealContext(userId, id), msg, now),
      createdAt: now,
    });
  }
  await tx.insert(messages).values(rows);
}

/**
 * The conversation's last HISTORY_MESSAGES messages, oldest first: from the
 * database when `persist`, else from `memory`. Only the caller's, and never
 * one older than the transcript retention period (even before the job runs).
 */
export async function recentMessages(
  db: Db | Tx,
  keyring: Keyring,
  memory: MemoryHistory,
  userId: string,
  conversationId: string,
  persist: boolean,
  now: Date,
): Promise<StoredMessage[]> {
  if (!persist) return memory.get(memoryKey(userId, conversationId), now.getTime()).slice(-HISTORY_MESSAGES);
  if (!UUID.test(conversationId)) return [];
  const rows = await db
    .select({ id: messages.id, sealed: messages.sealed })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.userId, userId),
        gte(messages.createdAt, new Date(now.getTime() - TRANSCRIPT_RETENTION_DAYS * DAY_MS)),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(HISTORY_MESSAGES);
  const out: StoredMessage[] = [];
  for (const row of rows.reverse()) out.push(await openFor<StoredMessage>(db, keyring, messageSealContext(userId, row.id), row.sealed));
  return out;
}

/**
 * "Forget this conversation" (C-12), or all of them when `conversationId` is
 * left out, inside the caller's transaction (which has taken `lockLiveUser`).
 * Hard-deletes the conversations, their messages and the proposals they made
 * (forgetting all also deletes the user's proposals no conversation links any
 * more), and forgets the memory history. Only the caller's: another user's id
 * deletes nothing. Returns how many conversations were removed.
 *
 * Lock order (README): live user → advisory → consent → conversation row →
 * proposal and message rows. The conversation rows are locked first (FOR
 * UPDATE, by id), so a turn holding one (bumpTurn, appendMessages, a proposal
 * insert's foreign-key check) finishes first and what it wrote is deleted
 * here, and a turn that comes after waits and then finds its conversation
 * gone. A conversation started after the lock is a new one and is kept.
 *
 * Memory is cleared before commit: if the transaction then rolls back, the
 * memory history is gone while the rows stay, which errs toward forgetting.
 */
export async function forgetConversations(tx: Tx, memory: MemoryHistory, userId: string, conversationId?: string): Promise<number> {
  if (conversationId === undefined) memory.delete(`${userId}:`);
  else memory.deleteKey(memoryKey(userId, conversationId));
  if (conversationId !== undefined && !UUID.test(conversationId)) return 0;
  const locked = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), ...(conversationId === undefined ? [] : [eq(conversations.id, conversationId)])))
    .orderBy(asc(conversations.id))
    .for('update');
  const ids = locked.map((r) => r.id);
  const linked = ids.length > 0 ? inArray(mentorProposals.conversationId, ids) : undefined;
  if (conversationId === undefined) {
    const unlinked = isNull(mentorProposals.conversationId);
    await tx.delete(mentorProposals).where(and(eq(mentorProposals.userId, userId), linked ? or(linked, unlinked) : unlinked));
  } else if (linked) {
    await tx.delete(mentorProposals).where(and(eq(mentorProposals.userId, userId), linked));
  }
  if (ids.length === 0) return 0;
  await tx.delete(messages).where(and(eq(messages.userId, userId), inArray(messages.conversationId, ids)));
  return (
    await tx
      .delete(conversations)
      .where(and(eq(conversations.userId, userId), inArray(conversations.id, ids)))
      .returning({ id: conversations.id })
  ).length;
}

/** A conversation as the export lists it: times, the turn counter and its stored messages, decrypted. */
export interface ExportedConversation {
  id: string;
  startedAt: Date;
  lastTurnAt: Date;
  turnSeq: number;
  messages: (StoredMessage & { seq: number; createdAt: Date })[];
}

/** All of the user's conversations with their stored messages, decrypted, oldest first (C-7). Throws if any cannot be opened. */
export async function loadConversationsForExport(db: Db | Tx, keyring: Keyring, userId: string): Promise<ExportedConversation[]> {
  const convs = await db
    .select({ id: conversations.id, startedAt: conversations.startedAt, lastTurnAt: conversations.lastTurnAt, turnSeq: conversations.turnSeq })
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(asc(conversations.startedAt), asc(conversations.id));
  const rows = await db
    .select({ id: messages.id, conversationId: messages.conversationId, seq: messages.seq, sealed: messages.sealed, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.userId, userId))
    .orderBy(asc(messages.conversationId), asc(messages.seq));
  const byConv = new Map<string, ExportedConversation['messages']>();
  for (const row of rows) {
    const msg = await openFor<StoredMessage>(db, keyring, messageSealContext(userId, row.id), row.sealed);
    const list = byConv.get(row.conversationId) ?? [];
    list.push({ seq: row.seq, createdAt: row.createdAt, ...msg });
    byConv.set(row.conversationId, list);
  }
  return convs.map((c) => ({ ...c, messages: byConv.get(c.id) ?? [] }));
}
