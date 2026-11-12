// Shared test helpers: a config with no environment, and a plain `ws` client that queues what the server sends.
import { decodeFrame, parseUpstreamServerMsg, type UpstreamServerMsg } from '@kitchenquest/core';
import WebSocket from 'ws';
import type { VoiceConfig } from '../src/config';

export const TEST_TOKEN = 'test-token-0123456789-0123456789-abcdef';

export function testConfig(over: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    production: false,
    port: 0,
    token: Buffer.from(TEST_TOKEN),
    engine: 'fake',
    sttModel: 'faster-whisper-base.en',
    cast: { model: 'piper-en_GB-northern_english_male-medium', voice: 'northern_english_male' },
    maxConnections: 4,
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
export function connect(port: number, authorization: string | null = `Bearer ${TEST_TOKEN}`): Promise<Client> {
  const headers: Record<string, string> = authorization === null ? {} : { authorization };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers });
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
