// M7 voice: the tunable numbers, one place each (plan Global Constraints). The device, the API and the voice service
// all read these, so they never drift. Browser-safe: no I/O.

/** Microphone audio sent upstream: PCM16 mono at this rate. */
export const SAMPLE_RATE_IN = 16_000;
/** One captured frame. */
export const FRAME_MS = 20;
/** The longest utterance the API accepts; longer gets `too_long`. */
export const MAX_UTTERANCE_MS = 30_000;
/** Audio kept from before detected speech starts (Ruling 7: silence before it never leaves the device). */
export const PRE_ROLL_MS = 300;
/** How long speech must be absent before the VAD ends an utterance. */
export const VAD_HANGOVER_MS = 300;
/** Shorter detected speech is a click or a bump, never an utterance. */
export const MIN_SPEECH_MS = 200;
/** Hands-free barge-in needs at least this much speech above the raised threshold (Ruling 7). */
export const BARGE_IN_MIN_MS = 250;
/** A tool turn's filler line starts once the reply has taken this long (§7.6b.8). */
export const FILLER_AFTER_MS = 600;
/** Hands-free turns itself off after this long with no speech (Ruling 7). */
export const HANDS_FREE_IDLE_MS = 600_000;
/** The most items one `speak` message may carry. */
export const MAX_SPEAK_ITEMS = 8;
/** The most characters one rendered `speak` may total; an item past it is spoken as `voice.check_screen`. */
export const MAX_SPEAK_CHARS = 600;
/** The longest server-held variable a spoken line may carry (Ruling 15). */
export const SPEAK_VAR_MAX = 80;
/** The most words in an STT vocabulary hint. */
export const HINT_MAX_WORDS = 60;
/** The most sound-alike alternatives a heard term offers (Ruling 4). */
export const MAX_ALTERNATIVES = 3;
/** How many recent replies the API keeps per user to resolve `reply` speak items. */
export const RECENT_REPLIES = 8;
/** How long a recent reply stays speakable. */
export const RECENT_REPLY_TTL_MS = 600_000;
