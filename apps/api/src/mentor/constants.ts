/**
 * The mentor's tunable limits, one place each (M4 README Global Constraints).
 * Change a value here, never inline.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A proposal card can be confirmed for this long after the server showed it. */
export const PROPOSAL_TTL_MS = 30 * MINUTE;
/** A confirmed write can be undone for this long after it was made: one place, in core (the client's writer uses it too). */
export { UNDO_WINDOW_MS } from '@kitchenquest/core';
/** Stored transcripts (`messages`) and idle `conversations` are kept this many days (C-12). */
export const TRANSCRIPT_RETENTION_DAYS = 30;
/** At most this many earlier messages are read back as a turn's history. */
export const HISTORY_MESSAGES = 8;
/** History held in memory only (no `health_data` consent) expires this long after its last message. */
export const MEMORY_TTL_MS = 30 * MINUTE;
/** A conversation with no turn for this long is closed; the next turn starts a new one. */
export const CONVERSATION_IDLE_MS = 6 * HOUR;
/** Mentor turns per player per minute. */
export const TURNS_PER_MINUTE = 20;
/** AI turns per day without and with the Guild (business doc §C "~15" and "~100"). Rule help is never capped (pre-flight C6). */
export const FREE_AI_TURNS_PER_DAY = 15;
export const GUILD_AI_TURNS_PER_DAY = 100;
/** The longest text a player can send in one turn, in characters. */
export const MAX_TEXT = 500;
/** At most this many pantry items per player (data-inventory.md §3.13). */
export const MAX_PANTRY_ITEMS = 300;
