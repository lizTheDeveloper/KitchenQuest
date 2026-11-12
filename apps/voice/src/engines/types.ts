// M7: THE provider seam. The voice service talks to speech engines only through these two interfaces: fakes in tests
// and CI (fake.ts), the Python worker in Step 3. Audio stays in memory as Int16Array PCM; an engine never writes it.

export interface SttEngine {
  readonly model: string;
  /** PCM16 mono at SAMPLE_RATE_IN; `hint` is the vocabulary hint, at most HINT_MAX_WORDS. Rejects when aborted. */
  transcribe(pcm: Int16Array, hint: readonly string[], signal: AbortSignal): Promise<string>;
}

export interface TtsEngine {
  readonly model: string;
  readonly sampleRate: number;
  /** PCM16 mono at `sampleRate`, in pieces of any length. Stops when aborted. */
  synthesize(text: string, voice: string, signal: AbortSignal): AsyncIterable<Int16Array>;
}
