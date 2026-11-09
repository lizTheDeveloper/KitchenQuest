import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { entitlements, usageEvents, users } from '../db/schema.js';
import { testDb } from '../../test/helpers/db.js';
import { activeEntitlements, grant } from './entitlements.js';
import { recordUsage } from '../usage/usage.js';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t?.close();
});

async function newUser(email: string) {
  const [u] = await t.db.insert(users).values({ email, ageConfirmedAt: new Date() }).returning();
  return u.id;
}

const d = (s: string) => new Date(s);

describe('activeEntitlements', () => {
  it('is empty for a user with no grants', async () => {
    expect(await activeEntitlements(t.db, await newUser('none@x.com'), d('2026-01-01'))).toEqual([]);
  });

  it('includes the start instant and excludes the end instant', async () => {
    const id = await newUser('window@x.com');
    await grant(t.db, id, 'guild', 'manual', d('2026-01-10T00:00:00Z'), d('2026-02-10T00:00:00Z'));
    const at = (s: string) => activeEntitlements(t.db, id, d(s));
    expect(await at('2026-01-09T23:59:59.999Z')).toEqual([]);
    expect(await at('2026-01-10T00:00:00Z')).toEqual(['guild']);
    expect(await at('2026-02-09T23:59:59.999Z')).toEqual(['guild']);
    expect(await at('2026-02-10T00:00:00Z')).toEqual([]);
  });

  it('treats a missing end as open-ended and returns each kind once', async () => {
    const id = await newUser('multi@x.com');
    await grant(t.db, id, 'bursary', 'manual', d('2026-01-01'));
    await grant(t.db, id, 'guild', 'stripe', d('2026-01-01'));
    await grant(t.db, id, 'guild', 'stripe', d('2026-03-01'), d('2026-04-01'));
    expect(await activeEntitlements(t.db, id, d('2026-03-15'))).toEqual(['bursary', 'guild']);
  });

  it("does not leak another user's entitlements", async () => {
    const a = await newUser('a@x.com');
    const b = await newUser('b@x.com');
    await grant(t.db, a, 'founding', 'stripe', d('2026-01-01'));
    expect(await activeEntitlements(t.db, b, d('2026-06-01'))).toEqual([]);
  });
});

describe('schema', () => {
  it('cascades user deletion to entitlements and usage_events', async () => {
    const id = await newUser('cascade2@x.com');
    await grant(t.db, id, 'guild', 'manual', d('2026-01-01'));
    await recordUsage(t.db, id, 'mentor_text', 3, 1200);
    await t.db.delete(users).where(eq(users.id, id));
    expect(await t.db.select().from(entitlements).where(eq(entitlements.userId, id))).toHaveLength(0);
    expect(await t.db.select().from(usageEvents).where(eq(usageEvents.userId, id))).toHaveLength(0);
  });

  it('usage_events has no column able to hold content', async () => {
    const cols = await t.sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns
      where table_schema = 'public' and table_name = 'usage_events' order by ordinal_position`;
    expect(cols.map((c) => [c.column_name, c.data_type])).toEqual([
      ['id', 'bigint'],
      ['user_id', 'uuid'],
      ['feature', 'text'],
      ['units', 'integer'],
      ['cost_microusd', 'integer'],
      ['created_at', 'timestamp with time zone'],
    ]);
  });

  it('entitlements holds no price or payment columns', async () => {
    const cols = await t.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'entitlements' order by ordinal_position`;
    expect(cols.map((c) => c.column_name)).toEqual([
      'id', 'user_id', 'kind', 'source', 'starts_at', 'ends_at', 'created_at',
    ]);
  });
});
