// M7 Step 8: the Pan's voice, played from PCM16 the API streams. In memory only, and dropped at once on stop (barge-in,
// §7.7). Ids only go up: audio for a speech already stopped or replaced is ignored.

export interface Player {
  play(id: number, pcm: Int16Array, sampleRate: number): void;
  /** Halts what is playing and drops the queue, at once. */
  stop(): void;
  readonly speaking: boolean;
  /** Called when the queue has played out, or was stopped. */
  onIdle(fn: () => void): () => void;
}

type AudioWin = Window & { AudioContext: typeof AudioContext };
const contexts = new WeakMap<Window, AudioContext>();

/** The window's one output AudioContext (playback and the earcon share it), resumed. */
export function outputContext(win: Window): AudioContext {
  let ctx = contexts.get(win);
  if (ctx === undefined || ctx.state === 'closed') {
    ctx = new (win as AudioWin).AudioContext();
    contexts.set(win, ctx);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

export function createPlayer(win: Window): Player {
  const live = new Set<AudioBufferSourceNode>();
  const idle = new Set<() => void>();
  let current: number | null = null;
  /** Ids below this are stopped or replaced: their audio is ignored. */
  let floor = 0;
  let next = 0;

  const fireIdle = () => { for (const fn of [...idle]) fn(); };
  const dropAll = () => {
    for (const src of live) {
      src.onended = null;
      try { src.stop(); } catch { /* not started yet */ }
      src.disconnect();
    }
    live.clear();
    next = 0;
  };

  return {
    play(id, pcm, sampleRate) {
      if (id < floor || (current !== null && id < current)) return;
      if (current !== null && id !== current) {
        floor = id;
        dropAll();
      }
      current = id;
      const ctx = outputContext(win);
      const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const at = Math.max(ctx.currentTime, next);
      src.start(at);
      next = at + buffer.duration;
      live.add(src);
      src.onended = () => {
        live.delete(src);
        if (live.size === 0) { next = 0; fireIdle(); }
      };
    },
    stop() {
      if (current !== null) floor = current + 1;
      current = null;
      const was = live.size > 0;
      dropAll();
      if (was) fireIdle();
    },
    get speaking() { return live.size > 0; },
    onIdle(fn) { idle.add(fn); return () => { idle.delete(fn); }; },
  };
}
