// M7 P1: the API <-> voice service protocol (types and strict parsers). The API speaks first (`hello`); the service
// answers `ready` with its cast. Audio travels as binary frames (protocol.ts `encodeFrame`). The service never gets a
// user id (C-15), and speaks `chunks` verbatim: the API alone renders and chunks speech (P2). Browser-safe: no I/O.
import { MAX_TEXT } from '../mentor/intents';
import { HINT_MAX_WORDS, MAX_SPEAK_CHARS, MAX_SPEAK_ITEMS } from './constants';
import { hasExactKeys, isBoundedText, isIndex, isShortString, isU32, plainObject } from './wire';

export type UpstreamClientMsg =
  | { t: 'hello'; v: 1 }
  | { t: 'listen'; id: number; hint: string[] }
  | { t: 'end'; id: number }
  | { t: 'speak'; id: number; voice: string; chunks: { text: string; cache: boolean }[] }
  | { t: 'cancel'; id: number };

export type UpstreamServerMsg =
  | { t: 'ready'; stt: string; tts: string; sampleRate: number }
  | { t: 'transcript'; id: number; text: string }
  | { t: 'audio_end'; id: number; audioMs: number }
  | { t: 'failed'; id: number; kind: 'stt' | 'tts' };

const NAME_MAX = 128;
const HINT_WORD_MAX = 64;
/** A speak never carries more chunks than the items it came from could make, sentences included. */
const MAX_CHUNKS = MAX_SPEAK_ITEMS * 8;

/** An API message to the voice service, strictly. A fresh copy. */
export function parseUpstreamClientMsg(x: unknown): UpstreamClientMsg | null {
  if (!plainObject(x)) return null;
  switch (x.t) {
    case 'hello':
      return hasExactKeys(x, ['t', 'v']) && x.v === 1 ? { t: 'hello', v: 1 } : null;
    case 'listen': {
      if (!hasExactKeys(x, ['t', 'id', 'hint']) || !isU32(x.id) || !Array.isArray(x.hint)) return null;
      const hint = x.hint as unknown[];
      if (hint.length > HINT_MAX_WORDS || !hint.every((w): w is string => isShortString(w, HINT_WORD_MAX))) return null;
      return { t: 'listen', id: x.id, hint: [...hint] };
    }
    case 'end':
    case 'cancel':
      return hasExactKeys(x, ['t', 'id']) && isU32(x.id) ? { t: x.t, id: x.id } : null;
    case 'speak': {
      if (!hasExactKeys(x, ['t', 'id', 'voice', 'chunks']) || !isU32(x.id) || !isShortString(x.voice, NAME_MAX) || !Array.isArray(x.chunks)) return null;
      const raw = x.chunks as unknown[];
      if (raw.length === 0 || raw.length > MAX_CHUNKS) return null;
      const chunks: { text: string; cache: boolean }[] = [];
      let total = 0;
      for (const c of raw) {
        if (!plainObject(c) || !hasExactKeys(c, ['text', 'cache']) || !isShortString(c.text, MAX_SPEAK_CHARS) || typeof c.cache !== 'boolean') return null;
        // Fix round 1 (M6): MAX_SPEAK_CHARS bounds the whole rendered speak, not each chunk.
        total += c.text.length;
        if (total > MAX_SPEAK_CHARS) return null;
        chunks.push({ text: c.text, cache: c.cache });
      }
      return { t: 'speak', id: x.id, voice: x.voice, chunks };
    }
    default:
      return null;
  }
}

/**
 * A voice-service message to the API, strictly. A fresh copy.
 *
 * Contract (fix round 2, N7): a `transcript` over MAX_TEXT code points parses to null. The API (Step 5) must turn
 * that null into `too_long` for the device's utterance, never drop it silently and leave the turn waiting.
 */
export function parseUpstreamServerMsg(x: unknown): UpstreamServerMsg | null {
  if (!plainObject(x)) return null;
  switch (x.t) {
    case 'ready':
      return hasExactKeys(x, ['t', 'stt', 'tts', 'sampleRate']) &&
        isShortString(x.stt, NAME_MAX) &&
        isShortString(x.tts, NAME_MAX) &&
        isU32(x.sampleRate) &&
        x.sampleRate > 0
        ? { t: 'ready', stt: x.stt, tts: x.tts, sampleRate: x.sampleRate }
        : null;
    case 'transcript':
      // Fix round 1 (I2): at most MAX_TEXT code points; a longer transcript is refused, never cut.
      return hasExactKeys(x, ['t', 'id', 'text']) && isU32(x.id) && isBoundedText(x.text, MAX_TEXT) ? { t: 'transcript', id: x.id, text: x.text } : null;
    case 'audio_end':
      return hasExactKeys(x, ['t', 'id', 'audioMs']) && isU32(x.id) && isIndex(x.audioMs) ? { t: 'audio_end', id: x.id, audioMs: x.audioMs } : null;
    case 'failed':
      return hasExactKeys(x, ['t', 'id', 'kind']) && isU32(x.id) && (x.kind === 'stt' || x.kind === 'tts') ? { t: 'failed', id: x.id, kind: x.kind } : null;
    default:
      return null;
  }
}
