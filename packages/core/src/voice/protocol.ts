// M7: the browser <-> API voice protocol (types and strict parsers). The game and the API both import these, so they
// never drift. Browser-safe: no I/O.
//
// Ruling 15: a `speak` message names what to say by id or reference only. No SpeakItem carries text or variables; the
// API renders every spoken line itself from server-held data.
import { canonicalFull, MAX_TEXT } from '../mentor/intents';
import type { TurnRequest } from '../mentor/protocol';
import { MAX_SPEAK_ITEMS } from './constants';
import { hasExactKeys, isBoundedText, isDate, isIndex, isShortString, isU32, plainObject } from './wire';

export const VOICE_PROTOCOL_VERSION = 1;

export type VoiceMode = 'hold' | 'handsFree';

/** Ruling 15: no text, no variables. `step` is the 0-based index stepPlainText takes (P12). */
export type SpeakItem =
  /** var-free lines only */
  | { kind: 'line'; trigger: string; index: number }
  /** a line part of a server reply */
  | { kind: 'reply'; replyId: string; part: number }
  /** a server card's read-back */
  | { kind: 'card'; proposalId: string }
  /** the API's own transcript of that utterance */
  | { kind: 'heard'; utteranceId: number }
  /** canon only (Ruling 11) */
  | { kind: 'step'; slug: string; step: number; localDate: string };

export type ClientMsg =
  /**
   * `localDate` (YYYY-MM-DD) and `localTime` (HH:MM) are the player's clock (M7 Step 5, carry 4): the API checks them
   * exactly as `GET /voice/status` does and dates the allowance by them. They never change whether voice is available.
   */
  | { t: 'hello'; v: 1; conversationId: string | null; localDate: string; localTime: string; familyTable: boolean }
  | { t: 'listen'; id: number; mode: VoiceMode }
  | { t: 'end'; id: number }
  | { t: 'cancel'; id: number }
  | { t: 'speak'; id: number; items: SpeakItem[] };

/** Ruling 5: a state, never a number. `until` is a YYYY-MM-DD. */
export type VoiceState = { kind: 'available' } | { kind: 'resting'; until: string } | { kind: 'resting_today' };

/**
 * Why the API closed a voice socket. New close codes go here, in VOICE_CLOSE_CODES and in the doc comment on the API's
 * `ApiError`.
 */
export type VoiceCloseReason =
  | 'signed_out'
  | 'bad_origin'
  | 'consent_required'
  | 'child'
  | 'family_table'
  | 'unavailable'
  | 'another_tab'
  | 'bad_message';

export type ServerMsg =
  | { t: 'ready'; state: VoiceState }
  | { t: 'state'; state: VoiceState }
  | { t: 'transcript'; id: number; text: string }
  /**
   * Past MAX_UTTERANCE_MS, or a transcript over MAX_TEXT. Without `safety` a transcript of what came follows. M7 Step 11
   * (F4-1, emergency half; controller ruling): `safety` marks the utterance's final answer, sent when its transcript is
   * over MAX_TEXT and so never reaches the device. It says whether that whole transcript, scanned uncapped and first
   * (core `isEmergency`, the turn's safety order), held an emergency, so the device answers it with rule.emergency as
   * it answers a typed one. An enum only: no text of the transcript.
   */
  | { t: 'too_long'; id: number; safety?: 'emergency' | 'none' }
  | { t: 'audio_start'; id: number; sampleRate: number }
  | { t: 'audio_end'; id: number }
  | { t: 'failed'; id: number; kind: 'stt' | 'tts' | 'upstream' }
  | { t: 'closed'; reason: VoiceCloseReason };

const ID_MAX = 128;
const TRIGGER = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const SLUG_MAX = 200;
const CLOSE_REASONS: readonly string[] = ['signed_out', 'bad_origin', 'consent_required', 'child', 'family_table', 'unavailable', 'another_tab', 'bad_message'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * M7 Step 5 (carry 1): the WebSocket close code the API closes a voice socket with, after its `closed { reason }`
 * message. Application codes (4000–4999), one per reason, so a client that missed the message still knows why.
 */
export const VOICE_CLOSE_CODES: Readonly<Record<VoiceCloseReason, number>> = Object.freeze({
  bad_message: 4400,
  signed_out: 4401,
  bad_origin: 4403,
  another_tab: 4409,
  consent_required: 4412,
  child: 4451,
  family_table: 4452,
  unavailable: 4503,
});

/** The reason a VOICE_CLOSE_CODES code stands for; null for any other close code. */
export function voiceCloseReason(code: number): VoiceCloseReason | null {
  for (const [reason, c] of Object.entries(VOICE_CLOSE_CODES)) if (c === code) return reason as VoiceCloseReason;
  return null;
}

/** One binary frame: a u32 big-endian message id, then PCM16 little-endian mono samples. */
export function encodeFrame(id: number, pcm: Int16Array): Uint8Array {
  if (!isU32(id)) throw new RangeError('encodeFrame: the id must be a u32');
  const out = new Uint8Array(4 + pcm.length * 2);
  const view = new DataView(out.buffer);
  view.setUint32(0, id, false);
  for (let i = 0; i < pcm.length; i++) view.setInt16(4 + i * 2, pcm[i], true);
  return out;
}

/** The frame's id and a copy of its samples; null when shorter than the id or when the PCM has an odd byte count. */
export function decodeFrame(buf: Uint8Array): { id: number; pcm: Int16Array } | null {
  if (buf.byteLength < 4 || (buf.byteLength - 4) % 2 !== 0) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const pcm = new Int16Array((buf.byteLength - 4) / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(4 + i * 2, true);
  return { id: view.getUint32(0, false), pcm };
}

function parseSpeakItem(x: unknown): SpeakItem | null {
  if (!plainObject(x)) return null;
  switch (x.kind) {
    case 'line':
      return hasExactKeys(x, ['kind', 'trigger', 'index']) && isShortString(x.trigger, ID_MAX) && TRIGGER.test(x.trigger) && isIndex(x.index)
        ? { kind: 'line', trigger: x.trigger, index: x.index }
        : null;
    case 'reply':
      return hasExactKeys(x, ['kind', 'replyId', 'part']) && isShortString(x.replyId, ID_MAX) && isIndex(x.part)
        ? { kind: 'reply', replyId: x.replyId, part: x.part }
        : null;
    case 'card':
      return hasExactKeys(x, ['kind', 'proposalId']) && isShortString(x.proposalId, ID_MAX) ? { kind: 'card', proposalId: x.proposalId } : null;
    case 'heard':
      return hasExactKeys(x, ['kind', 'utteranceId']) && isU32(x.utteranceId) ? { kind: 'heard', utteranceId: x.utteranceId } : null;
    case 'step':
      return hasExactKeys(x, ['kind', 'slug', 'step', 'localDate']) &&
        isShortString(x.slug, SLUG_MAX) &&
        SLUG.test(x.slug) &&
        isIndex(x.step) &&
        isDate(x.localDate)
        ? { kind: 'step', slug: x.slug, step: x.step, localDate: x.localDate }
        : null;
    default:
      return null;
  }
}

/** A browser message, strictly: every key known and present, nothing extra, at most MAX_SPEAK_ITEMS items. A fresh copy. */
export function parseClientMsg(x: unknown): ClientMsg | null {
  if (!plainObject(x)) return null;
  switch (x.t) {
    case 'hello':
      return hasExactKeys(x, ['t', 'v', 'conversationId', 'localDate', 'localTime', 'familyTable']) &&
        x.v === VOICE_PROTOCOL_VERSION &&
        (x.conversationId === null || isShortString(x.conversationId, ID_MAX)) &&
        isDate(x.localDate) &&
        typeof x.localTime === 'string' &&
        HHMM.test(x.localTime) &&
        typeof x.familyTable === 'boolean'
        ? { t: 'hello', v: 1, conversationId: x.conversationId, localDate: x.localDate, localTime: x.localTime, familyTable: x.familyTable }
        : null;
    case 'listen':
      return hasExactKeys(x, ['t', 'id', 'mode']) && isU32(x.id) && (x.mode === 'hold' || x.mode === 'handsFree') ? { t: 'listen', id: x.id, mode: x.mode } : null;
    case 'end':
    case 'cancel':
      return hasExactKeys(x, ['t', 'id']) && isU32(x.id) ? { t: x.t, id: x.id } : null;
    case 'speak': {
      if (!hasExactKeys(x, ['t', 'id', 'items']) || !isU32(x.id) || !Array.isArray(x.items)) return null;
      if (x.items.length === 0 || x.items.length > MAX_SPEAK_ITEMS) return null;
      const items: SpeakItem[] = [];
      for (const raw of x.items as unknown[]) {
        const item = parseSpeakItem(raw);
        if (item === null) return null;
        items.push(item);
      }
      return { t: 'speak', id: x.id, items };
    }
    default:
      return null;
  }
}

function parseState(x: unknown): VoiceState | null {
  if (!plainObject(x)) return null;
  if (x.kind === 'available' || x.kind === 'resting_today') return hasExactKeys(x, ['kind']) ? { kind: x.kind } : null;
  if (x.kind === 'resting') return hasExactKeys(x, ['kind', 'until']) && isDate(x.until) ? { kind: 'resting', until: x.until } : null;
  return null;
}

/**
 * An API message, strictly (the game's side). A fresh copy.
 *
 * Contract (fix round 2, N7): a `transcript` over MAX_TEXT code points parses to null; it is refused, never cut. The
 * API must therefore never send one: an over-long utterance is answered with `too_long` (and the text box), so the
 * device never drops a message and leaves the turn hanging.
 */
export function parseServerMsg(x: unknown): ServerMsg | null {
  if (!plainObject(x)) return null;
  switch (x.t) {
    case 'ready':
    case 'state': {
      if (!hasExactKeys(x, ['t', 'state'])) return null;
      const state = parseState(x.state);
      return state === null ? null : { t: x.t, state };
    }
    case 'transcript':
      // Fix round 1 (I2): at most MAX_TEXT code points; a longer transcript is refused (`too_long`), never cut.
      return hasExactKeys(x, ['t', 'id', 'text']) && isU32(x.id) && isBoundedText(x.text, MAX_TEXT) ? { t: 'transcript', id: x.id, text: x.text } : null;
    case 'too_long':
      if (hasExactKeys(x, ['t', 'id', 'safety'])) {
        return isU32(x.id) && (x.safety === 'emergency' || x.safety === 'none') ? { t: 'too_long', id: x.id, safety: x.safety } : null;
      }
      return hasExactKeys(x, ['t', 'id']) && isU32(x.id) ? { t: 'too_long', id: x.id } : null;
    case 'audio_end':
      return hasExactKeys(x, ['t', 'id']) && isU32(x.id) ? { t: x.t, id: x.id } : null;
    case 'audio_start':
      return hasExactKeys(x, ['t', 'id', 'sampleRate']) && isU32(x.id) && isU32(x.sampleRate) && x.sampleRate > 0
        ? { t: 'audio_start', id: x.id, sampleRate: x.sampleRate }
        : null;
    case 'failed':
      return hasExactKeys(x, ['t', 'id', 'kind']) && isU32(x.id) && (x.kind === 'stt' || x.kind === 'tts' || x.kind === 'upstream')
        ? { t: 'failed', id: x.id, kind: x.kind }
        : null;
    case 'closed':
      return hasExactKeys(x, ['t', 'reason']) && typeof x.reason === 'string' && CLOSE_REASONS.includes(x.reason)
        ? { t: 'closed', reason: x.reason as VoiceCloseReason }
        : null;
    default:
      return null;
  }
}

/**
 * A mentor turn's `input`, strictly (fix round 1, I2): `{ kind: 'text', text }` or `{ kind: 'transcript', text, heard? }`,
 * text non-blank and at most MAX_TEXT code points, heard words at most MAX_TEXT of them, each at most MAX_TEXT. An
 * over-long input is refused, never truncated. For the API's turn route (Step 6).
 */
export function parseTurnInput(x: unknown): TurnRequest['input'] | null {
  // Fix round 2 (N6): blank means blank once whitespace and invisible (zero-width, format) characters are gone.
  const filled = (t: string): boolean => canonicalFull(t).trim() !== '';
  if (!plainObject(x) || !isBoundedText(x.text, MAX_TEXT) || !filled(x.text)) return null;
  if (x.kind === 'text') return hasExactKeys(x, ['kind', 'text']) ? { kind: 'text', text: x.text } : null;
  if (x.kind !== 'transcript') return null;
  if (hasExactKeys(x, ['kind', 'text'])) return { kind: 'transcript', text: x.text };
  if (!hasExactKeys(x, ['kind', 'text', 'heard']) || !plainObject(x.heard) || !hasExactKeys(x.heard, ['words'])) return null;
  const words = x.heard.words;
  if (!Array.isArray(words) || words.length > MAX_TEXT) return null;
  const list = words as unknown[];
  if (!list.every((w): w is string => isBoundedText(w, MAX_TEXT) && filled(w))) return null;
  return { kind: 'transcript', text: x.text, heard: { words: [...list] } };
}
