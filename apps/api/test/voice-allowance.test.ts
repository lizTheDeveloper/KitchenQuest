// M7 Step 4 (Ruling 5): the voice allowance is a state, never a number. Free players have FREE_VOICE_SECONDS_PER_30_DAYS
// of their own speech, rolling; Guild kinds and the sealed accessibility need are unmetered; everyone rests at
// VOICE_ABUSE_SECONDS_PER_DAY in 24 hours. Only `voice_stt` counts: the Pan's speech (`voice_tts`) is recorded, never
// counted. Usage rows are content-free.
import type { VoiceState } from '@kitchenquest/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { grantConsent } from '../src/consent/ledger.js';
import { NOTICES, noticeSha256 } from '../src/consent/notices.js';
import { usageEvents, users } from '../src/db/schema.js';
import { grant } from '../src/entitlements/entitlements.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { recordVoice, voiceState } from '../src/voice/allowance.js';
import { FREE_VOICE_SECONDS_PER_30_DAYS, VOICE_ABUSE_SECONDS_PER_DAY, VOICE_COST_MICROUSD_PER_SECOND } from '../src/voice/constants.js';
import { setAccessibility } from '../src/voice/settings.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';

const config = testConfig();
const NOW = new Date('2026-11-12T10:00:00Z');
const at = (iso: string) => new Date(iso);

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | undefined;
let seq = 0;

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function newUser(): Promise<string> {
  const [u] = await db.insert(users).values({ email: `allow${++seq}@example.com`, ageConfirmedAt: NOW }).returning({ id: users.id });
  return u.id;
}

/** `seconds` of the player's speech (or the Pan's, with `feature`) recorded at `when`. */
const speech = (userId: string, seconds: number, when: Date, feature: 'voice_stt' | 'voice_tts' = 'voice_stt') =>
  db.insert(usageEvents).values({ userId, feature, units: seconds, costMicroUsd: seconds * VOICE_COST_MICROUSD_PER_SECOND, createdAt: when });

const stateOf = async (userId: string, now = NOW): Promise<VoiceState> => (await voiceState(db, config.keyring, userId, now)).state;

async function withAccessibility(userId: string): Promise<void> {
  const hd = NOTICES.health_data!;
  await grantConsent(db, userId, 'health_data', hd.version, noticeSha256(hd), 'tap', at('2026-10-01T00:00:00Z'));
  await setAccessibility(db, config.keyring, userId, true, at('2026-10-01T00:00:00Z'), 'test');
}

describe('the constants (Ruling 5)', () => {
  it('are one hour a rolling 30 days free, six hours a day for everyone, 25 µUSD a second', () => {
    expect(FREE_VOICE_SECONDS_PER_30_DAYS).toBe(3600);
    expect(VOICE_ABUSE_SECONDS_PER_DAY).toBe(21_600);
    expect(VOICE_COST_MICROUSD_PER_SECOND).toBe(25);
  });
});

describe('voiceState (injected clock)', () => {
  it('free: 3599 s in 30 days → available; 3600 → resting until the date the oldest rows age out', async () => {
    const id = await newUser();
    expect(await voiceState(db, config.keyring, id, NOW)).toEqual({ state: { kind: 'available' }, unmetered: false });
    await speech(id, 1800, at('2026-10-20T08:00:00Z'));
    await speech(id, 1799, at('2026-11-01T12:00:00Z'));
    // Older than 30 days: never counted.
    await speech(id, 5000, at('2026-10-13T09:59:59Z'));
    expect(await stateOf(id)).toEqual({ kind: 'available' });
    await speech(id, 1, at('2026-11-10T09:00:00Z'));
    // Dropping the oldest counted row (1800 s, 20 Oct) brings the total under 3600: it leaves the window on 19 Nov.
    expect(await stateOf(id)).toEqual({ kind: 'resting', until: '2026-11-19' });
    // The day it lifts, it is available again.
    expect(await stateOf(id, at('2026-11-19T08:00:00.001Z'))).toEqual({ kind: 'available' });
  });

  it('free: when the oldest row alone is not enough, it rests until enough old rows have left the window', async () => {
    const id = await newUser();
    await speech(id, 100, at('2026-10-15T12:00:00Z'));
    await speech(id, 3500, at('2026-10-25T12:00:00Z'));
    await speech(id, 100, at('2026-11-10T12:00:00Z'));
    // Without the 15 Oct row it is still 3600; without the 25 Oct one too, 100: the 25 Oct row leaves on 24 Nov.
    expect(await stateOf(id)).toEqual({ kind: 'resting', until: '2026-11-24' });
  });

  it('Guild or accessibility → available at 50 000 s in 30 days; everyone, accessibility included, rests at 21 600 s in 24 h', async () => {
    const guild = await newUser();
    await grant(db, guild, 'guild', 'manual', at('2026-01-01T00:00:00Z'));
    const access = await newUser();
    await withAccessibility(access);
    const free = await newUser();
    for (const id of [guild, access, free]) {
      // 10 rows of 5000 s, a day and a half apart: 50 000 s in 30 days, never 21 600 in 24 h.
      for (let i = 0; i < 10; i++) await speech(id, 5000, new Date(NOW.getTime() - (1 + i * 1.5) * 86_400_000));
    }
    expect(await voiceState(db, config.keyring, guild, NOW)).toEqual({ state: { kind: 'available' }, unmetered: true });
    expect(await voiceState(db, config.keyring, access, NOW)).toEqual({ state: { kind: 'available' }, unmetered: true });
    expect((await stateOf(free)).kind).toBe('resting');

    for (const kind of ['household_member', 'bursary', 'founding', 'seat_licence'] as const) {
      const id = await newUser();
      await grant(db, id, kind, 'manual', at('2026-01-01T00:00:00Z'));
      await speech(id, 50_000 / 4, at('2026-10-20T00:00:00Z'));
      expect((await voiceState(db, config.keyring, id, NOW)).unmetered, kind).toBe(true);
    }

    // The abuse ceiling: 21 599 s in 24 h is still available, 21 600 rests, for both.
    for (const id of [guild, access]) {
      await speech(id, VOICE_ABUSE_SECONDS_PER_DAY - 1, at('2026-11-12T02:00:00Z'));
      expect(await stateOf(id), id).toEqual({ kind: 'available' });
      await speech(id, 1, at('2026-11-12T03:00:00Z'));
      // It lifts once the 02:00 row is 24 h old, tomorrow (13 Nov): resting until the 13th.
      expect(await stateOf(id), id).toEqual({ kind: 'resting', until: '2026-11-13' });
    }
  });

  it('accessibility counts only with health_data in force: after a "keep" withdrawal it is the free allowance (Ruling 6)', async () => {
    const id = await newUser();
    await withAccessibility(id);
    await speech(id, 4000, at('2026-11-01T00:00:00Z'));
    expect(await voiceState(db, config.keyring, id, NOW)).toEqual({ state: { kind: 'available' }, unmetered: true });
    await sql`update consents set withdrawn_at = ${at('2026-11-02T00:00:00Z')}, ended_reason = 'withdrawn' where user_id = ${id}`;
    expect(await voiceState(db, config.keyring, id, NOW)).toEqual({ state: { kind: 'resting', until: '2026-12-01' }, unmetered: false });
  });

  it('an abuse rest that lifts later the same UTC day → resting_today, never "until <today>"', async () => {
    const id = await newUser();
    await grant(db, id, 'guild', 'manual', at('2026-01-01T00:00:00Z'));
    await speech(id, VOICE_ABUSE_SECONDS_PER_DAY, at('2026-11-11T11:00:00Z'));
    // Lifts at 2026-11-12T11:00Z, later today.
    const state = await stateOf(id);
    expect(state).toEqual({ kind: 'resting_today' });
    expect(state).not.toEqual({ kind: 'resting', until: '2026-11-12' });
    expect(await stateOf(id, at('2026-11-12T11:00:00.001Z'))).toEqual({ kind: 'available' });
    // Across every hour of the day, a rest never names today's date.
    for (let h = 0; h < 24; h++) {
      const now = new Date(Date.UTC(2026, 10, 12, h, 30));
      const s = await stateOf(id, now);
      if (s.kind === 'resting') expect(s.until > now.toISOString().slice(0, 10)).toBe(true);
    }
  });

  it('a free player at the abuse ceiling rests until the later of the two lifts, never only for today', async () => {
    const id = await newUser();
    await speech(id, VOICE_ABUSE_SECONDS_PER_DAY, at('2026-11-11T11:00:00Z'));
    expect(await stateOf(id)).toEqual({ kind: 'resting', until: '2026-12-11' });
  });

  it('voice_tts usage never counts; recordVoice writes units = ceil(seconds) and cost; the row has only id, user_id, feature, units, cost_microusd, created_at', async () => {
    const id = await newUser();
    await speech(id, 100_000, at('2026-11-11T00:00:00Z'), 'voice_tts');
    expect(await stateOf(id)).toEqual({ kind: 'available' });

    await recordVoice(db, id, 'voice_stt', 1001, NOW);
    await recordVoice(db, id, 'voice_tts', 2000, NOW);
    await recordVoice(db, id, 'voice_stt', 0, NOW);
    const rows = await sql<Record<string, unknown>[]>`
      select * from usage_events where user_id = ${id} and created_at = ${NOW} order by id`;
    expect(rows).toEqual([
      { id: expect.anything(), user_id: id, feature: 'voice_stt', units: 2, cost_microusd: 2 * VOICE_COST_MICROUSD_PER_SECOND, created_at: NOW },
      { id: expect.anything(), user_id: id, feature: 'voice_tts', units: 2, cost_microusd: 2 * VOICE_COST_MICROUSD_PER_SECOND, created_at: NOW },
    ]);
    await expect(recordVoice(db, id, 'voice_stt', -1, NOW)).rejects.toThrow();
    await expect(recordVoice(db, id, 'voice_stt', Number.NaN, NOW)).rejects.toThrow();
    // @ts-expect-error -- only the two voice features
    await expect(recordVoice(db, id, 'mentor_text', 1000, NOW)).rejects.toThrow();
  });
});

describe('GET /voice/status', () => {
  const NUMBERS = /guild|upgrade|premium|subscri|second|minute|hour|left|remaining|used|limit|quota/i;

  async function statusApp(voiceEnabled?: boolean) {
    const mailer = new CaptureMailer();
    app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false, ...(voiceEnabled === undefined ? {} : { voiceEnabled }) });
    const cookie = await signIn(app, mailer, `status${++seq}@example.com`);
    const userId = (await app.inject({ method: 'GET', url: '/me', cookies: { kq_session: cookie } })).json<{ id: string }>().id;
    return { cookie, userId, get: () => app!.inject({ method: 'GET', url: '/voice/status', cookies: { kq_session: cookie } }) };
  }

  it('GET /voice/status → enabled false by default; true when Deps.voiceEnabled is true', async () => {
    const off = await statusApp();
    const res = await off.get();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: { kind: 'available' }, accessibility: false, enabled: false });
    await app!.close();
    const on = await statusApp(true);
    expect((await on.get()).json()).toEqual({ state: { kind: 'available' }, accessibility: false, enabled: true });
  });

  it('a resting player sees only a state and a date: no number, countdown or Guild mention (Ruling 5)', async () => {
    const p = await statusApp(true);
    await speech(p.userId, FREE_VOICE_SECONDS_PER_30_DAYS, at('2026-11-01T00:00:00Z'));
    const res = await p.get();
    expect(res.json()).toEqual({ state: { kind: 'resting', until: '2026-12-01' }, accessibility: false, enabled: true });
    expect(res.body).not.toMatch(NUMBERS);
    // The only digits in the body are the date's.
    expect(res.body.replace('2026-12-01', '')).not.toMatch(/\d/);
  });
});
