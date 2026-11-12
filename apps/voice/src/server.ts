// M7 spec §9: the voice service's WebSocket server, on the private network. Only the API connects, with
// `Authorization: Bearer <VOICE_SERVICE_TOKEN>` compared in constant time. The service knows no user (C-15), keeps
// nothing (C-18) and logs only enums and numbers.
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { VoiceConfig } from './config.js';
import type { SttEngine, TtsEngine } from './engines/types.js';
import type { Logger } from './log.js';
import { Session, SpeechCache } from './session.js';

/** The WebSocket close codes this service uses. */
const CLOSE_AUTH = 4401;
const CLOSE_FULL = 1013; // try again later
const CLOSE_GOING_AWAY = 1001;
/** A frame is 20 ms of PCM16 (644 bytes); a speak is at most a few KB of JSON. */
const MAX_PAYLOAD = 64 * 1024;
/** Step 3 binds a private address from the environment; until then, loopback only. */
const HOST = '127.0.0.1';

const digest = (b: Buffer) => createHash('sha256').update(b).digest();

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

export function createVoiceServer(opts: { config: VoiceConfig; stt: SttEngine; tts: TtsEngine; log: Logger }): {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
} {
  const { config, stt, tts, log } = opts;
  const expected = digest(config.token);
  const cache = new SpeechCache();
  let open = 0;

  /** Hashing first makes the comparison constant-time whatever the length of the presented token. */
  const authorised = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    return timingSafeEqual(digest(Buffer.from(presented, 'utf8')), expected) && presented.length > 0;
  };

  const http = createServer((_req, res) => {
    res.writeHead(426, { connection: 'close' }).end();
  });
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  wss.on('error', () => {});

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    ws.on('error', () => {}); // never logged: an error may carry message content
    if (!authorised(req)) {
      log('auth_fail');
      ws.close(CLOSE_AUTH);
      return;
    }
    if (open >= config.maxConnections) {
      log('conn_close', { code: CLOSE_FULL, refused: true });
      ws.close(CLOSE_FULL);
      return;
    }
    open++;
    log('conn_open', { open });
    const session = new Session({
      stt,
      tts,
      cast: config.cast,
      cache,
      log,
      io: {
        json: (msg) => ws.send(JSON.stringify(msg)),
        frame: (bytes) => ws.send(bytes, { binary: true }),
        close: (code) => ws.close(code),
      },
    });
    ws.on('message', (data: RawData, binary: boolean) => {
      const bytes = toBytes(data);
      session.receive(binary ? bytes : Buffer.from(bytes).toString('utf8'), binary);
    });
    ws.once('close', (code: number) => {
      session.close();
      open--;
      log('conn_close', { code, open });
    });
  });

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
