import { afterEach, describe, expect, test, vi } from 'vitest';
import { openMic, RESUME_TIMEOUT_MS } from './capture';
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

  test('fix round 2 (R1): the tracks are handed over before anything else is awaited; a resume that never settles can still be stopped at once', async () => {
    const a = fakeAudio();
    a.startSuspended = true;
    a.resumeHangs = true;
    let stop: (() => void) | null = null;
    let settled = false;
    void openMic(a.win, { onStream: (s) => { stop = s; } }).then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(a.contexts[0].resumed).toBe(1);
    expect(settled).toBe(false); // still waiting on the resume
    expect(a.tracks.length).toBeGreaterThan(0);
    expect(stop).not.toBeNull();
    stop!();
    expect(a.tracks.every((t) => t.stopped)).toBe(true);
  });

  test('fix round 2 (R1): a resume that has not settled after RESUME_TIMEOUT_MS stops the tracks, closes the context and fails', async () => {
    vi.useFakeTimers();
    const a = fakeAudio();
    a.startSuspended = true;
    a.resumeHangs = true;
    const opened = openMic(a.win);
    const failed = expect(opened).rejects.toThrow(/did not start/);
    await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS + 1);
    await failed;
    expect(a.tracks.every((t) => t.stopped)).toBe(true);
    expect(a.contexts[0].state).toBe('closed');
    expect(RESUME_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});

afterEach(() => { vi.useRealTimers(); });
