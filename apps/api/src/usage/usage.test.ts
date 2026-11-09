import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../db/schema.js';
import { testDb } from '../../test/helpers/db.js';
import { recordUsage, usageSince } from './usage.js';

let t: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  t = await testDb();
});
afterAll(async () => {
  await t?.close();
});

async function newUser(email: string) {
  const [u] = await t.db.insert(users).values({ email, ageConfirmedAt: new Date() }).returning();
  return u!.id;
}

describe('usageSince', () => {
  it('is 0 with no events', async () => {
    expect(await usageSince(t.db, await newUser('z@x.com'), 'mentor_text', new Date(0))).toBe(0);
  });

  it('sums units per feature and per user', async () => {
    const a = await newUser('sum-a@x.com');
    const b = await newUser('sum-b@x.com');
    await recordUsage(t.db, a, 'mentor_text', 5, 100);
    await recordUsage(t.db, a, 'mentor_text', 7, 200);
    await recordUsage(t.db, a, 'voice_stt', 30, 300);
    await recordUsage(t.db, b, 'mentor_text', 99, 1);
    const since = new Date(Date.now() - 60_000);
    expect(await usageSince(t.db, a, 'mentor_text', since)).toBe(12);
    expect(await usageSince(t.db, a, 'voice_stt', since)).toBe(30);
    expect(await usageSince(t.db, a, 'ingest', since)).toBe(0);
  });

  it('only counts events at or after since', async () => {
    const a = await newUser('since@x.com');
    await recordUsage(t.db, a, 'photo_reaction', 2, 10);
    expect(await usageSince(t.db, a, 'photo_reaction', new Date(Date.now() + 60_000))).toBe(0);
  });
});
