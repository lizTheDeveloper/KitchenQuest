// M7 spec §9: one Session per API connection, speaking core's upstream protocol (P1). It holds at most one utterance
// and one speech at a time. C-18: audio lives only in a preallocated buffer that is zero-filled whenever the utterance
// ends (end, cancel, replace, close, the length limit); nothing is written or logged but enums and numbers. P2: each
// chunk is spoken exactly as the API sent it; the service never renders, filters or chunks speech itself.
import {
  decodeFrame,
  encodeFrame,
  FRAME_MS,
  HINT_MAX_WORDS,
  MAX_UTTERANCE_MS,
  parseUpstreamClientMsg,
  SAMPLE_RATE_IN,
  type UpstreamClientMsg,
  type UpstreamServerMsg,
} from '@kitchenquest/core';
import type { SttEngine, TtsEngine } from './engines/types.js';
import type { Logger } from './log.js';

/** The most samples one utterance may hold: MAX_UTTERANCE_MS at SAMPLE_RATE_IN. */
const MAX_SAMPLES = (MAX_UTTERANCE_MS * SAMPLE_RATE_IN) / 1000;
/** WebSocket close code for a message the protocol refuses. */
const CLOSE_BAD_MESSAGE = 4400;

interface SessionIo {
  json(msg: UpstreamServerMsg): void;
  /** Sends one audio frame. False when the socket is congested (backpressure): the speech then stops. */
  frame(bytes: Uint8Array): boolean;
  close(code: number): void;
}

export interface SessionDeps {
  stt: SttEngine;
  tts: TtsEngine;
  /** The Pan's TTS model and voice; the `voice` the API names (`pan`) is a role, resolved here. */
  cast: { model: string; voice: string };
  cache: SpeechCache;
  log: Logger;
  io: SessionIo;
  /** Allocates an utterance buffer; tests pass one to watch it being zeroed. */
  alloc?: (samples: number) => Int16Array;
}

interface Utterance {
  id: number;
  hint: string[];
  buf: Int16Array;
  len: number;
  ended: boolean;
  abort: AbortController;
}

interface Speech {
  id: number;
  abort: AbortController;
}

/**
 * Synthesised audio for `cache: true` chunks (scripted lines), keyed by (voice, text), oldest out first. It holds the
 * Pan's speech only, never the player's audio, and only in memory.
 */
export class SpeechCache {
  private readonly entries = new Map<string, Int16Array>();
  constructor(private readonly maxEntries = 128) {}
  private static key(voice: string, text: string): string {
    return `${voice}\u0000${text}`;
  }
  get size(): number {
    return this.entries.size;
  }
  has(voice: string, text: string): boolean {
    return this.entries.has(SpeechCache.key(voice, text));
  }
  get(voice: string, text: string): Int16Array | undefined {
    const k = SpeechCache.key(voice, text);
    const v = this.entries.get(k);
    if (v !== undefined) {
      this.entries.delete(k);
      this.entries.set(k, v);
    }
    return v;
  }
  set(voice: string, text: string, pcm: Int16Array): void {
    const k = SpeechCache.key(voice, text);
    this.entries.delete(k);
    this.entries.set(k, pcm);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}

export class Session {
  private helloed = false;
  private closed = false;
  private utterance: Utterance | null = null;
  private speech: Speech | null = null;
  private readonly pending = new Set<Promise<void>>();
  /** STT calls not yet settled, aborted ones included: at most one (review M2), so an engine ignoring an abort cannot pile up buffers. */
  private transcribing = 0;
  private readonly alloc: (samples: number) => Int16Array;
  private readonly voices: ReadonlyMap<string, string>;

  constructor(private readonly deps: SessionDeps) {
    this.alloc = deps.alloc ?? ((n) => new Int16Array(n));
    this.voices = new Map([['pan', deps.cast.voice]]);
  }

  /** One WebSocket message: a JSON text message or a binary audio frame. */
  receive(data: Uint8Array | string, binary: boolean): void {
    if (this.closed) {
      if (typeof data !== 'string') data.fill(0);
      return;
    }
    if (binary && typeof data !== 'string') return this.onFrame(data);
    let msg: UpstreamClientMsg | null = null;
    try {
      msg = parseUpstreamClientMsg(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8')));
    } catch {
      msg = null;
    }
    if (msg === null) return this.bad();
    if (!this.helloed) {
      if (msg.t !== 'hello') return this.bad();
      this.helloed = true;
      const { stt, tts } = this.deps;
      return this.send({ t: 'ready', stt: stt.model, tts: tts.model, sampleRate: tts.sampleRate });
    }
    switch (msg.t) {
      case 'hello':
        return this.bad();
      case 'listen':
        return this.listen(msg.id, msg.hint);
      case 'end':
        if (this.utterance?.id === msg.id && !this.utterance.ended) this.finish(this.utterance);
        return;
      case 'cancel':
        if (this.utterance?.id === msg.id) this.dropUtterance();
        if (this.speech?.id === msg.id) this.dropSpeech();
        return;
      case 'speak':
        return this.speak(msg.id, msg.voice, msg.chunks);
    }
  }

  /** The connection closed: everything stops, and the utterance buffer is zeroed. Nothing is sent after this. */
  close(): void {
    this.closed = true;
    this.dropUtterance();
    this.dropSpeech();
  }

  /** Resolves once every transcription and speech in flight has settled. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Counts only, for tests: what the session still holds. */
  inspect(): { utterance: number | null; hintWords: number; bufferedSamples: number; speech: number | null } {
    const u = this.utterance;
    return { utterance: u?.id ?? null, hintWords: u?.hint.length ?? 0, bufferedSamples: u?.len ?? 0, speech: this.speech?.id ?? null };
  }

  private send(msg: UpstreamServerMsg): void {
    if (!this.closed) this.deps.io.json(msg);
  }

  private bad(): void {
    this.deps.log('bad_message');
    this.close();
    this.deps.io.close(CLOSE_BAD_MESSAGE);
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  // --- listening ---------------------------------------------------------------------------------------------------

  private onFrame(raw: Uint8Array): void {
    const frame = decodeFrame(raw);
    raw.fill(0);
    if (frame === null || !this.helloed) {
      frame?.pcm.fill(0);
      return this.bad();
    }
    const u = this.utterance;
    if (u !== null && !u.ended && u.id === frame.id) {
      const n = Math.min(frame.pcm.length, MAX_SAMPLES - u.len);
      u.buf.set(frame.pcm.subarray(0, n), u.len);
      u.len += n;
      if (u.len >= MAX_SAMPLES) this.finish(u); // past MAX_UTTERANCE_MS: end with what came
    }
    frame.pcm.fill(0);
  }

  private listen(id: number, hint: string[]): void {
    this.dropUtterance(); // one utterance at a time: a new listen replaces the old, which gets no reply
    this.utterance = { id, hint: hint.slice(0, HINT_MAX_WORDS), buf: this.alloc(MAX_SAMPLES), len: 0, ended: false, abort: new AbortController() };
  }

  private release(u: Utterance): void {
    u.buf.fill(0);
    u.len = 0;
    u.hint.length = 0;
    if (this.utterance === u) this.utterance = null;
  }

  private dropUtterance(): void {
    const u = this.utterance;
    if (u === null) return;
    u.abort.abort();
    this.release(u);
  }

  private finish(u: Utterance): void {
    u.ended = true;
    if (u.len === 0) {
      this.release(u);
      return this.send({ t: 'failed', id: u.id, kind: 'stt' });
    }
    if (this.transcribing > 0) {
      // The engine still holds an earlier (aborted) utterance: refuse rather than start a second call.
      this.release(u);
      return this.send({ t: 'failed', id: u.id, kind: 'stt' });
    }
    const started = Date.now();
    const samples = u.len;
    const signal = u.abort.signal;
    this.transcribing++;
    this.track(
      // Fix round 1 (I1): inside .then, so an engine that throws synchronously is a rejection like any other.
      Promise.resolve()
        .then(() => {
          if (signal.aborted) throw new Error('aborted');
          return this.deps.stt.transcribe(u.buf.subarray(0, u.len), u.hint, signal);
        })
        .then(
          (text) => {
            if (signal.aborted) return;
            if (text.trim() === '') return this.send({ t: 'failed', id: u.id, kind: 'stt' });
            // A transcript over MAX_TEXT is sent as heard: the API turns it into `too_long` (core upstream.ts, N7).
            this.send({ t: 'transcript', id: u.id, text });
            this.deps.log('stt_done', { audioMs: Math.round((samples * 1000) / SAMPLE_RATE_IN), ms: Date.now() - started });
          },
          () => {
            if (signal.aborted) return;
            // The error itself is never looked at: an engine's message may hold the transcript.
            this.deps.log('engine_error', { stt: true });
            this.send({ t: 'failed', id: u.id, kind: 'stt' });
          },
        )
        .finally(() => {
          this.transcribing--;
          this.release(u);
        }),
    );
  }

  // --- speaking ----------------------------------------------------------------------------------------------------

  private dropSpeech(): void {
    this.speech?.abort.abort();
    this.speech = null;
  }

  private speak(id: number, role: string, chunks: { text: string; cache: boolean }[]): void {
    this.dropSpeech(); // one speech at a time: a new speak replaces the old, which gets no audio_end
    const voice = this.voices.get(role);
    if (voice === undefined) return this.send({ t: 'failed', id, kind: 'tts' });
    const s: Speech = { id, abort: new AbortController() };
    this.speech = s;
    this.track(
      Promise.resolve()
        .then(() => this.play(s, voice, chunks))
        .then((result) => {
          // A client that stops reading gets no more audio, only the failure (review M2).
          if (result === 'congested') this.send({ t: 'failed', id, kind: 'tts' });
        })
        .catch(() => {
          if (s.abort.signal.aborted) return;
          this.deps.log('engine_error', { tts: true });
          this.send({ t: 'failed', id, kind: 'tts' });
        })
        .finally(() => {
          if (this.speech === s) this.speech = null;
        }),
    );
  }

  /** `congested` when the socket stopped taking frames (backpressure), `stopped` when cancelled or closed. */
  private async play(s: Speech, voice: string, chunks: { text: string; cache: boolean }[]): Promise<'done' | 'stopped' | 'congested'> {
    const { tts, cache, io } = this.deps;
    const signal = s.abort.signal;
    const started = Date.now();
    const frameLen = Math.round((tts.sampleRate * FRAME_MS) / 1000);
    const out = new Int16Array(frameLen);
    let fill = 0;
    let total = 0;
    let cached = 0;
    const live = () => !signal.aborted && !this.closed && !congested;
    const push = (pcm: Int16Array) => {
      for (let i = 0; i < pcm.length && live(); ) {
        const n = Math.min(frameLen - fill, pcm.length - i);
        out.set(pcm.subarray(i, i + n), fill);
        fill += n;
        i += n;
        total += n;
        if (fill === frameLen) {
          send(encodeFrame(s.id, out));
          fill = 0;
        }
      }
    };

    let congested = false;
    const stopped = () => (congested ? 'congested' : 'stopped');
    const send = (bytes: Uint8Array) => {
      if (!io.frame(bytes)) congested = true;
    };
    for (const chunk of chunks) {
      const hit = chunk.cache ? cache.get(voice, chunk.text) : undefined;
      if (hit !== undefined) {
        cached++;
        push(hit);
      } else {
        const pieces: Int16Array[] = [];
        for await (const piece of tts.synthesize(chunk.text, voice, signal)) {
          if (!live()) return stopped();
          push(piece);
          if (chunk.cache) pieces.push(piece.slice());
        }
        if (!live()) return stopped();
        if (chunk.cache) cache.set(voice, chunk.text, concat(pieces));
      }
      if (!live()) return stopped();
    }
    if (fill > 0) send(encodeFrame(s.id, out.subarray(0, fill)));
    if (!live()) return stopped();
    const audioMs = Math.round((total * 1000) / tts.sampleRate);
    this.send({ t: 'audio_end', id: s.id, audioMs });
    this.deps.log('tts_done', { audioMs, ms: Date.now() - started, chunks: chunks.length, cached });
    return 'done';
  }
}

function concat(pieces: Int16Array[]): Int16Array {
  const out = new Int16Array(pieces.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
