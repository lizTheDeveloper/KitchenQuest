// Test only: engines that fail in every way an engine can, each with the transcript marker and the PCM in its message
// (review I1). Swapped in for src/engines/fake.ts by fault-hooks.mjs. The hint word picks the fault.
import type { SttEngine, TtsEngine } from '../../src/engines/types';
import { fakeTts as realFakeTts } from '../../src/engines/fake';

const MARKER = 'zebrapeanut71';
const hex = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, Math.min(pcm.byteLength, 32)).toString('hex');

export function fakeStt(_script: (pcm: Int16Array) => string): SttEngine {
  return {
    model: 'fault-stt',
    transcribe: (pcm, hint) => {
      const message = `engine fault ${MARKER} ${hex(pcm)}`;
      if (hint.includes('sync')) throw new Error(message);
      if (hint.includes('escape')) {
        setImmediate(() => {
          throw new Error(message);
        });
      }
      if (hint.includes('unhandled')) void Promise.reject(new Error(message));
      // The positive control: an engine that prints, as a careless adapter would.
      if (hint.includes('print')) console.error(new Error(message));
      return Promise.resolve(MARKER);
    },
  };
}

export function fakeTts(sampleRate?: number): TtsEngine {
  const real = realFakeTts(sampleRate);
  return {
    model: real.model,
    sampleRate: real.sampleRate,
    synthesize: (text, voice, signal) => {
      if (text.startsWith('boom')) throw new Error(`tts fault ${text}`);
      return real.synthesize(text, voice, signal);
    },
  };
}
