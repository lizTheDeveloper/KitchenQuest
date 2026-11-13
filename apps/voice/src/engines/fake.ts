// M7: fake engines for tests, CI and `VOICE_ENGINE=fake` dev runs. No model, no GPU, no network.
import type { SttEngine, TtsEngine } from './types.js';

const abortError = () => new DOMException('aborted', 'AbortError');

/** An STT engine that answers `script(pcm)`. */
export function fakeStt(script: (pcm: Int16Array) => string): SttEngine {
  return {
    model: 'fake-stt',
    transcribe: async (pcm, _hint, signal) => {
      await Promise.resolve();
      if (signal.aborted) throw abortError();
      return script(pcm);
    },
  };
}

const WORD_MS = 50;
const TONE_HZ = 440;
const AMPLITUDE = 8000;

/** A TTS engine that gives 50 ms of sine per word, one word per piece, yielding to the event loop between words. */
export function fakeTts(sampleRate = 22_050): TtsEngine {
  const perWord = Math.round((sampleRate * WORD_MS) / 1000);
  return {
    model: 'fake-tts',
    sampleRate,
    synthesize: async function* (text, _voice, signal) {
      const words = text.split(/\s+/).filter((w) => w.length > 0);
      for (let w = 0; w < words.length; w++) {
        await new Promise<void>((r) => setImmediate(r));
        if (signal.aborted) return;
        const pcm = new Int16Array(perWord);
        for (let i = 0; i < perWord; i++) pcm[i] = Math.round(AMPLITUDE * Math.sin((2 * Math.PI * TONE_HZ * (w * perWord + i)) / sampleRate));
        yield pcm;
      }
    },
  };
}
