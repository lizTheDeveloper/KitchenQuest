// Shared test helpers: a config with no environment, and a plain `ws` client that queues what the server sends.
import { decodeFrame, parseUpstreamServerMsg, type UpstreamServerMsg } from '@kitchenquest/core';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import WebSocket from 'ws';
import type { VoiceConfig } from '../src/config';

export const TEST_TOKEN = 'test-token-0123456789-0123456789-abcdef';

/**
 * VOICE_PORT refuses 0.
 *
 * A port a child process can bind a moment later. M7 Step 11 (the parallel-load flake, root cause): a port from
 * `listen(0)` is in the kernel's ephemeral range, which every outgoing connection on the machine also draws from (the
 * API suite's database and HTTP clients, run alongside, make thousands). Between our close and the child's bind, one of
 * them could take it, and the child failed to start or the probe reached the wrong socket. So the port is picked below
 * the ephemeral range (Linux: /proc/sys/net/ipv4/ip_local_port_range), where nothing is handed out automatically, and
 * checked free by binding it here first.
 */
export async function freePort(): Promise<number> {
  const low = ephemeralLow();
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * (low - 20_000));
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return port;
  }
}

function ephemeralLow(): number {
  try {
    const low = Number(readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/)[0]);
    if (Number.isInteger(low) && low > 21_000) return low;
  } catch {
    // not Linux: IANA's dynamic range starts at 49152
  }
  return 32_768;
}

export function testConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    production: false,
    port: 0,
    token: Buffer.from(TEST_TOKEN),
    engine: 'fake',
    sttModel: 'faster-whisper-base.en',
    cast: { model: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male' },
    maxConnections: 4,
    host: '127.0.0.1',
    workerEngine: 'echo',
    modelsDir: '/nonexistent/kq-voice-models',
    python: 'python3',
    workers: 1,
    acceptLatencyMiss: undefined,
    ...over,
  };
}

type Received = { kind: 'msg'; msg: UpstreamServerMsg; raw: unknown } | { kind: 'frame'; id: number; pcm: Int16Array };

export interface Client {
  ws: WebSocket;
  /** Everything received, in order. */
  received: Received[];
  /** The next item received after `from` (an index into `received`), waiting for it. */
  next(timeoutMs?: number): Promise<Received>;
  /** The close code, once closed. */
  closed: Promise<number>;
  send(x: object | Uint8Array): void;
}

/** `authorization` is the whole header value; null sends none. */
export function connect(port: number, authorization: string | null = `Bearer ${TEST_TOKEN}`, host = '127.0.0.1'): Promise<Client> {
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  const ws = new WebSocket(`ws://${host}:${port}/`, { headers });
  const received: Received[] = [];
  let cursor = 0;
  const waiters: (() => void)[] = [];
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (binary) {
      const f = decodeFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      if (f) received.push({ kind: 'frame', id: f.id, pcm: f.pcm });
    } else {
      const raw = JSON.parse(data.toString('utf8')) as unknown;
      const msg = parseUpstreamServerMsg(raw);
      if (msg === null) throw new Error('the server sent a message parseUpstreamServerMsg refuses');
      received.push({ kind: 'msg', msg, raw });
    }
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const client: Client = {
    ws,
    received,
    closed,
    send: (x) => ws.send(x instanceof Uint8Array ? x : JSON.stringify(x)),
    next: async (timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      while (cursor >= received.length) {
        if (Date.now() > deadline) throw new Error('next: nothing received in time');
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 20);
        });
      }
      return received[cursor++];
    },
  };
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(client));
    ws.once('error', reject);
    // A socket the server closes straight after the upgrade still opens first; a refused upgrade errors.
  });
}

/**
 * The HTTP status a raw WebSocket upgrade request gets: 101 when upgraded (the socket is then dropped), otherwise the
 * refusal's status.
 */
export function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/',
      headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    });
    req.once('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.once('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once('error', reject);
    req.end();
  });
}
