// M7 spec §9: the voice service's WebSocket server, on the private network. Only the API connects, with
// `Authorization: Bearer <VOICE_SERVICE_TOKEN>` compared in constant time. The service knows no user (C-15), keeps
// nothing (C-18) and logs only enums and numbers.
//
// Fix round 1 (review I3): every check runs in the HTTP upgrade handler, before any WebSocket exists. A refused
// request gets a bare HTTP status and its socket is destroyed at once, so it can neither hold a socket nor make the
// server read what it sends. Pending upgrades count against maxConnections.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { VoiceConfig } from './config.js';
import type { SttEngine, TtsEngine } from './engines/types.js';
import type { Logger } from './log.js';
import { Session, SpeechCache } from './session.js';

/** Closes an open session: an error escaped while handling a message (I1). */
const CLOSE_INTERNAL = 1011;
const CLOSE_GOING_AWAY = 1001;
/** A frame is 20 ms of PCM16 (644 bytes); a speak is at most a few KB of JSON. */
const MAX_PAYLOAD = 64 * 1024;
/**
 * Above this many queued bytes the client is not reading: the socket is closed with 1011 and the speech stops (review
 * M2, fix round 2 N4). About 10 s of 24 kHz audio; the API reads as fast as it forwards.
 */
export const MAX_BUFFERED = 512 * 1024;
/** Step 3 binds a private address from the environment; until then, loopback only. */
const HOST = '127.0.0.1';

const digest = (b: Buffer) => createHash('sha256').update(b).digest();

const REFUSE_MS = 500;
const STATUS: Record<number, string> = { 401: 'Unauthorized', 403: 'Forbidden', 503: 'Service Unavailable' };

/**
 * A bare status line, then the socket is destroyed as soon as the line is flushed (at most REFUSE_MS later, for a
 * peer that never reads). Nothing it sent is read: the upgrade socket is never put in flowing mode.
 */
function refuse(socket: Duplex, status: number): void {
  socket.once('finish', () => socket.destroy());
  setTimeout(() => socket.destroy(), REFUSE_MS).unref();
  socket.end(`HTTP/1.1 ${status} ${STATUS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function toBytes(data: RawData): Uint8Array {
  // ws's default binaryType is nodebuffer: it joins fragments itself, so `data` is one Buffer here.
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/** What socketIo needs of a WebSocket. */
interface SendSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array, opts: { binary: boolean }): void;
  close(code: number): void;
}

/**
 * A session's sends over one socket, bounded (N4): once a send leaves more than MAX_BUFFERED queued, the client is not
 * reading, so the socket is closed with 1011 and nothing more is queued. `frame` returns false from then on, which
 * stops the speech.
 */
export function socketIo(ws: SendSocket): { json(msg: object): void; frame(bytes: Uint8Array): boolean; close(code: number): void } {
  let shut = false;
  const after = (): boolean => {
    if (!shut && ws.bufferedAmount > MAX_BUFFERED) {
      shut = true;
      ws.close(CLOSE_INTERNAL);
    }
    return !shut;
  };
  return {
    json: (msg) => {
      if (shut) return;
      ws.send(JSON.stringify(msg), { binary: false });
      after();
    },
    frame: (bytes) => {
      if (shut) return false;
      ws.send(bytes, { binary: true });
      return after();
    },
    close: (code) => {
      if (shut) return;
      shut = true;
      ws.close(code);
    },
  };
}

export function createVoiceServer(opts: { config: VoiceConfig; stt: SttEngine; tts: TtsEngine; log: Logger }): {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
} {
  const { config, stt, tts, log } = opts;
  const expected = digest(config.token);
  const cache = new SpeechCache();
  let open = 0;
  let pending = 0;

  /** Hashing first makes the comparison constant-time whatever the length of the presented token. */
  const authorised = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return timingSafeEqual(digest(Buffer.from(presented, 'utf8')), expected) && presented.length > 0;
  };

  const http = createServer((_req, res) => {
    res.writeHead(426, { connection: 'close' }).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  wss.on('error', () => {});

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {}); // never logged: an error may carry message content
    // Review M3: the API's Node client sends no Origin; one that does is a browser.
    if (req.headers.origin !== undefined) {
      log('auth_fail', { origin: true });
      return refuse(socket, 403);
    }
    if (!authorised(req)) {
      log('auth_fail');
      return refuse(socket, 401);
    }
    if (open + pending >= config.maxConnections) {
      log('conn_close', { code: 503, refused: true });
      return refuse(socket, 503);
    }
    pending++;
    let settled = false;
    const settle = () => {
      if (!settled) pending--;
      settled = true;
    };
    socket.once('close', settle);
    wss.handleUpgrade(req, socket, head, (ws) => {
      settle();
      accept(ws);
    });
  });

  function accept(ws: WebSocket): void {
    ws.on('error', () => {});
    open++;
    log('conn_open', { open });
    const session = new Session({
      stt,
      tts,
      cast: config.cast,
      cache,
      log,
      io: socketIo(ws),
    });
    ws.on('message', (data: RawData, binary: boolean) => {
      try {
        const bytes = toBytes(data);
        session.receive(binary ? bytes : Buffer.from(bytes).toString('utf8'), binary);
      } catch {
        // Fix round 1 (I1): the error is never read; it fails this session only.
        log('fatal');
        session.close();
        ws.close(CLOSE_INTERNAL);
      }
    });
    ws.once('close', (code: number) => {
      session.close();
      open--;
      log('conn_close', { code, open });
    });
  }

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, HOST, () => resolve((http.address() as AddressInfo).port));
      }),
    close: async () => {
      for (const ws of wss.clients) ws.close(CLOSE_GOING_AWAY);
      const done = new Promise<void>((resolve) => http.close(() => resolve()));
      const force = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        http.closeAllConnections();
      }, 1000);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await done;
      clearTimeout(force);
    },
  };
}

