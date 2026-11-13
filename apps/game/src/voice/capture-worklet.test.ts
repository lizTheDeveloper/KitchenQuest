import { FRAME_MS, SAMPLE_RATE_IN } from '@kitchenquest/core/engine';
import { describe, expect, test } from 'vitest';
import { createFramer, FRAME_SAMPLES } from './capture-worklet';

describe('the capture worklet framer', () => {
  test('48 kHz float input becomes 20 ms PCM16 frames at 16 kHz, with a dBFS level; nothing is kept past a frame', () => {
    expect(FRAME_SAMPLES).toBe((SAMPLE_RATE_IN * FRAME_MS) / 1000);
    const framer = createFramer(48_000);
    // 100 ms of a half-scale square wave at 48 kHz, in render quanta of 128 samples.
    const input = new Float32Array(4800).map((_, i) => (Math.floor(i / 48) % 2 === 0 ? 0.5 : -0.5));
    const frames: { pcm: Int16Array; db: number }[] = [];
    for (let i = 0; i < input.length; i += 128) frames.push(...framer.push(input.subarray(i, i + 128)));
    expect(frames).toHaveLength(5);
    for (const f of frames) {
      expect(f.pcm).toHaveLength(FRAME_SAMPLES);
      expect(Math.max(...f.pcm)).toBeLessThanOrEqual(16384);
      expect(f.db).toBeCloseTo(20 * Math.log10(0.5), 0);
    }
    // Each frame is its own buffer (it is transferred to the main thread).
    expect(new Set(frames.map((f) => f.pcm.buffer)).size).toBe(5);
  });

  test('silence is far below any speech level; 16 kHz input passes sample for sample; out-of-range input is clipped', () => {
    const quiet = createFramer(16_000).push(new Float32Array(FRAME_SAMPLES));
    expect(quiet).toHaveLength(1);
    expect(quiet[0].db).toBeLessThanOrEqual(-90);
    const ramp = new Float32Array(FRAME_SAMPLES).map((_, i) => (i < 10 ? 2 : -i / FRAME_SAMPLES));
    const [f] = createFramer(16_000).push(ramp);
    expect(f.pcm[0]).toBe(32767);
    expect(f.pcm[100]).toBe(Math.round((-100 / FRAME_SAMPLES) * 32767));
  });
});
