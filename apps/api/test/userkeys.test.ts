import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keyring } from '../src/crypto/keyring.js';
import { openFor, rewrapUserKeys, sealFor, type SealContext } from '../src/crypto/userkeys.js';
import { userKeys, users } from '../src/db/schema.js';
import type { Db } from '../src/types.js';
import { testDb, type Sql } from './helpers/db.js';

const k1 = randomBytes(32);
const k2 = randomBytes(32);
const ringK1 = new Keyring(new Map([['k1', k1]]), 'k1');
const ringBoth = new Keyring(new Map([['k1', k1], ['k2', k2]]), 'k2');
const ringK2 = new Keyring(new Map([['k2', k2]]), 'k2');

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

async function newUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `keys${++seq}@example.com`, ageConfirmedAt: new Date() })
    .returning({ id: users.id });
  return u!.id;
}

const ctxFor = (userId: string, table = 'rules', rowId = randomUUID()): SealContext => ({ table, userId, rowId });
const rule = { kind: 'allergy', target: 'peanut', severity: 'severe' };

describe('per-user sealing (C-3, C-4)', () => {
  it('round-trips and never stores the plaintext', async () => {
    const ctx = ctxFor(await newUser());
    const sealed = await sealFor(db, ringK1, ctx, rule);
    expect(sealed.includes(Buffer.from('peanut'))).toBe(false);
    expect(await openFor(db, ringK1, ctx, sealed)).toEqual(rule);
  });

  it('creates one data key per user on first use, wrapped by the active ring key', async () => {
    const userId = await newUser();
    expect(await db.select().from(userKeys).where(eq(userKeys.userId, userId))).toHaveLength(0);
    await Promise.all([1, 2, 3].map(() => sealFor(db, ringK1, ctxFor(userId), rule)));
    const rows = await db.select().from(userKeys).where(eq(userKeys.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.keyId).toBe('k1');
    // The stored wrapped key does not contain the ring key's bytes.
    expect(rows[0]!.wrapped.includes(k1)).toBe(false);
  });

  it('uses a different data key for each user', async () => {
    const a = await newUser();
    const b = await newUser();
    const ctx = ctxFor(a);
    const sealed = await sealFor(db, ringK1, ctx, rule);
    await sealFor(db, ringK1, ctxFor(b), rule);
    // Even with a matching context, b's key cannot open a's blob.
    await expect(openFor(db, ringK1, { ...ctx, userId: b }, sealed)).rejects.toThrow();
  });

  it("fails to open a blob copied to another user's row, another row, or another table", async () => {
    const a = await newUser();
    const b = await newUser();
    await sealFor(db, ringK1, ctxFor(b), { warm: 'up' });
    const ctx = ctxFor(a);
    const sealed = await sealFor(db, ringK1, ctx, rule);
    await expect(openFor(db, ringK1, { ...ctx, userId: b }, sealed)).rejects.toThrow();
    await expect(openFor(db, ringK1, { ...ctx, rowId: randomUUID() }, sealed)).rejects.toThrow();
    await expect(openFor(db, ringK1, { ...ctx, table: 'journeys' }, sealed)).rejects.toThrow();
    expect(await openFor(db, ringK1, ctx, sealed)).toEqual(rule);
  });

  it('cannot open after the user is deleted, even with the full ring (crypto-shredding)', async () => {
    const userId = await newUser();
    const ctx = ctxFor(userId);
    const sealed = await sealFor(db, ringK1, ctx, rule);
    const [wrapped] = await db.select().from(userKeys).where(eq(userKeys.userId, userId));
    await db.delete(users).where(eq(users.id, userId));
    expect(await db.select().from(userKeys).where(eq(userKeys.userId, userId))).toHaveLength(0);
    await expect(openFor(db, ringBoth, ctx, sealed)).rejects.toThrow(/no data key/);
    // Re-creating the user (a restored "backup" of the users row) gives a fresh key, never the old one.
    await sql`insert into users (id, email, age_confirmed_at) values (${userId}, ${`back${seq}@example.com`}, now())`;
    await sealFor(db, ringK1, ctxFor(userId), { other: 1 });
    await expect(openFor(db, ringK1, ctx, sealed)).rejects.toThrow();
    expect(wrapped).toBeDefined();
  });

  it('refuses to seal or open with an incomplete context', async () => {
    const userId = await newUser();
    await expect(sealFor(db, ringK1, { table: '', userId, rowId: 'r' }, rule)).rejects.toThrow(/context/);
    await expect(sealFor(db, ringK1, { table: 'rules', userId, rowId: '' }, rule)).rejects.toThrow(/context/);
  });
});

describe('key ring rotation and rekey (C-2)', () => {
  it('seal under k1, rotate to k2: everything opens; rekey, drop k1: everything still opens', async () => {
    const owners = await Promise.all([1, 2, 3, 4, 5].map(() => newUser()));
    const blobs = await Promise.all(
      owners.map(async (userId) => {
        const ctx = ctxFor(userId);
        return { ctx, sealed: await sealFor(db, ringK1, ctx, { ...rule, userId }) };
      }),
    );

    // Rotate: k2 active, k1 still in the ring. Old data opens; new users get k2-wrapped keys.
    for (const b of blobs) expect(await openFor(db, ringBoth, b.ctx, b.sealed)).toMatchObject(rule);
    const late = await newUser();
    const lateCtx = ctxFor(late);
    const lateSealed = await sealFor(db, ringBoth, lateCtx, rule);
    const [lateKey] = await db.select().from(userKeys).where(eq(userKeys.userId, late));
    expect(lateKey!.keyId).toBe('k2');

    // Before rekey, dropping k1 would lose data.
    await expect(openFor(db, ringK2, blobs[0]!.ctx, blobs[0]!.sealed)).rejects.toThrow(/k1/);

    const first = await rewrapUserKeys(db, ringBoth, { batchSize: 2 });
    expect(first.rewrapped).toBeGreaterThanOrEqual(owners.length);
    expect(first.remaining).toBe(0);
    // Idempotent: a second run has nothing to do.
    expect(await rewrapUserKeys(db, ringBoth, { batchSize: 2 })).toEqual({ rewrapped: 0, remaining: 0 });

    const ids = await sql<{ key_id: string }[]>`select distinct key_id from user_keys`;
    expect(ids.map((r) => r.key_id)).toEqual(['k2']);
    for (const b of blobs) expect(await openFor(db, ringK2, b.ctx, b.sealed)).toMatchObject(rule);
    expect(await openFor(db, ringK2, lateCtx, lateSealed)).toEqual(rule);
  });

  it('a wrapped key moved to another user does not unwrap', async () => {
    const a = await newUser();
    const b = await newUser();
    const ctxA = ctxFor(a);
    const sealedA = await sealFor(db, ringK2, ctxA, rule);
    await sealFor(db, ringK2, ctxFor(b), rule);
    const [ka] = await db.select().from(userKeys).where(eq(userKeys.userId, a));
    await db.update(userKeys).set({ wrapped: ka!.wrapped }).where(eq(userKeys.userId, b));
    await expect(openFor(db, ringK2, { ...ctxA, userId: b }, sealedA)).rejects.toThrow();
  });
});
