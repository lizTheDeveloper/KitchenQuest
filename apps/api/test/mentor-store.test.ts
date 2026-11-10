// M4 Step 6: conversations, sealed transcripts (C-12), memory-only history without
// health_data, sealed short-lived proposals.
import { createHash, randomUUID } from 'node:crypto';
import type { MealCard, RuleCard } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grantConsent } from '../src/consent/ledger.js';
import { NOTICES } from '../src/consent/notices.js';
import { conversations, mentorProposals, messages, users } from '../src/db/schema.js';
import {
  CONVERSATION_IDLE_MS,
  HISTORY_MESSAGES,
  MEMORY_TTL_MS,
  PROPOSAL_TTL_MS,
  TRANSCRIPT_RETENTION_DAYS,
} from '../src/mentor/constants.js';
import {
  appendMessages,
  bumpTurn,
  forgetConversations,
  openConversation,
  recentMessages,
  type StoredMessage,
} from '../src/mentor/conversations.js';
import { MemoryFlags, MemoryHistory } from '../src/mentor/memory.js';
import {
  createProposal,
  lockProposal,
  markDecided,
  openProposalsOfTurn,
  peekProposal,
} from '../src/mentor/proposals.js';
import type { Db } from '../src/types.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const { keyring } = testConfig();
const NOW = new Date('2026-11-09T12:00:00Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const MIN = 60_000;

let db: Db;
let sql: Sql;
let close: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close } = await testDb());
});
afterAll(async () => {
  await close?.();
});

async function newUser(consent = true): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `mentor${++seq}@example.com`, ageConfirmedAt: NOW })
    .returning({ id: users.id });
  if (consent) {
    const n = NOTICES.health_data!;
    await grantConsent(db, u.id, 'health_data', n.version, createHash('sha256').update(n.text).digest(), 'tap', at(-60 * MIN));
  }
  return u.id;
}

const memory = () => new MemoryHistory({ ttlMs: MEMORY_TTL_MS, max: HISTORY_MESSAGES });
const tx = <T>(fn: (t: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>) => db.transaction(fn);

const PLAYER: StoredMessage = { role: 'player', text: "I'm allergic to peanut" };
const PAN: StoredMessage = { role: 'pan', parts: [{ kind: 'text', text: 'Peanut, noted for the card.' }], proposalIds: [] };

const PEANUT_CARD: RuleCard = {
  kind: 'rule',
  rule: { target: { kind: 'ingredient', ids: ['peanut'] }, type: 'avoid', severity: 'anaphylactic' },
  severe: true,
  severityUnclear: false,
  form: 'rule_allergen',
  display: { ingredient: 'peanut', spelled: 'P-E-A-N-U-T', severity: 'a severe allergy', covers: 'peanut' },
  readback: [{ trigger: 'rule.readback', vars: { ingredient: 'peanut' } }],
};
const MEAL_CARD: MealCard = {
  kind: 'meal',
  meal: { eatenOn: '2026-11-09', slot: 'lunch', item: { kind: 'free', description: 'peanut noodles' } },
  summary: 'lunch: peanut noodles',
  estimate: false,
  readback: [],
};

const rowsOf = async (table: 'messages' | 'mentor_proposals' | 'conversations', userId: string) =>
  sql`select * from ${sql(table)} where user_id = ${userId}`;

describe('constants', () => {
  it('are the README Global Constraints values', () => {
    expect(PROPOSAL_TTL_MS).toBe(30 * 60_000);
    expect(TRANSCRIPT_RETENTION_DAYS).toBe(30);
    expect(HISTORY_MESSAGES).toBe(8);
    expect(MEMORY_TTL_MS).toBe(30 * 60_000);
    expect(CONVERSATION_IDLE_MS).toBe(6 * 3_600_000);
  });
});

describe('transcripts (C-12)', () => {
  it('messages are stored sealed only with health_data consent', async () => {
    const mem = memory();
    const yes = await newUser(true);
    const c1 = await tx((t) => openConversation(t, yes, null, NOW));
    await tx((t) => appendMessages(t, keyring, mem, yes, c1.id, [PLAYER, PAN], true, NOW));
    const stored = await rowsOf('messages', yes);
    expect(stored.map((r) => [r.seq, r.role])).toEqual([
      [1, 'player'],
      [2, 'pan'],
    ]);
    for (const r of stored) expect(Buffer.from(r.sealed).toString('latin1')).not.toMatch(/peanut/i);
    expect(await recentMessages(db, keyring, mem, yes, c1.id, true, NOW)).toEqual([PLAYER, PAN]);
    expect(mem.get(`${yes}:${c1.id}`, NOW.getTime())).toEqual([]);

    const no = await newUser(false);
    const c2 = await tx((t) => openConversation(t, no, null, NOW));
    await tx((t) => appendMessages(t, keyring, mem, no, c2.id, [PLAYER, PAN], false, NOW));
    expect(await rowsOf('messages', no)).toHaveLength(0);
    expect(await recentMessages(db, keyring, mem, no, c2.id, false, NOW)).toEqual([PLAYER, PAN]);
    // The conversation row itself holds no content.
    const [conv] = await rowsOf('conversations', no);
    expect(Object.keys(conv).sort()).toEqual(['id', 'last_turn_at', 'started_at', 'turn_seq', 'user_id']);
  });

  it('recentMessages returns the last HISTORY_MESSAGES, oldest first, and never another user\'s', async () => {
    const mem = memory();
    const a = await newUser();
    const b = await newUser();
    const c = await tx((t) => openConversation(t, a, null, NOW));
    const many: StoredMessage[] = Array.from({ length: 11 }, (_, i) => ({ role: 'player', text: `m${i}` }));
    for (const m of many) await tx((t) => appendMessages(t, keyring, mem, a, c.id, [m], true, NOW));
    const got = await recentMessages(db, keyring, mem, a, c.id, true, NOW);
    expect(got).toEqual(many.slice(-HISTORY_MESSAGES));
    expect(await recentMessages(db, keyring, mem, b, c.id, true, NOW)).toEqual([]);
    // A transcript older than the retention period is not read back even before the job runs.
    expect(await recentMessages(db, keyring, mem, a, c.id, true, at((TRANSCRIPT_RETENTION_DAYS + 1) * 24 * 60 * MIN))).toEqual([]);
  });

  it('appendMessages refuses a conversation that is not the caller\'s', async () => {
    const mem = memory();
    const a = await newUser();
    const b = await newUser();
    const c = await tx((t) => openConversation(t, a, null, NOW));
    await expect(tx((t) => appendMessages(t, keyring, mem, b, c.id, [PLAYER], true, NOW))).rejects.toThrow();
    expect(await rowsOf('messages', b)).toHaveLength(0);
    expect(await rowsOf('messages', a)).toHaveLength(0);
  });

  it('memory history expires after MEMORY_TTL_MS and is capped at HISTORY_MESSAGES', () => {
    const mem = memory();
    const t0 = NOW.getTime();
    const many: StoredMessage[] = Array.from({ length: 12 }, (_, i) => ({ role: 'player', text: `m${i}` }));
    mem.push('u:c', many.slice(0, 6), t0);
    mem.push('u:c', many.slice(6), t0 + MIN);
    expect(mem.get('u:c', t0 + MIN)).toEqual(many.slice(-HISTORY_MESSAGES));
    expect(mem.get('u:c', t0 + MIN + MEMORY_TTL_MS - 1)).toHaveLength(HISTORY_MESSAGES);
    expect(mem.get('u:c', t0 + MIN + MEMORY_TTL_MS)).toEqual([]);
    // get() returns a copy: changing it does not change what is held.
    mem.push('u:d', [PLAYER], t0);
    mem.get('u:d', t0).push(PAN);
    expect(mem.get('u:d', t0)).toEqual([PLAYER]);
    // sweep drops expired keys; delete by prefix forgets every conversation of a user.
    mem.push('v:1', [PLAYER], t0);
    mem.push('v:2', [PLAYER], t0);
    mem.push('w:1', [PLAYER], t0);
    mem.delete('v:');
    expect(mem.get('v:1', t0)).toEqual([]);
    expect(mem.get('v:2', t0)).toEqual([]);
    expect(mem.get('w:1', t0)).toEqual([PLAYER]);
    mem.sweep(t0 + MEMORY_TTL_MS);
    expect(mem.size).toBe(0);
  });

  it('memory flags expire after their ttl and are swept', () => {
    const flags = new MemoryFlags({ ttlMs: MEMORY_TTL_MS });
    const t0 = NOW.getTime();
    expect(flags.has('u:c', t0)).toBe(false);
    flags.add('u:c', t0);
    expect(flags.has('u:c', t0 + MEMORY_TTL_MS - 1)).toBe(true);
    expect(flags.has('u:c', t0 + MEMORY_TTL_MS)).toBe(false);
    flags.add('u:d', t0);
    flags.sweep(t0 + MEMORY_TTL_MS);
    expect(flags.size).toBe(0);
  });
});

describe('conversations', () => {
  it("openConversation never returns another user's conversation and starts fresh after CONVERSATION_IDLE_MS", async () => {
    const a = await newUser();
    const b = await newUser();
    const c = await tx((t) => openConversation(t, a, null, NOW));
    expect(c.turnSeq).toBe(0);
    expect(await tx((t) => openConversation(t, a, c.id, at(MIN)))).toEqual({ id: c.id, turnSeq: 0 });
    expect(await tx((t) => bumpTurn(t, c.id, at(MIN)))).toBe(1);
    expect(await tx((t) => bumpTurn(t, c.id, at(2 * MIN)))).toBe(2);
    expect(await tx((t) => openConversation(t, a, c.id, at(2 * MIN + CONVERSATION_IDLE_MS - 1)))).toEqual({ id: c.id, turnSeq: 2 });

    const theirs = await tx((t) => openConversation(t, b, c.id, at(3 * MIN)));
    expect(theirs.id).not.toBe(c.id);
    expect(theirs.turnSeq).toBe(0);

    const idle = await tx((t) => openConversation(t, a, c.id, at(2 * MIN + CONVERSATION_IDLE_MS)));
    expect(idle.id).not.toBe(c.id);
    // An id that is no uuid, or no row, is just a new conversation.
    expect((await tx((t) => openConversation(t, a, 'not-a-uuid', NOW))).turnSeq).toBe(0);
    expect((await tx((t) => openConversation(t, a, randomUUID(), NOW))).turnSeq).toBe(0);
  });

  it('forgetConversations removes rows and memory for the user only', async () => {
    const mem = memory();
    const a = await newUser();
    const b = await newUser();
    const keep = await newUser(false);
    const a1 = await tx((t) => openConversation(t, a, null, NOW));
    const a2 = await tx((t) => openConversation(t, a, null, NOW));
    const b1 = await tx((t) => openConversation(t, b, null, NOW));
    const k1 = await tx((t) => openConversation(t, keep, null, NOW));
    for (const [u, c] of [
      [a, a1.id],
      [a, a2.id],
      [b, b1.id],
    ] as const) {
      await tx((t) => appendMessages(t, keyring, mem, u, c, [PLAYER, PAN], true, NOW));
      await tx((t) => createProposal(t, keyring, { userId: u, conversationId: c, turnSeq: 1, card: PEANUT_CARD }, NOW));
    }
    // A proposal the conversation no longer links (retention set it null) also goes when all are forgotten.
    await tx((t) => createProposal(t, keyring, { userId: a, conversationId: null, turnSeq: null, card: MEAL_CARD }, NOW));
    await tx((t) => appendMessages(t, keyring, mem, keep, k1.id, [PLAYER], false, NOW));
    await tx((t) => appendMessages(t, keyring, mem, a, a1.id, [PLAYER], false, NOW));
    await tx((t) => appendMessages(t, keyring, mem, a, a2.id, [PLAYER], false, NOW));

    // One conversation: its messages, its proposals and its memory; the other stays.
    expect(await tx((t) => forgetConversations(t, mem, a, a1.id))).toBe(1);
    expect((await rowsOf('conversations', a)).map((r) => r.id)).toEqual([a2.id]);
    expect((await rowsOf('messages', a)).every((r) => r.conversation_id === a2.id)).toBe(true);
    expect((await rowsOf('mentor_proposals', a)).filter((r) => r.conversation_id === a1.id)).toHaveLength(0);
    expect(mem.get(`${a}:${a1.id}`, NOW.getTime())).toEqual([]);
    expect(mem.get(`${a}:${a2.id}`, NOW.getTime())).toEqual([PLAYER]);
    // Someone else's conversation id forgets nothing.
    expect(await tx((t) => forgetConversations(t, mem, a, b1.id))).toBe(0);
    expect(await rowsOf('messages', b)).toHaveLength(2);

    // All of them: no conversation, message or proposal row remains for the user, and no memory.
    expect(await tx((t) => forgetConversations(t, mem, a))).toBe(1);
    for (const table of ['conversations', 'messages', 'mentor_proposals'] as const) expect(await rowsOf(table, a), table).toHaveLength(0);
    expect(mem.get(`${a}:${a2.id}`, NOW.getTime())).toEqual([]);

    // Others untouched.
    expect(await rowsOf('conversations', b)).toHaveLength(1);
    expect(await rowsOf('messages', b)).toHaveLength(2);
    expect(await rowsOf('mentor_proposals', b)).toHaveLength(1);
    expect(mem.get(`${keep}:${k1.id}`, NOW.getTime())).toEqual([PLAYER]);
  });
});

describe('proposals', () => {
  it('proposal payload is sealed: no "peanut" in mentor_proposals.sealed', async () => {
    const u = await newUser();
    const c = await tx((t) => openConversation(t, u, null, NOW));
    const card = await tx((t) => createProposal(t, keyring, { userId: u, conversationId: c.id, turnSeq: 1, card: PEANUT_CARD }, NOW));
    expect(card).toEqual({ proposalId: expect.any(String), expiresAt: at(PROPOSAL_TTL_MS).toISOString(), card: PEANUT_CARD });
    const [row] = await rowsOf('mentor_proposals', u);
    expect(row).toMatchObject({ id: card.proposalId, kind: 'rule', severe: true, status: 'open', turn_seq: 1, undo_sealed: null });
    expect(Buffer.from(row.sealed).toString('latin1')).not.toMatch(/peanut/i);
    expect(JSON.stringify(row)).not.toMatch(/peanut/i);

    const meal = await tx((t) => createProposal(t, keyring, { userId: u, conversationId: c.id, turnSeq: 1, card: MEAL_CARD }, NOW));
    expect((await db.select().from(mentorProposals).where(eq(mentorProposals.id, meal.proposalId)))[0]).toMatchObject({ kind: 'meal', severe: false });
  });

  it('lockProposal: other user → null; past expires_at → status expired', async () => {
    const u = await newUser();
    const other = await newUser();
    const c = await tx((t) => openConversation(t, u, null, NOW));
    const { proposalId: id } = await tx((t) =>
      createProposal(t, keyring, { userId: u, conversationId: c.id, turnSeq: 3, card: PEANUT_CARD }, NOW),
    );
    expect(await tx((t) => lockProposal(t, keyring, other, id, NOW))).toBeNull();
    expect(await tx((t) => lockProposal(t, keyring, u, 'nope', NOW))).toBeNull();
    expect(await tx((t) => peekProposal(t, keyring, other, id))).toBeNull();
    expect(await tx((t) => peekProposal(t, keyring, u, id))).toEqual({ kind: 'rule' });

    const open = await tx((t) => lockProposal(t, keyring, u, id, at(PROPOSAL_TTL_MS - 1)));
    expect(open).toMatchObject({
      id,
      userId: u,
      conversationId: c.id,
      turnSeq: 3,
      kind: 'rule',
      severe: true,
      status: 'open',
      card: PEANUT_CARD,
      expiresAt: at(PROPOSAL_TTL_MS),
      decidedAt: null,
      writeRef: null,
      undo: null,
    });
    expect(await tx((t) => openProposalsOfTurn(t, keyring, u, c.id, 3, NOW))).toEqual([open]);
    expect(await tx((t) => openProposalsOfTurn(t, keyring, u, c.id, 2, NOW))).toEqual([]);
    expect(await tx((t) => openProposalsOfTurn(t, keyring, other, c.id, 3, NOW))).toEqual([]);
    expect(await tx((t) => openProposalsOfTurn(t, keyring, u, c.id, 3, at(PROPOSAL_TTL_MS)))).toEqual([]);

    const expired = await tx((t) => lockProposal(t, keyring, u, id, at(PROPOSAL_TTL_MS)));
    expect(expired?.status).toBe('expired');
    expect((await rowsOf('mentor_proposals', u))[0].status).toBe('expired');
  });

  it('lockProposal holds the row until commit (FOR UPDATE)', async () => {
    const u = await newUser();
    const { proposalId: id } = await tx((t) =>
      createProposal(t, keyring, { userId: u, conversationId: null, turnSeq: null, card: MEAL_CARD }, NOW),
    );
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const first = tx(async (t) => {
      await lockProposal(t, keyring, u, id, NOW);
      locked();
      await held;
      await markDecided(t, id, 'confirmed', 'tap', randomUUID(), null, keyring, u, NOW);
    });
    await isLocked;
    let secondSaw: string | undefined;
    const second = tx(async (t) => {
      secondSaw = (await lockProposal(t, keyring, u, id, NOW))?.status;
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(secondSaw).toBeUndefined();
    release();
    await Promise.all([first, second]);
    expect(secondSaw).toBe('confirmed');
  });

  it('markDecided records the decision and seals the undo payload under its own context', async () => {
    const u = await newUser();
    const { proposalId: id } = await tx((t) =>
      createProposal(t, keyring, { userId: u, conversationId: null, turnSeq: null, card: MEAL_CARD }, NOW),
    );
    const ref = randomUUID();
    const undo = { removed: [{ name: 'peanut butter', ingredientId: 'peanut' }] };
    await tx((t) => markDecided(t, id, 'confirmed', 'typed_yes', ref, undo, keyring, u, at(MIN)));
    const [row] = await rowsOf('mentor_proposals', u);
    expect(row).toMatchObject({ status: 'confirmed', channel: 'typed_yes', write_ref: ref, decided_at: at(MIN) });
    expect(Buffer.from(row.undo_sealed).toString('latin1')).not.toMatch(/peanut/i);
    const loaded = await tx((t) => lockProposal(t, keyring, u, id, at(2 * MIN)));
    expect(loaded).toMatchObject({ status: 'confirmed', writeRef: ref, undo, decidedAt: at(MIN) });
    // Another user's id changes nothing.
    const other = await newUser();
    await tx((t) => markDecided(t, id, 'rejected', 'tap', null, null, keyring, other, at(3 * MIN)));
    expect((await rowsOf('mentor_proposals', u))[0].status).toBe('confirmed');
  });

  it('the database refuses unknown kinds, statuses, roles and channels', async () => {
    const u = await newUser();
    const c = await tx((t) => openConversation(t, u, null, NOW));
    const blob = Buffer.from('x');
    await expect(sql`insert into messages (conversation_id, user_id, seq, role, sealed) values (${c.id}, ${u}, 1, 'system', ${blob})`).rejects.toThrow(/check/);
    await expect(
      sql`insert into mentor_proposals (user_id, kind, severe, status, sealed, expires_at) values (${u}, 'symptom', false, 'open', ${blob}, now())`,
    ).rejects.toThrow(/check/);
    await expect(
      sql`insert into mentor_proposals (user_id, kind, severe, status, sealed, expires_at) values (${u}, 'meal', false, 'done', ${blob}, now())`,
    ).rejects.toThrow(/check/);
    await expect(
      sql`insert into mentor_proposals (user_id, kind, severe, status, channel, sealed, expires_at) values (${u}, 'meal', false, 'open', 'voice', ${blob}, now())`,
    ).rejects.toThrow(/check/);
    await sql`insert into messages (conversation_id, user_id, seq, role, sealed) values (${c.id}, ${u}, 1, 'pan', ${blob})`;
    await expect(sql`insert into messages (conversation_id, user_id, seq, role, sealed) values (${c.id}, ${u}, 1, 'pan', ${blob})`).rejects.toThrow(/unique|duplicate/);
  });

  it('deleting a conversation cascades to its messages and unlinks its proposals', async () => {
    const mem = memory();
    const u = await newUser();
    const c = await tx((t) => openConversation(t, u, null, NOW));
    await tx((t) => appendMessages(t, keyring, mem, u, c.id, [PLAYER], true, NOW));
    await tx((t) => createProposal(t, keyring, { userId: u, conversationId: c.id, turnSeq: 1, card: MEAL_CARD }, NOW));
    await db.delete(conversations).where(eq(conversations.id, c.id));
    expect(await rowsOf('messages', u)).toHaveLength(0);
    expect((await db.select().from(messages).where(eq(messages.userId, u))).length).toBe(0);
    expect((await rowsOf('mentor_proposals', u)).map((r) => r.conversation_id)).toEqual([null]);
  });
});
