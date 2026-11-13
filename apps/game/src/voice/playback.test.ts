import { describe, expect, test } from 'vitest';
import { sizzle } from './earcon';
import { fakeAudio } from './fakes.fixture';
import { createPlayer } from './playback';

const pcm = (n = 1600) => new Int16Array(n).fill(1000);

describe('createPlayer', () => {
  test('stop() halts playback and drops the queue at once; audio for a stale id is ignored', () => {
    const a = fakeAudio();
    const player = createPlayer(a.win);
    let idle = 0;
    player.onIdle(() => idle++);
    expect(player.speaking).toBe(false);
    player.play(3, pcm(), 22_050);
    player.play(3, pcm(), 22_050);
    player.play(3, pcm(), 22_050);
    const ctx = a.contexts[0];
    expect(ctx.sources).toHaveLength(3);
    // Queued back to back, never on top of each other.
    const starts = ctx.sources.map((s) => s.started!);
    expect(starts[1]).toBeCloseTo(starts[0] + 1600 / 22_050, 6);
    expect(starts[2]).toBeCloseTo(starts[1] + 1600 / 22_050, 6);
    expect(player.speaking).toBe(true);
    player.stop();
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(player.speaking).toBe(false);
    expect(idle).toBe(1);
    // More audio for the stopped speech (it was on its way) never plays.
    player.play(3, pcm(), 22_050);
    expect(ctx.sources).toHaveLength(3);
    // A newer speech plays; an older one arriving late is ignored, and a newer one replaces it at once.
    player.play(4, pcm(), 22_050);
    expect(ctx.sources).toHaveLength(4);
    player.play(2, pcm(), 22_050);
    expect(ctx.sources).toHaveLength(4);
    player.play(5, pcm(), 22_050);
    expect(ctx.sources[3].stopped).toBe(true);
    expect(ctx.sources).toHaveLength(5);
    // Played to the end: idle.
    ctx.sources[4].finish();
    expect(player.speaking).toBe(false);
    expect(idle).toBe(2);
  });

  test('the samples are scaled into [-1, 1]; nothing is kept once played', () => {
    const a = fakeAudio();
    const player = createPlayer(a.win);
    player.play(1, Int16Array.from([32767, -32768, 0]), 16_000);
    const src = a.contexts[0].sources[0] as unknown as { buffer: { getChannelData(): Float32Array } };
    const data = src.buffer.getChannelData();
    expect(data[0]).toBeCloseTo(1, 3);
    expect(data[1]).toBeCloseTo(-1, 3);
    expect(data[2]).toBe(0);
  });
});

describe('sizzle', () => {
  test('a short local sound, at once, from the device: no socket, no request', () => {
    const a = fakeAudio({ WebSocket: class { constructor() { throw new Error('no socket for an earcon'); } }, fetch: () => { throw new Error('no fetch'); } });
    sizzle(a.win);
    const ctx = a.contexts[0];
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.sources[0].started).toBe(ctx.currentTime);
    expect(ctx.sources[0].buffer!.duration).toBeLessThan(0.4);
  });
});
