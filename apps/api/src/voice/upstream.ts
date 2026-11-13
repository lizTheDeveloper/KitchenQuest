// M7 P1: the API's side of core's upstream protocol, to the private voice service (`apps/voice`). One link per
// browser socket. Replies are matched by id (core upstream.ts): the route mints a fresh id for every listen and speak,
// and a reply for any id this link no longer waits on is dropped. Audio passes through: a frame is encoded, sent and
// let go; nothing here stores, logs or keeps a reference to one (C-18). Errors carry a kind, never content.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
  decodeFrame,
  encodeFrame,
  parseUpstreamServerMsg,
  upstreamClose,
  upstreamRefusal,
  type UpstreamClientMsg,
  type UpstreamServerMsg,
} from '@kitchenquest/core';
import WebSocket from 'ws';
import { isSpeakable, type SpeakableText } from './speak.js';

/** What went wrong with a voice service call, as a kind only (never the service's words or the player's). */
export type UpstreamFailure =
  /** GET /ready said 503: no worker ready. */
  | 'not_ready'
  /** Unreachable, refused, reset, or closed by the service (1011, 1001, …). */
  | 'down'
  /** The service refused our token (401) or saw an Origin (403): configuration. */
  | 'auth'
  /** At its maxConnections (503 at the upgrade). */
  | 'busy'
  /** Not a WebSocket endpoint (426): a wrong URL. */
  | 'misrouted'
  /** The service closed with 4400: we sent something its protocol refuses. */
  | 'bad_message'
  /** It closed an idle link (4408); the next call reconnects. */
  | 'idle'
  /** An STT or TTS failure for that id. */
  | 'stt'
  | 'tts'
  /** No reply in time for that id. */
  | 'timeout'
  /** A transcript over MAX_TEXT (core N7): refused, never cut. */
  | 'too_long'
  /** We cancelled it, replaced it or closed the link. */
  | 'cancelled';

/** M7 Step 10 fix round 5 (F4-1): the most of an over-cap transcript kept for the route's child scan, in memory only. */
export const OVER_CAP_SCAN_UNITS = 4000;

export class VoiceUpstreamError extends Error {
  /**
   * `overCap`: for `too_long`, the over-cap transcript itself (at most OVER_CAP_SCAN_UNITS), so the route can scan it
   * for a child before refusing it (fix round 5). Never sent on, kept, logged, or put in the message.
   */
  constructor(public readonly kind: UpstreamFailure, public readonly overCap?: string) {
    super(`voice upstream: ${kind}`);
    this.name = 'VoiceUpstreamError';
  }
}

export interface VoiceLink {
  /** Starts utterance `id` (fresh per listen) with the STT vocabulary hint. */
  listen(id: number, hint: readonly string[]): void;
  /** Forwards one frame of the utterance; the samples are encoded and sent, never kept. */
  frame(id: number, pcm: Int16Array): void;
  /** Ends the utterance and waits for its transcript (P1: speechMs is counted by the route). */
  end(id: number): Promise<{ text: string }>;
  /** Speaks `text` (only SpeakableText, D4) as `voice`; `onPcm` gets each audio frame. */
  speak(id: number, voice: string, text: SpeakableText, onPcm: (pcm: Int16Array, sampleRate: number) => void): Promise<{ audioMs: number }>;
  /** Stops utterance or speech `id`; its promise rejects `cancelled` and any late reply is dropped. */
  cancel(id: number): void;
  close(): void;
  /** False once the link is closed, by either side: the route opens a new one for its next call. */
  isOpen(): boolean;
}

export interface VoiceUpstream {
  open(signal: AbortSignal): Promise<VoiceLink>;
}

/**
 * Timing, tunable for tests. Carry 3 (Step 3 fix round 1): the service's worker pool fails an STT request 20 s after
 * submission, queue included, so the API waits longer than that before it gives up on an id; the first TTS message
 * may take a cold synthesis.
 */
export interface UpstreamTiming {
  /** GET /ready must answer within this (fail fast when the service is not ready). */
  readyMs: number;
  /** The upgrade, `hello` and the service's `ready` within this. */
  connectMs: number;
  /** After `end`, the transcript (or `failed`) within this; at least the service's own 20 s deadline. */
  sttReplyMs: number;
  /** After `speak`, the first audio frame or reply within this, and then each next one. */
  ttsFirstMs: number;
}

export const UPSTREAM_TIMING: Readonly<UpstreamTiming> = Object.freeze({ readyMs: 2000, connectMs: 5000, sttReplyMs: 25_000, ttsFirstMs: 30_000 });

/** At most this much binary audio from the service in one message (a 20 ms frame is under 1 KB). */
const MAX_PAYLOAD = 64 * 1024;

interface Waiter<T> {
  resolve(v: T): void;
  reject(e: VoiceUpstreamError): void;
  timer: NodeJS.Timeout | null;
}

function deferred<T>(): { promise: Promise<T>; waiter: Waiter<T> } {
  let resolve!: (v: T) => void;
  let reject!: (e: VoiceUpstreamError) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A rejection nobody awaits yet (a `failed` before `end`, a replaced id) is never unhandled.
  promise.catch(() => {});
  return { promise, waiter: { resolve, reject, timer: null } };
}

/** GET /ready on the service's host and port (200 ready, anything else not), within `ms`. */
function checkReady(url: URL, ms: number, signal: AbortSignal): Promise<void> {
  const tls = url.protocol === 'wss:';
  const request = tls ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port === '' ? (tls ? 443 : 80) : Number(url.port), path: '/ready', method: 'GET', timeout: ms, signal },
      (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else reject(new VoiceUpstreamError(res.statusCode === 503 ? 'not_ready' : 'down'));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => reject(new VoiceUpstreamError('down')));
    req.end();
  });
}

/**
 * The voice service over WebSocket (`Authorization: Bearer <token>`, no Origin: the service refuses any browser). Each
 * open first checks `GET /ready` and fails fast with `not_ready` on 503 (carry 3), then says `hello` and waits for
 * `ready`. Close codes and upgrade refusals are mapped with core `upstreamClose` / `upstreamRefusal` (carry 1).
 */
export function wsUpstream(url: URL, token: Buffer, timing: Partial<UpstreamTiming> = {}): VoiceUpstream {
  const t: UpstreamTiming = { ...UPSTREAM_TIMING, ...timing };
  return {
    async open(signal) {
      await checkReady(url, t.readyMs, signal);
      if (signal.aborted) throw new VoiceUpstreamError('cancelled');
      const ws = new WebSocket(url, {
        headers: { authorization: `Bearer ${token.toString('utf8')}` },
        perMessageDeflate: false,
        maxPayload: MAX_PAYLOAD,
        handshakeTimeout: t.connectMs,
      });
      return connect(ws, t, signal);
    },
  };
}

function connect(ws: WebSocket, t: UpstreamTiming, signal: AbortSignal): Promise<VoiceLink> {
  return new Promise((resolve, reject) => {
    let sampleRate = 0;
    let open = true;
    let ready = false;
    /**
     * Utterances by id. `done`: answered already (the service ends an utterance itself at MAX_UTTERANCE_MS, so its
     * transcript can come before our `end`); the entry stays until `end` or `cancel` takes it.
     */
    const utterances = new Map<number, { promise: Promise<{ text: string }>; waiter: Waiter<{ text: string }>; done: boolean }>();
    const speeches = new Map<number, { waiter: Waiter<{ audioMs: number }>; onPcm: (pcm: Int16Array, rate: number) => void }>();

    const settle = (w: { timer: NodeJS.Timeout | null }) => {
      if (w.timer !== null) clearTimeout(w.timer);
      w.timer = null;
    };
    const failAll = (kind: UpstreamFailure) => {
      for (const [, u] of utterances) {
        settle(u.waiter);
        u.waiter.reject(new VoiceUpstreamError(kind));
      }
      for (const [, s] of speeches) {
        settle(s.waiter);
        s.waiter.reject(new VoiceUpstreamError(kind));
      }
      utterances.clear();
      speeches.clear();
    };
    const shut = (kind: UpstreamFailure, code = 1000) => {
      if (!open) return;
      open = false;
      failAll(kind);
      clearTimeout(connectTimer);
      signal.removeEventListener('abort', onAbort);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        try {
          ws.close(code);
        } catch {
          ws.terminate();
        }
      }
      if (!ready) reject(new VoiceUpstreamError(kind));
    };
    const onAbort = () => shut('cancelled');
    signal.addEventListener('abort', onAbort, { once: true });
    const connectTimer = setTimeout(() => shut('down'), t.connectMs);

    const send = (msg: UpstreamClientMsg): boolean => {
      if (!open || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    };
    const armSpeech = (id: number) => {
      const s = speeches.get(id);
      if (s === undefined) return;
      settle(s.waiter);
      s.waiter.timer = setTimeout(() => {
        speeches.delete(id);
        s.waiter.reject(new VoiceUpstreamError('timeout'));
      }, t.ttsFirstMs);
    };

    const onMessage = (msg: UpstreamServerMsg) => {
      switch (msg.t) {
        case 'ready':
          if (ready) return shut('bad_message');
          ready = true;
          sampleRate = msg.sampleRate;
          clearTimeout(connectTimer);
          return resolve(link);
        case 'transcript': {
          const u = utterances.get(msg.id);
          if (u === undefined || u.done) return; // replaced, cancelled or timed out: never awaited (carry 2)
          u.done = true;
          settle(u.waiter);
          return u.waiter.resolve({ text: msg.text });
        }
        case 'audio_end': {
          const s = speeches.get(msg.id);
          if (s === undefined) return;
          speeches.delete(msg.id);
          settle(s.waiter);
          return s.waiter.resolve({ audioMs: msg.audioMs });
        }
        case 'failed': {
          if (msg.kind === 'stt') {
            const u = utterances.get(msg.id);
            if (u === undefined || u.done) return;
            u.done = true;
            settle(u.waiter);
            return u.waiter.reject(new VoiceUpstreamError('stt'));
          }
          const s = speeches.get(msg.id);
          if (s === undefined) return;
          speeches.delete(msg.id);
          settle(s.waiter);
          return s.waiter.reject(new VoiceUpstreamError('tts'));
        }
      }
    };

    ws.on('unexpected-response', (_req, res) => {
      res.resume();
      shut(upstreamRefusal(res.statusCode ?? 0));
    });
    ws.on('error', () => shut('down'));
    ws.on('close', (code: number) => shut(upstreamClose(code)));
    ws.on('open', () => {
      send({ t: 'hello', v: 1 });
    });
    ws.on('message', (data: WebSocket.RawData, binary: boolean) => {
      const bytes = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      if (binary) {
        const frame = decodeFrame(bytes);
        if (frame === null || !ready) return shut('bad_message');
        const s = speeches.get(frame.id);
        if (s === undefined) return; // a replaced or cancelled speech's late audio: dropped
        armSpeech(frame.id);
        return s.onPcm(frame.pcm, sampleRate);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
      } catch {
        return shut('bad_message');
      }
      const msg = parseUpstreamServerMsg(raw);
      if (msg !== null) return onMessage(msg);
      // Core N7: a transcript over MAX_TEXT parses to null. Refused for its id (too_long), never cut, never dropped.
      const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
      if (r !== null && r.t === 'transcript' && typeof r.id === 'number') {
        const u = utterances.get(r.id);
        if (u === undefined || u.done) return;
        u.done = true;
        settle(u.waiter);
        // Fix round 5 (F4-1): the text goes with the refusal for the route's child scan only.
        return u.waiter.reject(new VoiceUpstreamError('too_long', typeof r.text === 'string' ? r.text.slice(0, OVER_CAP_SCAN_UNITS) : undefined));
      }
      shut('bad_message');
    });

    const link: VoiceLink = {
      listen(id, hint) {
        const d = { ...deferred<{ text: string }>(), done: false };
        utterances.set(id, d);
        if (!send({ t: 'listen', id, hint: [...hint] })) {
          utterances.delete(id);
          d.waiter.reject(new VoiceUpstreamError('down'));
        }
      },
      frame(id, pcm) {
        if (!open || ws.readyState !== WebSocket.OPEN || utterances.get(id)?.done !== false) return;
        ws.send(encodeFrame(id, pcm), { binary: true });
      },
      end(id) {
        const u = utterances.get(id);
        if (u === undefined) return Promise.reject(new VoiceUpstreamError(open ? 'cancelled' : 'down'));
        utterances.delete(id);
        if (u.done) return u.promise; // answered already (the service's own length limit, or a failure)
        utterances.set(id, u);
        if (!send({ t: 'end', id })) {
          utterances.delete(id);
          return Promise.reject(new VoiceUpstreamError('down'));
        }
        settle(u.waiter);
        u.waiter.timer = setTimeout(() => {
          utterances.delete(id);
          u.done = true;
          u.waiter.reject(new VoiceUpstreamError('timeout'));
        }, t.sttReplyMs);
        return u.promise.finally(() => utterances.delete(id));
      },
      speak(id, voice, text, onPcm) {
        // D4, the runtime half: only renderSpeak's own SpeakableText is ever sent.
        if (!isSpeakable(text)) throw new TypeError('VoiceLink.speak: not SpeakableText (only renderSpeak makes it)');
        const d = deferred<{ audioMs: number }>();
        speeches.set(id, { waiter: d.waiter, onPcm });
        if (!send({ t: 'speak', id, voice, chunks: text.chunks.map((c) => ({ text: c.text, cache: c.cache })) })) {
          speeches.delete(id);
          d.waiter.reject(new VoiceUpstreamError('down'));
          return d.promise;
        }
        armSpeech(id);
        return d.promise;
      },
      cancel(id) {
        const u = utterances.get(id);
        const s = speeches.get(id);
        if (u === undefined && s === undefined) return;
        send({ t: 'cancel', id });
        const stop = (w: { reject(e: VoiceUpstreamError): void; timer: NodeJS.Timeout | null } | undefined) => {
          if (w === undefined) return;
          settle(w);
          w.reject(new VoiceUpstreamError('cancelled'));
        };
        stop(u?.waiter);
        stop(s?.waiter);
        utterances.delete(id);
        speeches.delete(id);
      },
      close() {
        shut('cancelled');
      },
      isOpen: () => open,
    };
  });
}
