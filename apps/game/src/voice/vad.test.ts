import { BARGE_IN_MIN_MS, FRAME_MS, MIN_SPEECH_MS, PRE_ROLL_MS, VAD_HANGOVER_MS } from '@kitchenquest/core/engine';
import { describe, expect, test } from 'vitest';
import { createVad, SPEECH_MARGIN_DB, type Vad } from './vad';

const RAISED = 12;
const opts = { hangoverMs: VAD_HANGOVER_MS, minSpeechMs: MIN_SPEECH_MS, preRollMs: PRE_ROLL_MS, raisedDb: RAISED };
const FLOOR = -60;

/** A run of frames: each is tagged with its sequence number in sample 0, so a test can tell which frames came back. */
function feeder(vad: Vad) {
  let n = 0;
  const started: number[] = []; // frame numbers whose push returned `start`
  const ended: number[] = [];
  const returned: number[] = []; // every frame number returned, in order
  const push = (db: number, count = 1) => {
    for (let i = 0; i < count; i++) {
      const pcm = new Int16Array(320);
      pcm[0] = n % 32768;
      pcm[1] = Math.floor(n / 32768);
      const r = vad.push(pcm, db, n * FRAME_MS);
      const id = (f: Int16Array) => f[0] + f[1] * 32768;
      if (r.start) { started.push(n); returned.push(...r.start.map(id)); }
      if (r.speech) returned.push(id(r.speech));
      if (r.end) ended.push(n);
      n++;
    }
  };
  return { push, started, ended, returned, at: () => n };
}

describe('createVad', () => {
  test('speech ≥ MIN_SPEECH_MS above the floor starts with PRE_ROLL_MS of pre-roll; end comes VAD_HANGOVER_MS after it falls', () => {
    const f = feeder(createVad(opts));
    f.push(FLOOR, 50); // a second of quiet kitchen
    const speechFrom = f.at();
    f.push(FLOOR + 30, 30); // 600 ms of speech
    const quietFrom = f.at();
    f.push(FLOOR, 40);
    // Starts once MIN_SPEECH_MS of speech has been heard, on the frame that completes it.
    expect(f.started).toEqual([speechFrom + MIN_SPEECH_MS / FRAME_MS - 1]);
    // The start carries PRE_ROLL_MS before the speech began, then every frame of it so far.
    const preRoll = PRE_ROLL_MS / FRAME_MS;
    const first = f.returned[0];
    expect(first).toBe(speechFrom - preRoll);
    // End: on the frame that completes VAD_HANGOVER_MS of quiet; every frame up to it was returned, once, in order.
    expect(f.ended).toEqual([quietFrom + VAD_HANGOVER_MS / FRAME_MS - 1]);
    const last = f.ended[0];
    expect(f.returned).toEqual(Array.from({ length: last - first + 1 }, (_, i) => first + i));
  });

  test('a 120 ms clatter does not start speech; a slowly rising floor is tracked', () => {
    const f = feeder(createVad(opts));
    f.push(FLOOR, 50);
    f.push(FLOOR + 40, 120 / FRAME_MS); // a pan lid
    f.push(FLOOR, 50);
    expect(f.started).toEqual([]);
    expect(f.returned).toEqual([]);
    // The extractor fan comes on: the floor climbs 20 dB over ten seconds. None of it is speech.
    for (let i = 0; i < 500; i++) f.push(FLOOR + (20 * i) / 500);
    expect(f.started).toEqual([]);
    // Speech over the new floor still starts.
    f.push(FLOOR + 20 + SPEECH_MARGIN_DB + 8, 15);
    expect(f.started).toHaveLength(1);
    // Positive control: the same speech level over the old floor's threshold, but below the new one, starts nothing.
    const g = feeder(createVad(opts));
    g.push(FLOOR, 50);
    for (let i = 0; i < 500; i++) g.push(FLOOR + (20 * i) / 500);
    g.push(FLOOR + SPEECH_MARGIN_DB + 5, 50); // over the original floor's threshold only
    expect(g.started).toEqual([]);
  });

  test('with setRaised("pan"), playback-shaped energy at the old threshold never starts speech; speech above raisedDb for BARGE_IN_MIN_MS does (Review Focus 3)', () => {
    const vad = createVad(opts);
    const f = feeder(vad);
    f.push(FLOOR, 50);
    vad.setRaised('pan', true);
    // Three seconds of the Pan's own voice coming back through the mic: syllables just over the normal threshold.
    for (let i = 0; i < 150; i++) f.push(FLOOR + SPEECH_MARGIN_DB + (i % 20 < 14 ? 6 : 0));
    expect(f.started).toEqual([]);
    // Positive control: the same energy with the threshold not raised would have started speech.
    const p = feeder(createVad(opts));
    p.push(FLOOR, 50);
    for (let i = 0; i < 150; i++) p.push(FLOOR + SPEECH_MARGIN_DB + (i % 20 < 14 ? 6 : 0));
    expect(p.started.length).toBeGreaterThan(0);
    // Loud speech for just under BARGE_IN_MIN_MS: still nothing (MIN_SPEECH_MS alone would have started it).
    const loud = FLOOR + SPEECH_MARGIN_DB + RAISED + 8;
    f.push(loud, BARGE_IN_MIN_MS / FRAME_MS - 1);
    f.push(FLOOR, 5);
    expect(f.started).toEqual([]);
    // For BARGE_IN_MIN_MS: barge-in.
    const from = f.at();
    f.push(loud, Math.ceil(BARGE_IN_MIN_MS / FRAME_MS));
    expect(f.started).toEqual([from + Math.ceil(BARGE_IN_MIN_MS / FRAME_MS) - 1]);
    // Lowered again, MIN_SPEECH_MS at the normal threshold starts once more.
    vad.setRaised('pan', false);
    f.push(FLOOR, 30);
    f.push(FLOOR + SPEECH_MARGIN_DB + 6, MIN_SPEECH_MS / FRAME_MS);
    expect(f.started).toHaveLength(2);
  });

  test('with setRaised("timer"), a 2 s 880 Hz alarm envelope starts nothing (B9)', () => {
    const vad = createVad(opts);
    const f = feeder(vad);
    f.push(FLOOR, 50);
    vad.setRaised('timer', true);
    // A cook timer: 880 Hz beeps, 200 ms on and 50 ms off, for two seconds, louder than speech at the normal threshold.
    const beep = (ms: number) => {
      const pcm = new Int16Array(320);
      for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 880 * (ms / 1000 + i / 16_000))));
      return pcm;
    };
    let starts = 0;
    for (let t = 0; t < 2000; t += FRAME_MS) {
      const on = t % 250 < 200;
      const r = vad.push(on ? beep(t) : new Int16Array(320), on ? FLOOR + SPEECH_MARGIN_DB + RAISED + 6 : FLOOR, 1000 + t);
      if (r.start) starts++;
    }
    expect(starts).toBe(0);
    // The timer and the Pan raise it separately: the Pan finishing leaves the timer's raise in place.
    vad.setRaised('pan', true);
    vad.setRaised('pan', false);
    const g = feeder(vad);
    g.push(FLOOR + SPEECH_MARGIN_DB + 6, 50);
    expect(g.started).toEqual([]);
  });

  test('frames between end and the next start are never returned', () => {
    const f = feeder(createVad(opts));
    f.push(FLOOR, 50);
    f.push(FLOOR + 30, 30);
    f.push(FLOOR, 100); // two seconds of quiet: only its last PRE_ROLL_MS may ride with the next start
    const gapEnd = f.at();
    f.push(FLOOR + 30, 30);
    f.push(FLOOR, 30);
    expect(f.started).toHaveLength(2);
    expect(f.ended).toHaveLength(2);
    const afterEnd = f.ended[0] + 1;
    const preRollFrom = gapEnd - PRE_ROLL_MS / FRAME_MS;
    for (let n = afterEnd; n < preRollFrom; n++) expect(f.returned, `frame ${n}`).not.toContain(n);
    expect(new Set(f.returned).size).toBe(f.returned.length); // never twice
  });
});
