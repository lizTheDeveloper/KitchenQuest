// M7 Step 8: the browser's voice activity detector. Pure: frames and their level in, decisions out. No timers, no I/O.
//
// Ruling 7: silence never leaves the device. Only frames from PRE_ROLL_MS before detected speech to its end are
// returned; everything else is dropped here and never reaches the socket. B9 / Review Focus 3: while the Pan speaks or
// a cook timer sounds, the threshold rises by `raisedDb` and speech must last BARGE_IN_MIN_MS, so the Pan's own voice
// and an alarm coming back through the microphone never start an utterance.
import { BARGE_IN_MIN_MS } from '@kitchenquest/core/engine';

export interface VadOptions { hangoverMs: number; minSpeechMs: number; preRollMs: number; raisedDb: number }
export interface Vad {
  /** One frame (FRAME_MS of PCM16 at 16 kHz), its level in dBFS and its start time. */
  push(pcm: Int16Array, db: number, tMs: number): { start?: Int16Array[]; speech?: Int16Array; end?: true };
  /** Either source raises the threshold by raisedDb and needs BARGE_IN_MIN_MS (B9). */
  setRaised(source: 'pan' | 'timer', on: boolean): void;
}

/** Speech is this much above the noise floor. */
export const SPEECH_MARGIN_DB = 10;
/** How fast the floor follows a quieter room (per frame) and a louder one. Slow up, so speech never becomes the floor. */
const FLOOR_DOWN = 0.3;
const FLOOR_UP = 0.05;
/** The quietest floor tracked: digital silence must not make every breath speech. */
const FLOOR_MIN_DB = -90;

export function createVad(opts: VadOptions): Vad {
  let floor: number | null = null;
  const raised = new Set<'pan' | 'timer'>();
  /** Recent frames, kept only for the pre-roll and the frames of a candidate onset; never older. */
  let recent: { t: number; pcm: Int16Array; dur: number }[] = [];
  let speaking = false;
  /** When the current run of loud frames began (not yet speech), or null. */
  let loudFrom: number | null = null;
  /** When the current run of quiet frames inside speech began, or null. */
  let quietFrom: number | null = null;

  const threshold = () => (floor ?? 0) + SPEECH_MARGIN_DB + (raised.size > 0 ? opts.raisedDb : 0);
  const needMs = () => (raised.size > 0 ? Math.max(opts.minSpeechMs, BARGE_IN_MIN_MS) : opts.minSpeechMs);

  return {
    push(pcm, db, tMs) {
      const dur = (pcm.length / 16_000) * 1000;
      if (floor === null) floor = Math.max(FLOOR_MIN_DB, db);
      const loud = db >= threshold();
      if (speaking) {
        if (loud) { quietFrom = null; return { speech: pcm }; }
        quietFrom ??= tMs;
        if (tMs + dur - quietFrom >= opts.hangoverMs) {
          speaking = false;
          quietFrom = null;
          return { speech: pcm, end: true };
        }
        return { speech: pcm };
      }
      // Not speaking: the floor follows the room (frozen while raised, so the Pan or an alarm never becomes the floor).
      if (!loud) {
        loudFrom = null;
        if (raised.size === 0) floor = Math.max(FLOOR_MIN_DB, floor + (db - floor) * (db < floor ? FLOOR_DOWN : FLOOR_UP));
      } else loudFrom ??= tMs;
      recent.push({ t: tMs, pcm, dur });
      const keepFrom = (loudFrom ?? tMs + dur) - opts.preRollMs;
      recent = recent.filter((f) => f.t >= keepFrom);
      if (loudFrom !== null && tMs + dur - loudFrom >= needMs()) {
        speaking = true;
        loudFrom = null;
        quietFrom = null;
        const start = recent.map((f) => f.pcm);
        recent = [];
        return { start };
      }
      return {};
    },
    setRaised(source, on) {
      if (on) raised.add(source);
      else raised.delete(source);
    },
  };
}
