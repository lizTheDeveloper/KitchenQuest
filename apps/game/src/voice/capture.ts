// M7 Step 8: the microphone. Frames live in memory only, for as long as a listener holds them (C-18): nothing here
// stores, logs or copies audio. Only the controller opens it, and never in Family Table or for a child (Ruling 9).
import workletUrl from './capture-worklet.ts?worker&url';
import { CAPTURE_PROCESSOR } from './capture-worklet';

export interface Mic {
  onFrame(fn: (pcm: Int16Array, db: number) => void): void;
  /** Stops every track, the worklet and the audio context. Idempotent. */
  close(): void;
}

type AudioWin = Window & { AudioContext: typeof AudioContext; AudioWorkletNode: typeof AudioWorkletNode };

/** The microphone with the browser's echo cancellation, noise suppression and gain control on, mono. */
export async function openMic(win: Window): Promise<Mic> {
  const w = win as AudioWin;
  const stream = await w.navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  const stopTracks = () => { for (const t of stream.getTracks()) t.stop(); };
  let ctx: AudioContext | null = null;
  try {
    ctx = new w.AudioContext();
    await ctx.audioWorklet.addModule(workletUrl);
    const source = ctx.createMediaStreamSource(stream);
    const node = new w.AudioWorkletNode(ctx, CAPTURE_PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
    source.connect(node);
    const listeners: ((pcm: Int16Array, db: number) => void)[] = [];
    let closed = false;
    node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; db: number }>) => {
      if (closed) return;
      for (const fn of listeners) fn(e.data.pcm, e.data.db);
    };
    const open = ctx;
    return {
      onFrame: (fn) => { listeners.push(fn); },
      close: () => {
        if (closed) return;
        closed = true;
        listeners.length = 0;
        node.port.onmessage = null;
        node.port.close();
        source.disconnect();
        node.disconnect();
        stopTracks();
        void open.close().catch(() => undefined);
      },
    };
  } catch (e) {
    stopTracks();
    void ctx?.close().catch(() => undefined);
    throw e;
  }
}
