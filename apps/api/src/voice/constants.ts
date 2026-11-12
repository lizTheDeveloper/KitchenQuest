/**
 * The API's voice allowance constants (M7 README, Global Constraints; Ruling 5). Tunable, one place each. They are
 * never shown: the player sees only a state (`available`, `resting` until a date, `resting_today`), no number,
 * countdown, meter or upsell (spec §16, never rules 7 and 8).
 */

/**
 * Free players' speech allowance: one hour of their own speech (`voice_stt` seconds) in a rolling 30 days. The source
 * is the business doc §C ("60 minutes of voice a month"), which deviates from spec §16's "capped daily allowance";
 * the spec edit, or a daily cap instead, is the founder's call (Ruling 5, C3).
 */
export const FREE_VOICE_SECONDS_PER_30_DAYS = 3600;

/**
 * The abuse ceiling: six hours of speech in 24 hours. It applies to everyone, Guild kinds and the accessibility need
 * included, and is never sold; the accessibility copy says it exists (C4).
 */
export const VOICE_ABUSE_SECONDS_PER_DAY = 21_600;

/** What a second of speech costs us (STT or TTS on the self-hosted service), for `usage_events.cost_microusd`. */
export const VOICE_COST_MICROUSD_PER_SECOND = 25;
