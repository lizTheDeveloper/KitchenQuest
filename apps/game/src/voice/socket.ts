// M7 Step 8: the voice socket, `/api/voice` on the game's own origin (the API's `GET /voice`). Core's protocol on the
// wire, strictly: anything the parser refuses closes the socket with `bad_message`. Audio frames pass straight through
// in memory; nothing here keeps, logs or copies one (C-18).
import {
  decodeFrame,
  encodeFrame,
  parseServerMsg,
  VOICE_CLOSE_CODES,
  voiceCloseReason,
  type ClientMsg,
  type ServerMsg,
  type VoiceCloseReason,
  type VoiceState,
} from '@kitchenquest/core/engine';

export interface VoiceSocket {
  send(m: ClientMsg): void;
  frame(id: number, pcm: Int16Array): void;
  on(fn: (m: ServerMsg) => void): () => void;
  onAudio(fn: (id: number, pcm: Int16Array) => void): () => void;
  close(): void;
  /** Why it closed: the server's `closed` reason or close code; `network` for anything else (the device's own close too). */
  readonly closed: Promise<VoiceCloseReason | 'network'>;
  /** The allowance state `ready` carried. */
  readonly state: VoiceState;
}

/** The socket closed before `ready`: the reason it gave (e.g. `consent_required`, `family_table`), or `network`. */
export class VoiceSocketClosed extends Error {
  constructor(readonly reason: VoiceCloseReason | 'network') {
    super(`voice socket closed: ${reason}`);
    this.name = 'VoiceSocketClosed';
  }
}

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** How long `hello` may wait for `ready`. */
export const HELLO_TIMEOUT_MS = 10_000;

/** Opens the socket, sends `hello` first, and resolves once the API answers `ready`. */
export function openVoiceSocket(win: Window, hello: Extract<ClientMsg, { t: 'hello' }>): Promise<VoiceSocket> {
  const scheme = win.location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new (win as Window & { WebSocket: typeof WebSocket }).WebSocket(`${scheme}://${win.location.host}/api/voice`);
  ws.binaryType = 'arraybuffer';
  const listeners = new Set<(m: ServerMsg) => void>();
  const audio = new Set<(id: number, pcm: Int16Array) => void>();
  let reason: VoiceCloseReason | null = null;
  let done = false;
  let finish!: (r: VoiceCloseReason | 'network') => void;
  const closed = new Promise<VoiceCloseReason | 'network'>((resolve) => { finish = resolve; });
  let ready: ((s: VoiceState) => void) | null = null;
  let refused: ((e: VoiceSocketClosed) => void) | null = null;

  const end = (r: VoiceCloseReason | 'network') => {
    if (done) return;
    done = true;
    win.clearTimeout(timer);
    listeners.clear();
    audio.clear();
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    if (ws.readyState !== CLOSING && ws.readyState !== CLOSED) {
      try { ws.close(r === 'bad_message' ? VOICE_CLOSE_CODES.bad_message : 1000); } catch { /* already closing */ }
    }
    refused?.(new VoiceSocketClosed(r));
    finish(r);
  };
  const timer = win.setTimeout(() => end('network'), HELLO_TIMEOUT_MS);

  ws.onopen = () => { ws.send(JSON.stringify(hello)); };
  ws.onerror = () => undefined; // the close that follows says why
  ws.onclose = (e: CloseEvent) => end(reason ?? voiceCloseReason(e.code) ?? 'network');
  ws.onmessage = (e: MessageEvent) => {
    if (done) return;
    if (typeof e.data !== 'string') {
      const f = e.data instanceof ArrayBuffer ? decodeFrame(new Uint8Array(e.data)) : null;
      if (f === null || ready !== null) return end('bad_message');
      for (const fn of audio) fn(f.id, f.pcm);
      return;
    }
    let msg: ServerMsg | null = null;
    try { msg = parseServerMsg(JSON.parse(e.data)); } catch { msg = null; }
    if (msg === null) return end('bad_message');
    if (msg.t === 'closed') { reason = msg.reason; return; } // the close itself follows
    if (ready !== null) {
      if (msg.t !== 'ready') return end('bad_message');
      win.clearTimeout(timer);
      const r = ready;
      ready = refused = null;
      return r(msg.state);
    }
    if (msg.t === 'ready') return end('bad_message'); // twice
    for (const fn of listeners) fn(msg);
  };

  const send = (data: string | Uint8Array<ArrayBuffer>) => {
    if (!done && ws.readyState === OPEN) ws.send(data);
  };
  return new Promise<VoiceSocket>((resolve, reject) => {
    refused = reject;
    ready = (state) => resolve({
      state,
      closed,
      send: (m) => send(JSON.stringify(m)),
      frame: (id, pcm) => send(encodeFrame(id, pcm) as Uint8Array<ArrayBuffer>),
      on: (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      onAudio: (fn) => { audio.add(fn); return () => { audio.delete(fn); }; },
      close: () => end('network'),
    });
  });
}
