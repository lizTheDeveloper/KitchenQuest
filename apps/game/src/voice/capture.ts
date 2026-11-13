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

/** Fix round 2 (R1): a suspended context that does not start within this long (no user activation) is given up. */
export const RESUME_TIMEOUT_MS = 2000;

/**
 * The microphone with the browser's echo cancellation, noise suppression and gain control on, mono.
 * Fix round 2 (R1): `onStream` gets a stop for the live tracks the moment they exist, before anything else is
 * awaited, so the caller can always stop them, also while the context is still being started.
 */
export async function openMic(win: Window, opts: { onStream?: (stop: () => void) => void } = {}): Promise<Mic> {
  const w = win as AudioWin;
  const stream = await w.navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  const stopTracks = () => { for (const t of stream.getTracks()) t.stop(); };
  opts.onStream?.(stopTracks);
  let ctx: AudioContext | null = null;
  try {
    ctx = new w.AudioContext();
    // Fix round 1 (M4): made after the hello and the permission prompt, outside the gesture: WebKit may start it
    // suspended, and then no frame would ever arrive.
    if (ctx.state === 'suspended') {
      // R1: a resume the browser keeps pending (Web Audio §1.1.4) must never hold the microphone open.
      let timer: number | undefined;
      const late = new Promise<'late'>((resolve) => { timer = win.setTimeout(() => resolve('late'), RESUME_TIMEOUT_MS); });
      const r = await Promise.race([ctx.resume().then(() => 'ok' as const), late]);
      win.clearTimeout(timer);
      if (r === 'late') throw new Error('the microphone did not start (the audio context stayed suspended)');
    }
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
