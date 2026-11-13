// M7 Step 8: the microphone's AudioWorklet. It runs on the audio thread, turns the context's float input into 20 ms
// PCM16 frames at 16 kHz with their level, and transfers each to the main thread. It keeps no audio past one frame.
// Bundled as its own module file (capture.ts imports its URL), never a blob: URL, so the CSP's script-src 'self' holds.
const SAMPLE_RATE_IN = 16_000; // core voice constants (this file is bundled alone, without core)
const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE_IN * FRAME_MS) / 1000;
/** The processor's registered name (capture.ts creates its node by it). */
export const CAPTURE_PROCESSOR = 'kq-capture';

export interface Framer { push(input: Float32Array): { pcm: Int16Array; db: number }[] }

/** Box-filter decimation from `inRate` to 16 kHz, cut into FRAME_SAMPLES frames. */
export function createFramer(inRate: number): Framer {
  const ratio = inRate / SAMPLE_RATE_IN;
  let acc = 0;
  let n = 0;
  let pos = 0;
  let frame = new Int16Array(FRAME_SAMPLES);
  let k = 0;
  let energy = 0;
  return {
    push(input) {
      const out: { pcm: Int16Array; db: number }[] = [];
      for (let i = 0; i < input.length; i++) {
        acc += input[i];
        n++;
        pos += 1;
        if (pos < ratio) continue;
        pos -= ratio;
        const x = Math.max(-1, Math.min(1, acc / n));
        acc = 0;
        n = 0;
        frame[k++] = Math.round(x * 32767);
        energy += x * x;
        if (k === FRAME_SAMPLES) {
          const rms = Math.sqrt(energy / FRAME_SAMPLES);
          out.push({ pcm: frame, db: rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100 });
          frame = new Int16Array(FRAME_SAMPLES);
          k = 0;
          energy = 0;
        }
      }
      return out;
    },
  };
}

// The AudioWorkletGlobalScope (absent in tests and on the main thread, where only the framer is used).
interface WorkletPort { postMessage(m: unknown, transfer: Transferable[]): void }
const scope = globalThis as unknown as {
  sampleRate?: number;
  AudioWorkletProcessor?: new () => { readonly port: WorkletPort };
  registerProcessor?: (name: string, ctor: unknown) => void;
};

if (scope.registerProcessor !== undefined && scope.AudioWorkletProcessor !== undefined) {
  const Base = scope.AudioWorkletProcessor;
  const rate = scope.sampleRate ?? SAMPLE_RATE_IN;
  class CaptureProcessor extends Base {
    private readonly framer = createFramer(rate);
    process(inputs: Float32Array[][]): boolean {
      const channel = inputs.at(0)?.at(0);
      if (channel !== undefined) for (const f of this.framer.push(channel)) this.port.postMessage(f, [f.pcm.buffer]);
      return true;
    }
  }
  scope.registerProcessor(CAPTURE_PROCESSOR, CaptureProcessor);
}
