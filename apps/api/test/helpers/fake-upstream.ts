// M7 Step 5: an in-memory VoiceUpstream for the voice socket tests. No network: each link records what the route sent
// (counts and ids only, never keeping a frame) and answers as scripted. `down` makes open() and every live link fail as
// the real service going away would; `up` brings it back.
import { decodeFrame, encodeFrame, FRAME_MS, parseServerMsg, SAMPLE_RATE_IN, type ServerMsg } from '@kitchenquest/core';
import WebSocket from 'ws';
import { isSpeakable, type SpeakableText } from '../../src/voice/speak.js';
import { VoiceUpstreamError, type UpstreamFailure, type VoiceLink, type VoiceUpstream } from '../../src/voice/upstream.js';

export interface FakeUtterance {
  id: number;
  hint: string[];
  frames: number;
  ended: boolean;
  cancelled: boolean;
}

export interface FakeSpeech {
  id: number;
  voice: string;
  chunks: { text: string; cache: boolean }[];
  cancelled: boolean;
}

export interface FakeUpstreamOptions {
  /** The transcript of an utterance (default: "heard <frames> frames"). Throw to fail it. */
  transcribe?: (u: FakeUtterance) => string | Promise<string>;
  /** Frames of TTS audio per speak (default 2, at 22050 Hz, 20 ms each). */
  ttsFrames?: number;
  /** Called with what the link saw, for the memory-only test's positive control. */
  onTranscript?: (text: string) => void;
  /** Called with each forwarded frame's samples (the positive control's leak). */
  onFrame?: (pcm: Int16Array) => void;
  /**
   * When `transcribe` throws, reject `end` with that very error (a careless adapter) instead of a content-free
   * `stt` failure: the route must never read or log it.
   */
  rawErrors?: boolean;
  /** open() waits for this first (a slow service), so messages queue up behind a listen. */
  openGate?: Promise<void>;
}

export class FakeUpstream implements VoiceUpstream {
  readonly utterances: FakeUtterance[] = [];
  readonly speeches: FakeSpeech[] = [];
  opens = 0;
  isDown = false;
  private gatePassed = false;
  private openFailure: UpstreamFailure = 'down';
  private readonly live = new Set<{ fail(kind: UpstreamFailure): void }>();

  constructor(private readonly opts: FakeUpstreamOptions = {}) {}

  /** The service goes away: live links close (in-flight calls reject `kind`) and new opens fail with `kind`. */
  down(kind: UpstreamFailure = 'down'): void {
    this.isDown = true;
    this.openFailure = kind;
    for (const l of [...this.live]) l.fail(kind);
  }

  up(): void {
    this.isDown = false;
  }

  /** Frames forwarded in all, over every utterance. */
  get framesForwarded(): number {
    return this.utterances.reduce((n, u) => n + u.frames, 0);
  }

  open(signal: AbortSignal): Promise<VoiceLink> {
    this.opens++;
    if (this.isDown) return Promise.reject(new VoiceUpstreamError(this.openFailure));
    if (signal.aborted) return Promise.reject(new VoiceUpstreamError('cancelled'));
    if (this.opts.openGate !== undefined && !this.gatePassed) {
      return this.opts.openGate.then(() => {
        this.gatePassed = true;
        this.opens--;
        return this.open(signal);
      });
    }
    // The link's view of this fake (no `this` inside the link's own methods).
    const fake = { opts: this.opts, utterances: this.utterances, speeches: this.speeches, live: this.live };
    let open = true;
    const utterances = new Map<number, { u: FakeUtterance; reject?: (e: VoiceUpstreamError) => void }>();
    const speeches = new Map<number, { s: FakeSpeech; reject: (e: VoiceUpstreamError) => void }>();
    const handle = {
      fail(kind: UpstreamFailure) {
        open = false;
        fake.live.delete(handle);
        for (const { reject } of utterances.values()) reject?.(new VoiceUpstreamError(kind));
        for (const { reject } of speeches.values()) reject(new VoiceUpstreamError(kind));
        utterances.clear();
        speeches.clear();
      },
    };
    this.live.add(handle);
    const link: VoiceLink = {
      listen(id, hint) {
        if (!open) return;
        const u: FakeUtterance = { id, hint: [...hint], frames: 0, ended: false, cancelled: false };
        fake.utterances.push(u);
        utterances.set(id, { u });
      },
      frame(id, pcm) {
        const e = utterances.get(id);
        if (!open || e === undefined || e.u.ended) return;
        if (pcm.length !== (SAMPLE_RATE_IN * FRAME_MS) / 1000) throw new Error('fake upstream: not a 20 ms frame');
        fake.opts.onFrame?.(pcm);
        e.u.frames++;
      },
      end(id) {
        const e = utterances.get(id);
        if (!open || e === undefined) return Promise.reject(new VoiceUpstreamError(open ? 'cancelled' : 'down'));
        e.u.ended = true;
        return new Promise<{ text: string }>((resolve, reject) => {
          e.reject = reject;
          Promise.resolve()
            .then(() => (fake.opts.transcribe ?? ((u: FakeUtterance) => `heard ${u.frames} frames`))(e.u))
            .then(
              (text) => {
                if (!utterances.has(id)) return;
                utterances.delete(id);
                fake.opts.onTranscript?.(text);
                resolve({ text });
              },
              (err: unknown) => {
                if (!utterances.has(id)) return;
                utterances.delete(id);
                // The error itself is never looked at, as the real service: it may hold the transcript.
                reject(fake.opts.rawErrors ? (err as VoiceUpstreamError) : new VoiceUpstreamError('stt'));
              },
            );
        });
      },
      speak(id, voice, text: SpeakableText, onPcm) {
        if (!isSpeakable(text)) throw new TypeError('not SpeakableText');
        if (!open) return Promise.reject(new VoiceUpstreamError('down'));
        const s: FakeSpeech = { id, voice, chunks: text.chunks.map((c) => ({ ...c })), cancelled: false };
        fake.speeches.push(s);
        return new Promise((resolve, reject) => {
          speeches.set(id, { s, reject });
          const frames = fake.opts.ttsFrames ?? 2;
          void (async () => {
            for (let i = 0; i < frames; i++) {
              await new Promise((r) => setImmediate(r));
              if (!speeches.has(id)) return;
              onPcm(new Int16Array(441).fill(1000), 22_050);
            }
            if (!speeches.has(id)) return;
            speeches.delete(id);
            resolve({ audioMs: frames * 20 });
          })();
        });
      },
      cancel(id) {
        const e = utterances.get(id);
        if (e) {
          e.u.cancelled = true;
          utterances.delete(id);
          e.reject?.(new VoiceUpstreamError('cancelled'));
        }
        const s = speeches.get(id);
        if (s) {
          s.s.cancelled = true;
          speeches.delete(id);
          s.reject(new VoiceUpstreamError('cancelled'));
        }
      },
      close() {
        handle.fail('cancelled');
      },
      isOpen: () => open,
    };
    return Promise.resolve(link);
  }
}

// --- a browser-side client for the voice socket ----------------------------------------------------------------------

export interface VoiceClient {
  ws: WebSocket;
  /** Every JSON message received, in order. */
  msgs: ServerMsg[];
  /** Binary frames received: id and sample count only. */
  frames: { id: number; samples: number }[];
  /** The close code, once closed. */
  closed: Promise<number>;
  send(msg: object): void;
  frame(id: number, samples?: number, value?: number): void;
  /** Resolves with the first message (from the start) that matches and was not taken yet. */
  next(pred?: (m: ServerMsg) => boolean, ms?: number): Promise<ServerMsg>;
}

/** Opens `ws://127.0.0.1:<port>/voice` as a browser would: the session cookie and an Origin (null: none). */
export function connectVoice(port: number, opts: { cookie?: string; origin?: string | null }): Promise<VoiceClient> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) headers.cookie = `kq_session=${opts.cookie}`;
  if (opts.origin !== null) headers.origin = opts.origin ?? 'http://localhost:5173';
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`, { headers });
  const msgs: ServerMsg[] = [];
  const frames: { id: number; samples: number }[] = [];
  const taken = new Set<number>();
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  let closedCode = -1;
  const closed = new Promise<number>((resolve) =>
    ws.on('close', (code) => {
      closedCode = code;
      wake();
      resolve(code);
    }),
  );
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (binary) {
      const f = decodeFrame(new Uint8Array(data));
      if (f) frames.push({ id: f.id, samples: f.pcm.length });
    } else {
      const m = parseServerMsg(JSON.parse(data.toString('utf8')));
      if (m === null) throw new Error('the API sent a message core parseServerMsg refuses');
      msgs.push(m);
    }
    wake();
  });
  const client: VoiceClient = {
    ws,
    msgs,
    frames,
    closed,
    send: (msg) => ws.send(JSON.stringify(msg)),
    frame: (id, samples = (SAMPLE_RATE_IN * FRAME_MS) / 1000, value = 7) => ws.send(encodeFrame(id, new Int16Array(samples).fill(value)), { binary: true }),
    async next(pred = () => true, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = msgs.findIndex((m, k) => !taken.has(k) && pred(m));
        if (i >= 0) {
          taken.add(i);
          return msgs[i];
        }
        if (closedCode !== -1 || Date.now() > deadline) throw new Error(`no such message (closed ${closedCode}); got ${JSON.stringify(msgs)}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
  });
}
