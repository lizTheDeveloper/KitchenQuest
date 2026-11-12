import type { VoiceState } from '@kitchenquest/core';
import { and, asc, eq, gt, gte } from 'drizzle-orm';
import type { Keyring } from '../crypto/keyring.js';
import { usageEvents } from '../db/schema.js';
import { activeEntitlements } from '../entitlements/entitlements.js';
import { GUILD_KINDS } from '../mentor/allowance.js';
import type { Db } from '../types.js';
import { recordUsage, usageSince } from '../usage/usage.js';
import { FREE_VOICE_SECONDS_PER_30_DAYS, VOICE_ABUSE_SECONDS_PER_DAY, VOICE_COST_MICROUSD_PER_SECOND } from './constants.js';
import { accessibilityInForce } from './settings.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

/**
 * When `limit` stops binding: the player's `voice_stt` seconds counted from `now - windowMs` (inclusive, as
 * `usageSince` counts) are at or over `cap`, so the oldest rows must leave the window until the rest is under it.
 * Returns the first instant at which enough have left (a row at `t` counts until `t + windowMs`, inclusive), or null
 * when the player is under the cap. Rows are read only when over it.
 */
async function liftAt(db: Db, userId: string, now: Date, windowMs: number, cap: number): Promise<number | null> {
  const since = new Date(now.getTime() - windowMs);
  const total = await usageSince(db, userId, 'voice_stt', since);
  if (total < cap) return null;
  const rows = await db
    .select({ units: usageEvents.units, createdAt: usageEvents.createdAt })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), eq(usageEvents.feature, 'voice_stt'), gte(usageEvents.createdAt, since), gt(usageEvents.units, 0)))
    .orderBy(asc(usageEvents.createdAt), asc(usageEvents.id));
  let left = total;
  for (const r of rows) {
    left -= r.units;
    if (left < cap) return r.createdAt.getTime() + windowMs + 1;
  }
  return null;
}

const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * A rest as the player sees it (B4): `resting_today` when it lifts later on `now`'s UTC date, never "until <today>";
 * otherwise `resting` until the UTC date it lifts. No time, number or countdown.
 */
function restingUntil(lift: number, now: Date): VoiceState {
  const until = utcDate(lift);
  return until === utcDate(now.getTime()) ? { kind: 'resting_today' } : { kind: 'resting', until };
}

/**
 * The player's voice allowance as a state, never a number (README Ruling 5, spec §16):
 * 1. everyone, the accessibility need and Guild kinds included, rests at VOICE_ABUSE_SECONDS_PER_DAY of speech in
 *    24 hours, until enough of it is 24 hours old (never sold, C4);
 * 2. `unmetered` is the accessibility need (self-declared, sealed, counted only with `health_data` in force, C-19) or
 *    any Guild kind (fair use); it needs no entitlement;
 * 3. a free player rests at FREE_VOICE_SECONDS_PER_30_DAYS in a rolling 30 days, until the UTC date enough old rows
 *    leave the window.
 * When both rests apply (a free player over the daily ceiling) the later lift is the one shown, so a free player is
 * never told "resting for today" while the 30-day rest outlasts it. Only the player's speech (`voice_stt`) counts; the
 * Pan's (`voice_tts`) is recorded and never counted. Read before an utterance; the one in flight always finishes.
 * The state never names the Guild (never rule 7).
 */
export async function voiceState(db: Db, keyring: Keyring, userId: string, now: Date): Promise<{ state: VoiceState; unmetered: boolean }> {
  const abuse = await liftAt(db, userId, now, DAY_MS, VOICE_ABUSE_SECONDS_PER_DAY);
  const accessibility = (await accessibilityInForce(db, keyring, userId, now)).on;
  const unmetered = accessibility || (await activeEntitlements(db, userId, now)).some((k) => GUILD_KINDS.includes(k));
  const free = unmetered ? null : await liftAt(db, userId, now, MONTH_MS, FREE_VOICE_SECONDS_PER_30_DAYS);
  const lift = abuse === null ? free : free === null ? abuse : Math.max(abuse, free);
  return { state: lift === null ? { kind: 'available' } : restingUntil(lift, now), unmetered };
}

const VOICE_FEATURES = ['voice_stt', 'voice_tts'] as const;

/**
 * Records `ms` of speech (the player's, `voice_stt`, or the Pan's, `voice_tts`) as content-free usage (spec §16): whole
 * seconds rounded up, `units = ceil(ms / 1000)`, and their cost at VOICE_COST_MICROUSD_PER_SECOND. Nothing else: no
 * audio, transcript, text, duration in ms, hint or conversation id. Nothing is written for 0 ms. Step 5 calls it.
 */
export async function recordVoice(db: Pick<Db, 'insert'>, userId: string, feature: 'voice_stt' | 'voice_tts', ms: number, now: Date): Promise<void> {
  if (!VOICE_FEATURES.includes(feature)) throw new Error(`recordVoice: not a voice feature: ${String(feature)}`);
  if (!Number.isFinite(ms) || ms < 0) throw new Error('recordVoice: ms must be a finite, non-negative number');
  if (ms === 0) return;
  const units = Math.ceil(ms / 1000);
  await recordUsage(db, userId, feature, units, units * VOICE_COST_MICROUSD_PER_SECOND, now);
}
