import { describe, expect, test } from 'vitest';
import { openMic } from './capture';
import { CAPTURE_PROCESSOR } from './capture-worklet';
import { fakeAudio } from './fakes.fixture';

describe('openMic', () => {
  test('openMic asks for echoCancellation, noiseSuppression and autoGainControl; close() stops every track', async () => {
    const a = fakeAudio();
    const mic = await openMic(a.win);
    expect(a.getUserMedia.calls).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false }]);
    // The worklet is a bundled module file, never a blob: URL.
    expect(a.contexts[0].modules).toHaveLength(1);
    expect(a.contexts[0].modules[0]).not.toMatch(/^blob:|^data:/);
    expect(a.contexts[0].modules[0]).toMatch(/capture-worklet/);
    const got: number[] = [];
    mic.onFrame((pcm, db) => got.push(pcm.length, db));
    a.nodes[0].port.emit(new Int16Array(320), -42);
    expect(got).toEqual([320, -42]);
    mic.close();
    expect(a.tracks.length).toBeGreaterThan(0);
    expect(a.tracks.every((t) => t.stopped)).toBe(true);
    expect(a.contexts[0].state).toBe('closed');
    expect(a.nodes[0].port.closed).toBe(true);
    // After close, no frame reaches anyone.
    a.nodes[0].port.closed = false;
    a.nodes[0].port.emit(new Int16Array(320), -10);
    expect(got).toEqual([320, -42]);
    mic.close(); // idempotent
    expect(CAPTURE_PROCESSOR).toBe('kq-capture');
  });

  test('a worklet that fails to load leaves no track running; a refused microphone opens no audio context', async () => {
    const a = fakeAudio();
    a.fail.addModule = new Error('no worklet');
    await expect(openMic(a.win)).rejects.toThrow('no worklet');
    expect(a.tracks.every((t) => t.stopped)).toBe(true);
    expect(a.contexts.every((c) => c.state === 'closed')).toBe(true);
    const b = fakeAudio();
    b.fail.gum = new Error('NotAllowedError');
    await expect(openMic(b.win)).rejects.toThrow('NotAllowedError');
    expect(b.contexts).toHaveLength(0);
  });

  test('fix round 1 (M4): a context that starts suspended (opened outside the gesture, WebKit) is resumed before frames are awaited', async () => {
    const a = fakeAudio();
    a.startSuspended = true;
    await openMic(a.win);
    expect(a.contexts[0].resumed).toBe(1);
    expect(a.contexts[0].state).toBe('running');
    const b = fakeAudio();
    await openMic(b.win);
    expect(b.contexts[0].resumed).toBe(0);
  });
});
