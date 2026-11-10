import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { audit } from '../src/audit/audit.js';
import { loginTokens, selfReadCounts, sessions, usageEvents, users } from '../src/db/schema.js';
import { registerRetention, retentionPolicies, runRetention, scheduleRetention } from '../src/jobs/retention.js';
import { PROPOSAL_TTL_MS, TRANSCRIPT_RETENTION_DAYS } from '../src/mentor/constants.js';
import { appendMessages, openConversation } from '../src/mentor/conversations.js';
import { MemoryHistory } from '../src/mentor/memory.js';
import { createProposal, markDecided } from '../src/mentor/proposals.js';
import { testConfig } from './helpers/config.js';
import type { Db } from '../src/types.js';
import { testDb, type Sql } from './helpers/db.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let db: Db;
let sql: Sql;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, sql, close } = await testDb());
});
afterAll(async () => {
  await close?.();
});

let n = 0;
const hash = () => Buffer.from(`hash-${++n}`);

describe('retention (C-6)', () => {
  it('registers the M2 policies', () => {
    expect(retentionPolicies()).toEqual(
      expect.arrayContaining(['login_tokens', 'sessions', 'usage_events', 'audit_events', 'self_read_counts']),
    );
  });

  it('registers the M4 mentor policies (C-12)', () => {
    expect(retentionPolicies()).toEqual(expect.arrayContaining(['messages', 'conversations', 'mentor_proposals']));
  });

  it('refuses a second policy for the same table', () => {
    expect(() => registerRetention({ table: 'sessions', run: async () => 0 })).toThrow(/sessions/);
  });

  it('deletes exactly the expired rows, using the injected clock', async () => {
    // A clock close to the database's own, since audit purges are also checked against it.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const at = (ms: number) => new Date(now.getTime() + ms);
    const [u] = await db.insert(users).values({ email: 'ret@example.com', ageConfirmedAt: now }).returning();
    const userId = u.id;

    await db.insert(loginTokens).values([
      { email: 'gone-expired@x.com', tokenHash: hash(), expiresAt: at(-25 * HOUR) },
      { email: 'gone-used@x.com', tokenHash: hash(), expiresAt: at(10 * DAY), usedAt: at(-25 * HOUR) },
      { email: 'keep-expired@x.com', tokenHash: hash(), expiresAt: at(-23 * HOUR) },
      { email: 'keep-used@x.com', tokenHash: hash(), expiresAt: at(-30 * 60_000), usedAt: at(-23 * HOUR) },
      { email: 'keep-live@x.com', tokenHash: hash(), expiresAt: at(15 * 60_000) },
    ]);
    await db.insert(sessions).values([
      { userId, tokenHash: hash(), expiresAt: at(-1) },
      { userId, tokenHash: hash(), expiresAt: at(0) },
      { userId, tokenHash: hash(), expiresAt: at(1000) },
    ]);
    const months = (m: number) => {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() - m);
      return d;
    };
    await db.insert(usageEvents).values([
      { userId, feature: 'old', units: 1, costMicroUsd: 1, createdAt: new Date(months(13).getTime() - DAY) },
      { userId, feature: 'new', units: 1, costMicroUsd: 1, createdAt: new Date(months(13).getTime() + DAY) },
    ]);
    await audit(db, { actorKind: 'system', action: 'old' }, new Date(months(24).getTime() - DAY));
    await audit(db, { actorKind: 'system', action: 'new' }, new Date(months(24).getTime() + DAY));

    const counts = await runRetention(db, now);
    expect(counts).toMatchObject({ login_tokens: 2, sessions: 2, usage_events: 1, audit_events: 1 });

    expect((await sql`select email from login_tokens order by email`).map((r) => r.email)).toEqual([
      'keep-expired@x.com',
      'keep-live@x.com',
      'keep-used@x.com',
    ]);
    expect(await sql`select 1 from sessions`).toHaveLength(1);
    expect((await sql`select feature from usage_events`).map((r) => r.feature)).toEqual(['new']);
    expect((await sql`select action from audit_events`).map((r) => r.action)).toEqual(['new']);

    // Running again deletes nothing.
    expect(await runRetention(db, now)).toMatchObject({ login_tokens: 0, sessions: 0, usage_events: 0, audit_events: 0 });
  });

  it('keeps self-read counts for 24 months (C-5, Step 7)', async () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const [u] = await db.insert(users).values({ email: 'reads@example.com', ageConfirmedAt: now }).returning();
    await db.insert(selfReadCounts).values([
      { userId: u.id, resource: 'rules', day: '2024-11-08', count: 3 },
      { userId: u.id, resource: 'rules', day: '2024-11-09', count: 2 },
      { userId: u.id, resource: 'rules', day: '2026-11-09', count: 1 },
    ]);
    expect(await runRetention(db, now)).toMatchObject({ self_read_counts: 1 });
    expect((await sql`select day::text from self_read_counts order by day`).map((r) => r.day)).toEqual(['2024-11-09', '2026-11-09']);
    expect(await runRetention(db, now)).toMatchObject({ self_read_counts: 0 });
  });

  it('retention: messages older than 30 days go, newer stay; undecided proposals go at expiry, decided ones after 24 h (C-12, I-4)', async () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const { keyring } = testConfig();
    const memory = new MemoryHistory({ ttlMs: 60_000, max: 8 });
    const [u] = await db.insert(users).values({ email: 'mentor-ret@example.com', ageConfirmedAt: now }).returning();
    const retention = TRANSCRIPT_RETENTION_DAYS * DAY;
    const card = {
      kind: 'meal' as const,
      meal: { eatenOn: '2026-11-09', slot: 'lunch' as const, item: { kind: 'free' as const, description: 'soup' } },
      summary: 'lunch: soup',
      estimate: false,
      readback: [],
    };
    // An old conversation (last turn 30 days + 1 s ago) and a live one.
    const old = await db.transaction((tx) => openConversation(tx, u.id, null, ago(retention + 1000)));
    const live = await db.transaction((tx) => openConversation(tx, u.id, null, ago(retention - 1000)));
    await db.transaction(async (tx) => {
      await appendMessages(tx, keyring, memory, u.id, old.id, [{ role: 'player', text: 'gone' }], true, ago(retention + 1000));
      await appendMessages(tx, keyring, memory, u.id, live.id, [{ role: 'player', text: 'old in a live one' }], true, ago(retention + 500));
      await appendMessages(tx, keyring, memory, u.id, live.id, [{ role: 'player', text: 'kept' }], true, ago(retention - 1000));
      // Decided: kept 24 h after it was made, then deleted.
      const gone = await createProposal(tx, keyring, { userId: u.id, conversationId: live.id, turnSeq: 1, card }, ago(24 * HOUR + 1000));
      await markDecided(tx, gone.proposalId, 'confirmed', 'tap', null, null, keyring, u.id, ago(24 * HOUR + 1000));
      const kept = await createProposal(tx, keyring, { userId: u.id, conversationId: live.id, turnSeq: 1, card }, ago(24 * HOUR - 1000));
      await markDecided(tx, kept.proposalId, 'rejected', 'tap', null, null, keyring, u.id, ago(24 * HOUR - 1000));
      // Undecided: deleted as soon as it has expired (PROPOSAL_TTL_MS after it was made).
      await createProposal(tx, keyring, { userId: u.id, conversationId: live.id, turnSeq: 2, card }, ago(PROPOSAL_TTL_MS));
      await createProposal(tx, keyring, { userId: u.id, conversationId: live.id, turnSeq: 3, card }, ago(PROPOSAL_TTL_MS - 1000));
    });

    const counts = await runRetention(db, now);
    expect(counts).toMatchObject({ messages: 2, conversations: 1, mentor_proposals: 2 });
    expect((await sql`select id from conversations`).map((r) => r.id)).toEqual([live.id]);
    expect(await sql`select seq from messages where conversation_id = ${live.id}`).toEqual([{ seq: 2 }]);
    expect((await sql`select status, turn_seq from mentor_proposals order by turn_seq, status`).map((r) => [r.turn_seq, r.status])).toEqual([
      [1, 'rejected'],
      [3, 'open'],
    ]);
    expect(await runRetention(db, now)).toMatchObject({ messages: 0, conversations: 0, mentor_proposals: 0 });
  });

  it('logs each failed table with a scrubbed error when a run fails', async () => {
    const error = vi.fn();
    const info = vi.fn();
    // A database whose every call fails, with an email in the message that must be scrubbed.
    const broken = new Proxy({}, { get: () => () => { throw new Error('boom for cook@example.com'); } }) as unknown as Db;
    const stop = scheduleRetention(broken, () => new Date(), { info, error }, 60_000);
    try {
      await vi.waitFor(() => expect(error).toHaveBeenCalled());
    } finally {
      stop();
    }
    expect(info).not.toHaveBeenCalled();
    const [payload, msg] = error.mock.calls[0];
    expect(msg).toBe('retention run failed');
    const failures = (payload as { failures: { table: string; error: { message: string } }[] }).failures;
    expect(failures.map((f) => f.table).sort()).toEqual(retentionPolicies().sort());
    expect(failures.map((f) => f.table)).toEqual(expect.arrayContaining(['audit_events', 'messages', 'mentor_proposals']));
    for (const f of failures) expect(f.error.message).toBe('boom for [email]');
    expect(JSON.stringify(payload)).not.toContain('cook@example.com');
  });
});
