import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profiles, rules, sessions, users } from '../src/db/schema.js';
import { testDb } from './helpers/db.js';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t?.close();
});

describe('schema', () => {
  it('applies migrations unmodified to a fresh database', async () => {
    const tables = await t.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' order by table_name`;
    const names = tables.map((r) => r.table_name);
    for (const n of ['users', 'login_tokens', 'sessions', 'profiles', 'rules', 'canon_recipes', 'user_keys', 'consents', 'audit_events', 'self_read_counts']) {
      expect(names).toContain(n);
    }
    const applied = await t.sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(applied[0].n).toBe(9);
  });

  it('cascades user deletion to sessions, profiles and rules', async () => {
    const [u] = await t.db.insert(users).values({ email: 'cascade@x.com', ageConfirmedAt: new Date() }).returning();
    await t.db.insert(sessions).values({
      userId: u.id,
      tokenHash: Buffer.from('h1'),
      expiresAt: new Date(Date.now() + 1000),
    });
    await t.db.insert(profiles).values({ userId: u.id });
    await t.db.insert(rules).values({ userId: u.id, sealed: Buffer.from('x') });

    await t.db.delete(users).where(eq(users.id, u.id));

    expect(await t.db.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
    expect(await t.db.select().from(profiles).where(eq(profiles.userId, u.id))).toHaveLength(0);
    expect(await t.db.select().from(rules).where(eq(rules.userId, u.id))).toHaveLength(0);
  });

  it('treats emails case-insensitively (citext)', async () => {
    await t.db.insert(users).values({ email: 'A@x.com', ageConfirmedAt: new Date() });
    await expect(t.db.insert(users).values({ email: 'a@x.com', ageConfirmedAt: new Date() })).rejects.toThrow();
    const found = await t.db.select().from(users).where(eq(users.email, 'a@X.COM'));
    expect(found).toHaveLength(1);
  });
});
