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
import { UPSTREAM_CLOSE, UPSTREAM_REFUSAL } from '@kitchenquest/core';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { VoiceConfig } from './config.js';
import type { SttEngine, TtsEngine } from './engines/types.js';
import type { Logger } from './log.js';
import { Session, SpeechCache } from './session.js';

/** Closes an open session: an error escaped while handling a message (I1). */
// The codes are core's (Step 5, carry 1), so the API maps the same numbers.
const CLOSE_INTERNAL = UPSTREAM_CLOSE.internal;
const CLOSE_GOING_AWAY = UPSTREAM_CLOSE.goingAway;
/** A frame is 20 ms of PCM16 (644 bytes); a speak is at most a few KB of JSON. */
const MAX_PAYLOAD = 64 * 1024;
/**
 * Above this many queued bytes the client is not reading: the socket is closed with 1011 and the speech stops (review
 * M2, fix round 2 N4). About 10 s of 24 kHz audio; the API reads as fast as it forwards.
 */
export const MAX_BUFFERED = 512 * 1024;
/**
 * After a congested close, the socket is terminated this long later (fix round 3, F2): its 1011 close frame is queued
 * behind data the peer is not reading, so waiting for ws's 30 s closeTimeout would keep it, and its buffers, alive.
 */
export const CONGESTED_GRACE_MS = 1000;
/**
 * Step 3 (N3): a request must finish its headers within HEADERS_TIMEOUT_MS and its whole request within
 * REQUEST_TIMEOUT_MS, checked every CHECK_INTERVAL_MS, so a client trickling its headers cannot hold a socket. At most
 * MAX_PRE_UPGRADE sockets may wait before their upgrade (or refusal); one more is destroyed unread. The API is the only
 * client and opens at most maxConnections.
 */
export const HEADERS_TIMEOUT_MS = 2000;
export const REQUEST_TIMEOUT_MS = 3000;
const CHECK_INTERVAL_MS = 250;
export const MAX_PRE_UPGRADE = 64;
const MAX_HEADER_BYTES = 8 * 1024;
/**
 * Review M2 (Step 3): an authenticated socket must say `hello` within HELLO_TIMEOUT_MS, and is closed with
 * CLOSE_IDLE after IDLE_TIMEOUT_MS with no message either way. A hands-free cook may be quiet for HANDS_FREE_IDLE_MS
 * (core) before hands-free turns itself off, so the idle limit is longer than that; the API reconnects when it needs to.
 */
const HELLO_TIMEOUT_MS = 5000;
export const IDLE_TIMEOUT_MS = 11 * 60_000;
const CLOSE_IDLE = UPSTREAM_CLOSE.idle;

const digest = (b: Buffer) => createHash('sha256').update(b).digest();

const REFUSE_MS = 500;
const STATUS: Record<number, string> = {
  [UPSTREAM_REFUSAL.unauthorized]: 'Unauthorized',
  [UPSTREAM_REFUSAL.origin]: 'Forbidden',
  [UPSTREAM_REFUSAL.busy]: 'Service Unavailable',
};

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
  terminate(): void;
}

/**
 * A session's sends over one socket, bounded (N4): once a send leaves more than MAX_BUFFERED queued, the client is not
 * reading. The socket is then closed with 1011, `onShut` ends the session at once so no more engine work runs (F2),
 * and the socket is terminated after CONGESTED_GRACE_MS. Nothing more is queued; `frame` returns false from then on.
 */
export function socketIo(
  ws: SendSocket,
  onShut: () => void = () => {},
): { json(msg: object): void; frame(bytes: Uint8Array): boolean; close(code: number): void } {
  let shut = false;
  const after = (): boolean => {
    if (!shut && ws.bufferedAmount > MAX_BUFFERED) {
      shut = true;
      ws.close(CLOSE_INTERNAL);
      setTimeout(() => ws.terminate(), CONGESTED_GRACE_MS).unref();
      onShut();
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

export interface ServerLimits {
  /** Sockets waiting before their upgrade (default MAX_PRE_UPGRADE). */
  preUpgrade?: number;
  helloMs?: number;
  idleMs?: number;
}

export function createVoiceServer(opts: {
  config: VoiceConfig;
  stt: SttEngine;
  tts: TtsEngine;
  log: Logger;
  limits?: ServerLimits;
  /** Fix round 1 (I2): GET /ready answers 200 while this holds (every worker pool has a ready worker), else 503. */
  health?: () => boolean;
}): {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
} {
  const { config, stt, tts, log } = opts;
  const maxPreUpgrade = opts.limits?.preUpgrade ?? MAX_PRE_UPGRADE;
  const helloMs = opts.limits?.helloMs ?? HELLO_TIMEOUT_MS;
  const idleMs = opts.limits?.idleMs ?? IDLE_TIMEOUT_MS;
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

  const http = createServer(
    { headersTimeout: HEADERS_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS, connectionsCheckingInterval: CHECK_INTERVAL_MS, maxHeaderSize: MAX_HEADER_BYTES },
    (req, res) => {
      // Readiness, for a systemd or load-balancer check and the API (I2): a status only, no body, no auth, no log.
      if (req.method === 'GET' && req.url === '/ready') {
        res.writeHead((opts.health ?? (() => true))() ? 200 : 503, { connection: 'close', 'content-length': '0' }).end();
        return;
      }
      res.writeHead(UPSTREAM_REFUSAL.notWebSocket, { connection: 'close' }).end();
    },
  );
  // N3: count sockets until their upgrade request arrives (or they close); one over the cap is destroyed unread.
  let preUpgrade = 0;
  const waiting = new WeakSet<Duplex>();
  const leaveWaiting = (socket: Duplex) => {
    if (waiting.delete(socket)) preUpgrade--;
  };
  http.on('connection', (socket: Duplex) => {
    socket.on('error', () => {});
    if (preUpgrade >= maxPreUpgrade) {
      socket.destroy();
      return;
    }
    preUpgrade++;
    waiting.add(socket);
    socket.once('close', () => leaveWaiting(socket));
  });
  http.on('request', (req: IncomingMessage) => leaveWaiting(req.socket));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  wss.on('error', () => {});

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    leaveWaiting(socket);
    socket.on('error', () => {}); // never logged: an error may carry message content
    // Review M3: the API's Node client sends no Origin; one that does is a browser.
    if (req.headers.origin !== undefined) {
      log('auth_fail', { origin: true });
      return refuse(socket, UPSTREAM_REFUSAL.origin);
    }
    if (!authorised(req)) {
      log('auth_fail');
      return refuse(socket, UPSTREAM_REFUSAL.unauthorized);
    }
    if (open + pending >= config.maxConnections) {
      log('conn_close', { code: UPSTREAM_REFUSAL.busy, refused: true });
      return refuse(socket, UPSTREAM_REFUSAL.busy);
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
    // Review M2 (Step 3): no first message within helloMs, then no message either way for idleMs, closes the socket
    // with 4408. (A first message that is not a hello is refused by the session anyway.)
    const shut = () => ws.close(CLOSE_IDLE);
    let timer = setTimeout(shut, helloMs).unref();
    let helloed = false;
    const active = () => {
      if (helloed) timer.refresh();
    };
    const io = socketIo(ws, () => session.close());
    // The session is ended at once if the socket congests (F2); the callback runs only after `session` exists.
    const session: Session = new Session({
      stt,
      tts,
      cast: config.cast,
      cache,
      log,
      io: {
        json: (msg) => {
          active();
          io.json(msg);
        },
        frame: (bytes) => {
          active();
          return io.frame(bytes);
        },
        close: (code) => io.close(code),
      },
    });
    ws.on('message', (data: RawData, binary: boolean) => {
      if (!helloed) {
        helloed = true;
        clearTimeout(timer);
        timer = setTimeout(shut, idleMs).unref();
      } else active();
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
      clearTimeout(timer);
      session.close();
      open--;
      log('conn_close', { code, open });
    });
  }

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, config.host, () => resolve((http.address() as AddressInfo).port));
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

