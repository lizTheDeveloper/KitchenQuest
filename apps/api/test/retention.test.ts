import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/audit/audit.js';
import { loginTokens, sessions, usageEvents, users } from '../src/db/schema.js';
import { registerRetention, retentionPolicies, runRetention } from '../src/jobs/retention.js';
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
    expect(retentionPolicies()).toEqual(expect.arrayContaining(['login_tokens', 'sessions', 'usage_events', 'audit_events']));
  });

  it('refuses a second policy for the same table', () => {
    expect(() => registerRetention({ table: 'sessions', run: async () => 0 })).toThrow(/sessions/);
  });

  it('deletes exactly the expired rows, using the injected clock', async () => {
    // A clock close to the database's own, since audit purges are also checked against it.
    const now = new Date(Math.floor(Date.now() / 1000) * 1000);
    const at = (ms: number) => new Date(now.getTime() + ms);
    const [u] = await db.insert(users).values({ email: 'ret@example.com', ageConfirmedAt: now }).returning();
    const userId = u!.id;

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
});
