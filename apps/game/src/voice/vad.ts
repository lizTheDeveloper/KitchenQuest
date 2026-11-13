// M7 Step 8: the browser's voice activity detector. Pure: frames and their level in, decisions out. No timers, no I/O.
//
// Ruling 7: silence never leaves the device. Only frames from PRE_ROLL_MS before detected speech to its end are
// returned; everything else is dropped here and never reaches the socket. B9 / Review Focus 3: while the Pan speaks or
// a cook timer sounds, the threshold rises by `raisedDb` and speech must last BARGE_IN_MIN_MS, so the Pan's own voice
// and an alarm coming back through the microphone never start an utterance.
//
// Fix round 1 (I1): the kitchen changes under it. A steady sound (a fan, a tap) becomes the floor within a few seconds
// even while it is loud, and no utterance runs past `maxSpeechMs` (the controller passes MAX_UTTERANCE_MS less the
// pre-roll); at the cap it ends, `capped`, and the floor is learnt again from what it heard.
// Fix round 1 (I2): while a cook timer sounds, and for TIMER_TAIL_MS after it (its echo), speech must last
// TIMER_MIN_MS, longer than the game's alarm (cook-mode.ts `beep()`, 300 ms) and its echo together. The browser's echo
// cancellation is not relied on.
import { BARGE_IN_MIN_MS } from '@kitchenquest/core/engine';

export interface VadOptions {
  hangoverMs: number; minSpeechMs: number; preRollMs: number; raisedDb: number;
  /** The longest an utterance runs, from its onset (fix round 1, I1). Unbounded when absent. */
  maxSpeechMs?: number;
}
export interface Vad {
  /** One frame (FRAME_MS of PCM16 at 16 kHz), its level in dBFS and its start time. `capped`: ended by maxSpeechMs. */
  push(pcm: Int16Array, db: number, tMs: number): { start?: Int16Array[]; speech?: Int16Array; end?: true; capped?: true };
  /** Either source raises the threshold by raisedDb and needs BARGE_IN_MIN_MS (B9); a timer needs TIMER_MIN_MS. */
  setRaised(source: 'pan' | 'timer', on: boolean): void;
}

/** Speech is this much above the noise floor. */
export const SPEECH_MARGIN_DB = 10;
/** While a cook timer sounds (and its tail), speech must last longer than the alarm and its echo (I2). */
export const TIMER_MIN_MS = 600;
/** The timer's raise outlives `setRaised('timer', false)` by this long: the room's echo of the beep (I2). */
export const TIMER_TAIL_MS = 500;
/** How fast the floor follows a quieter room (per frame) and a louder one. Slow up, so speech never becomes the floor. */
const FLOOR_DOWN = 0.3;
const FLOOR_UP = 0.05;
/** I1: even while loud, the floor creeps up: slowly always, fast once the level has been steady for STEADY_FRAMES. */
const FLOOR_CREEP = 0.0005;
const FLOOR_CREEP_STEADY = 0.02;
const STEADY_FRAMES = 50;
/** A level whose standard deviation over STEADY_FRAMES is under this is a machine, not a voice. */
const STEADY_DB = 2;
/** The quietest floor tracked: digital silence must not make every breath speech. */
const FLOOR_MIN_DB = -90;

export function createVad(opts: VadOptions): Vad {
  let floor: number | null = null;
  const raised = new Set<'pan' | 'timer'>();
  /** The timer's raise holds until this time (its tail), once it is lowered. */
  let timerUntil = -Infinity;
  let lastT = 0;
  /** Recent frames, kept only for the pre-roll and the frames of a candidate onset; never older. */
  let recent: { t: number; pcm: Int16Array; dur: number }[] = [];
  /** The last STEADY_FRAMES levels (numbers only). */
  const levels: number[] = [];
  let speaking = false;
  /** When the current utterance's speech began. */
  let onset = 0;
  /** When the current run of loud frames began (not yet speech), or null. */
  let loudFrom: number | null = null;
  /** When the current run of quiet frames inside speech began, or null. */
  let quietFrom: number | null = null;

  const timerOn = () => raised.has('timer') || lastT < timerUntil;
  const isRaised = () => raised.has('pan') || timerOn();
  const threshold = () => (floor ?? 0) + SPEECH_MARGIN_DB + (isRaised() ? opts.raisedDb : 0);
  const needMs = () => Math.max(opts.minSpeechMs, isRaised() ? BARGE_IN_MIN_MS : 0, timerOn() ? TIMER_MIN_MS : 0);
  const mean = () => levels.reduce((a, b) => a + b, 0) / levels.length;
  const steady = () => {
    if (levels.length < STEADY_FRAMES) return false;
    const m = mean();
    return Math.sqrt(levels.reduce((a, b) => a + (b - m) ** 2, 0) / levels.length) < STEADY_DB;
  };

  return {
    push(pcm, db, tMs) {
      lastT = tMs;
      const dur = (pcm.length / 16_000) * 1000;
      levels.push(db);
      if (levels.length > STEADY_FRAMES) levels.shift();
      if (floor === null) floor = Math.max(FLOOR_MIN_DB, db);
      const loud = db >= threshold();
      // I1: the floor follows a louder room even while it is loud (never while raised: the Pan or an alarm is not the room).
      if (loud && !isRaised()) floor += (db - floor) * (steady() ? FLOOR_CREEP_STEADY : FLOOR_CREEP);
      if (speaking) {
        if (opts.maxSpeechMs !== undefined && tMs + dur - onset >= opts.maxSpeechMs) {
          speaking = false;
          quietFrom = null;
          floor = Math.max(FLOOR_MIN_DB, mean()); // learnt again from what it just heard
          return { speech: pcm, end: true, capped: true };
        }
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
        if (!isRaised()) floor = Math.max(FLOOR_MIN_DB, floor + (db - floor) * (db < floor ? FLOOR_DOWN : FLOOR_UP));
      } else loudFrom ??= tMs;
      recent.push({ t: tMs, pcm, dur });
      const keepFrom = (loudFrom ?? tMs + dur) - opts.preRollMs;
      recent = recent.filter((f) => f.t >= keepFrom);
      if (loudFrom !== null && tMs + dur - loudFrom >= needMs()) {
        speaking = true;
        onset = loudFrom;
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
      else {
        if (source === 'timer' && raised.has('timer')) timerUntil = lastT + TIMER_TAIL_MS;
        raised.delete(source);
      }
    },
  };
}
