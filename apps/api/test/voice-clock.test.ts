// M7 Step 5, carry 6 (Step 4 re-review n1, the reviewer's probe as a test): the player's clock (`localDate`,
// `localTime`, as hello and GET /voice/status take them) never changes an allowance decision, only the date it is
// labelled with. Every date and time `localOffsetMinutes` accepts at one instant, minute by minute across UTC−12 to
// UTC+14, × four players: under the cap, over the free cap, at the abuse ceiling, and just lifted.
import { type VoiceState } from '@kitchenquest/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { grantConsent } from '../src/consent/ledger.js';
import { NOTICES, noticeSha256 } from '../src/consent/notices.js';
import { usageEvents, users } from '../src/db/schema.js';
import type { Db } from '../src/types.js';
import { voiceState } from '../src/voice/allowance.js';
import { FREE_VOICE_SECONDS_PER_30_DAYS, VOICE_ABUSE_SECONDS_PER_DAY } from '../src/voice/constants.js';
import { localOffsetMinutes } from '../src/voice/local-clock.js';
import { setAccessibility } from '../src/voice/settings.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';

const config = testConfig();
/** Late in the UTC day, so the players' local dates fall on three calendar days. */
const NOW = new Date('2026-11-12T23:30:00Z');
const DAY = 86_400_000;
const MINUTE = 60_000;

let db: Db;
let closeDb: () => Promise<void>;
let seq = 0;

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});

async function newUser(): Promise<string> {
  const [u] = await db.insert(users).values({ email: `clock${++seq}@example.com`, ageConfirmedAt: NOW }).returning({ id: users.id });
  return u.id;
}
const speech = (userId: string, seconds: number, at: number) =>
  db.insert(usageEvents).values({ userId, feature: 'voice_stt', units: seconds, costMicroUsd: 0, createdAt: new Date(at) });

/** The local date and HH:MM of instant `t` at `offset` minutes east of UTC. */
const localOf = (t: number, offset: number) => {
  const iso = new Date(t + offset * MINUTE).toISOString();
  return { localDate: iso.slice(0, 10), localTime: iso.slice(11, 16) };
};

describe('carry 6: the client clock labels, never decides', () => {
  test('every allowed date and time × under-cap, over-free-cap, at-ceiling and just-lifted: the same decision; a rest is labelled by the lift instant on the player calendar', { timeout: 300_000 }, async () => {
    const t = NOW.getTime();
    // Each player and when their rest lifts (null: available).
    const under = await newUser();
    await speech(under, FREE_VOICE_SECONDS_PER_30_DAYS - 1, t - 5 * DAY);
    const overFree = await newUser();
    const overAt = t - 20 * DAY;
    await speech(overFree, FREE_VOICE_SECONDS_PER_30_DAYS, overAt);
    const ceiling = await newUser();
    const hd = NOTICES.health_data!;
    await grantConsent(db, ceiling, 'health_data', hd.version, noticeSha256(hd), 'tap', new Date(t - 40 * DAY));
    await setAccessibility(db, config.keyring, ceiling, true, new Date(t - 40 * DAY), 'test');
    const ceilingAt = t - 3 * 60 * MINUTE;
    await speech(ceiling, VOICE_ABUSE_SECONDS_PER_DAY, ceilingAt);
    const lifted = await newUser();
    // Its rest lifted 1 ms ago: the row left the 30-day window just now.
    await speech(lifted, FREE_VOICE_SECONDS_PER_30_DAYS, t - 30 * DAY - 2);
    const players: { name: string; id: string; lift: number | null }[] = [
      { name: 'under-cap', id: under, lift: null },
      { name: 'over-free-cap', id: overFree, lift: overAt + 30 * DAY + 1 },
      { name: 'at-ceiling', id: ceiling, lift: ceilingAt + DAY + 1 },
      { name: 'just-lifted', id: lifted, lift: null },
    ];

    // Every whole-minute clock from UTC−12 (and a little drift) to UTC+14: the ones localOffsetMinutes accepts.
    const clocks: { localDate: string; localTime: string; offset: number }[] = [];
    let refused = 0;
    for (let m = -12 * 60 - 7; m <= 14 * 60 + 7; m++) {
      const c = localOf(t, m);
      try {
        clocks.push({ ...c, offset: localOffsetMinutes(c.localDate, c.localTime, NOW) });
      } catch {
        refused++;
      }
    }
    // Each minute rounds to its quarter hour: 105 offsets, 15 clocks each.
    expect(clocks).toHaveLength(105 * 15);
    expect(refused).toBe(0);

    const expected = (lift: number | null, offset: number): VoiceState => {
      if (lift === null) return { kind: 'available' };
      const until = localOf(lift, offset).localDate;
      return until === localOf(t, offset).localDate ? { kind: 'resting_today' } : { kind: 'resting', until };
    };
    let checked = 0;
    for (const p of players) {
      const results = await Promise.all(clocks.map(async (c) => ({ c, s: (await voiceState(db, config.keyring, p.id, NOW, c.offset)).state })));
      for (const { c, s } of results) {
        expect(s.kind === 'available', `${p.name} at ${c.localDate} ${c.localTime}`).toBe(p.lift === null);
        expect(s, `${p.name} at ${c.localDate} ${c.localTime}`).toEqual(expected(p.lift, c.offset));
        checked++;
      }
    }
    expect(checked).toBe(4 * 105 * 15);
  });
});
