// M7 P1 (carries 1–3): the API's wsUpstream against a plain `ws` server in the test that replays core's shared session
// fixture (packages/core/test/fixtures/voice-upstream-session.json, which apps/voice's integration test replays too).
// Then: GET /ready fails fast, the close codes and refusals are mapped, replies are matched by id, each id has its
// own reply timeout, and an over-long transcript is refused, never cut.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeFrame, encodeFrame, MAX_TEXT, parseUpstreamClientMsg, UPSTREAM_CLOSE, type UpstreamClientMsg } from '@kitchenquest/core';
import { afterEach, describe, expect, test } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import session from '../../../packages/core/test/fixtures/voice-upstream-session.json';
import { defaultCatalog } from '../src/catalog.js';
import { loadPanBank } from '../src/mentor/lines.js';
import { renderSpeak, type SpeakableText } from '../src/voice/speak.js';
import { VoiceUpstreamError, wsUpstream, type UpstreamFailure, type VoiceLink } from '../src/voice/upstream.js';

type Entry = { from: 'api' | 'service'; msg?: unknown; frame?: { id: number; samples: number } };
const entries = session.messages as Entry[];
const TOKEN = Buffer.from('t'.repeat(32));
const bank = loadPanBank();
const catalog = defaultCatalog();

/** What the API side sent, as the fixture writes it. */
type Seen = { msg: unknown } | { frame: { id: number; samples: number } };

interface FakeService {
  url: URL;
  seen: Seen[];
  auth: (string | undefined)[];
  origins: (string | undefined)[];
  sockets: WebSocket[];
  setReady(status: number): void;
  close(): Promise<void>;
}

const servers: FakeService[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/**
 * A stand-in service: GET /ready answers `ready` (200 by default), the upgrade is refused with `refuse` when set, and
 * each connection runs `script(ws, next)`, where `next()` resolves with the next thing the API sent.
 */
async function service(script: (ws: WebSocket, next: () => Promise<Seen>) => Promise<void>, opts: { refuse?: number } = {}): Promise<FakeService> {
  let ready = 200;
  const seen: Seen[] = [];
  const auth: (string | undefined)[] = [];
  const origins: (string | undefined)[] = [];
  const sockets: WebSocket[] = [];
  const http: Server = createServer((req, res) => {
    if (req.url === '/ready') res.writeHead(ready).end();
    else res.writeHead(426).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    auth.push(req.headers.authorization);
    origins.push(req.headers.origin);
    if (opts.refuse !== undefined) {
      socket.end(`HTTP/1.1 ${opts.refuse} No\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      const queue: Seen[] = [];
      const waiting: ((s: Seen) => void)[] = [];
      ws.on('message', (data: Buffer, binary: boolean) => {
        const item: Seen = binary
          ? (() => {
              const f = decodeFrame(new Uint8Array(data));
              return { frame: { id: f!.id, samples: f!.pcm.length } };
            })()
          : { msg: JSON.parse(data.toString('utf8')) as unknown };
        seen.push(item);
        const w = waiting.shift();
        if (w) w(item);
        else queue.push(item);
      });
      const next = () => new Promise<Seen>((r) => (queue.length > 0 ? r(queue.shift()!) : waiting.push(r)));
      void script(ws, next).catch(() => ws.terminate());
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const s: FakeService = {
    url: new URL(`ws://127.0.0.1:${port}`),
    seen,
    auth,
    origins,
    sockets,
    setReady: (status) => (ready = status),
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      http.closeAllConnections();
      await new Promise<void>((r) => http.close(() => r()));
    },
  };
  servers.push(s);
  return s;
}

const send = (ws: WebSocket, msg: object) => ws.send(JSON.stringify(msg));
const sendFrame = (ws: WebSocket, id: number, samples: number) => ws.send(encodeFrame(id, new Int16Array(samples)), { binary: true });
/** Answers hello with the fixture's ready. */
async function handshake(ws: WebSocket, next: () => Promise<Seen>): Promise<void> {
  await next();
  send(ws, entries[1].msg as object);
}
const kindOf = async (p: Promise<unknown>): Promise<UpstreamFailure | 'resolved'> => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return (e as VoiceUpstreamError).kind;
  }
};
const openLink = (s: FakeService, timing = {}) => wsUpstream(s.url, TOKEN, timing).open(new AbortController().signal);

async function speakable(items: Parameters<typeof renderSpeak>[0], transcripts: Record<number, string> = {}): Promise<SpeakableText> {
  return renderSpeak(items, {
    userId: 'u',
    bank,
    catalog,
    lastTranscript: (id) => transcripts[id] ?? null,
    card: () => Promise.resolve(null),
    stepOk: () => Promise.resolve(true),
    recipes: new Map(),
  });
}

describe('wsUpstream (P1)', () => {
  test("wsUpstream sends exactly the fixture's client messages and parses every server reply", async () => {
    // The service side of the fixture: wait for each API entry, send each service entry, in order.
    const svc = await service(async (ws, next) => {
      for (const e of entries) {
        if (e.from === 'api') await next();
        else if (e.msg) send(ws, e.msg as object);
        else sendFrame(ws, e.frame!.id, e.frame!.samples);
      }
    });
    const link = await openLink(svc);
    const listen1 = entries[2].msg as Extract<UpstreamClientMsg, { t: 'listen' }>;
    link.listen(1, listen1.hint);
    link.frame(1, new Int16Array(320));
    link.frame(1, new Int16Array(320));
    expect(await link.end(1)).toEqual({ text: "I can't eat sesame" });

    const pcm: { samples: number; rate: number }[] = [];
    const heard = await speakable([{ kind: 'heard', utteranceId: 1 }], { 1: "I can't eat sesame" });
    expect(await link.speak(2, 'pan', heard, (p, rate) => pcm.push({ samples: p.length, rate }))).toEqual({ audioMs: 40 });
    expect(pcm).toEqual([
      { samples: 441, rate: 22050 },
      { samples: 441, rate: 22050 },
    ]);

    link.listen(3, []);
    link.frame(3, new Int16Array(320));
    link.cancel(3);
    const check = await speakable([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }]);
    expect(await kindOf(link.speak(4, 'pan', check, () => {}))).toBe('tts');
    link.listen(5, ['peanut']);
    expect(await kindOf(link.end(5))).toBe('stt');

    const expected: Seen[] = entries.filter((e) => e.from === 'api').map((e) => (e.msg ? { msg: e.msg } : { frame: e.frame! }));
    expect(svc.seen).toEqual(expected);
    // Every message the API sent parses with core's strict parser.
    for (const s of svc.seen) if ('msg' in s) expect(parseUpstreamClientMsg(s.msg), JSON.stringify(s.msg)).toEqual(s.msg);
    // The bearer token, and no Origin (the service refuses a browser).
    expect(svc.auth).toEqual([`Bearer ${TOKEN.toString('utf8')}`]);
    expect(svc.origins).toEqual([undefined]);
    link.close();
    expect(link.isOpen()).toBe(false);
  });

  test('D4, the runtime half: VoiceLink.speak refuses anything renderSpeak did not make, and sends nothing', async () => {
    const svc = await service(handshake);
    const link = await openLink(svc);
    const plain = { chunks: [{ text: 'whatever the client likes', cache: false }] } as unknown as SpeakableText;
    expect(() => link.speak(1, 'pan', plain, () => {})).toThrow(TypeError);
    const copy = { ...(await speakable([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }])) } as SpeakableText;
    expect(() => link.speak(2, 'pan', copy, () => {})).toThrow(TypeError);
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.seen).toEqual([{ msg: { t: 'hello', v: 1 } }]);
    link.close();
  });
});

describe('readiness and the close codes (carries 1 and 3)', () => {
  test('GET /ready 503 fails fast with not_ready and opens no socket; 200 again and it opens', async () => {
    const svc = await service(handshake);
    svc.setReady(503);
    const started = Date.now();
    expect(await kindOf(openLink(svc))).toBe('not_ready');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(svc.auth).toEqual([]);
    svc.setReady(200);
    const link = await openLink(svc);
    expect(link.isOpen()).toBe(true);
    link.close();
  });

  test('a refused upgrade maps by status: 401 and 403 → auth, 503 → busy, 426 → misrouted; nothing listening → down', async () => {
    for (const [status, kind] of [
      [401, 'auth'],
      [403, 'auth'],
      [503, 'busy'],
      [426, 'misrouted'],
    ] as const) {
      const svc = await service(handshake, { refuse: status });
      expect(await kindOf(openLink(svc)), String(status)).toBe(kind);
    }
    const gone = await service(handshake);
    const url = gone.url;
    await gone.close();
    servers.splice(servers.indexOf(gone), 1);
    expect(await kindOf(wsUpstream(url, TOKEN).open(new AbortController().signal))).toBe('down');
  });

  test('a close by the service rejects what is in flight by its code: 4408 → idle, 4400 → bad_message, 1011 and 1001 → down; the link reads closed', async () => {
    for (const [code, kind] of [
      [UPSTREAM_CLOSE.idle, 'idle'],
      [UPSTREAM_CLOSE.badMessage, 'bad_message'],
      [UPSTREAM_CLOSE.internal, 'down'],
      [UPSTREAM_CLOSE.goingAway, 'down'],
    ] as const) {
      const svc = await service(async (ws, next) => {
        await handshake(ws, next);
        await next(); // listen
        await next(); // end
        ws.close(code);
      });
      const link = await openLink(svc);
      link.listen(1, []);
      expect(await kindOf(link.end(1)), String(code)).toBe(kind);
      expect(link.isOpen()).toBe(false);
    }
  });
});

describe('replies by id (carries 2 and 3)', () => {
  test('a reply for an id no longer awaited is dropped: a cancelled utterance\'s late transcript never answers the next one', async () => {
    const svc = await service(async (ws, next) => {
      await handshake(ws, next);
      await next(); // listen 1
      await next(); // end 1
      await next(); // cancel 1
      await next(); // listen 2
      await next(); // end 2
      // The service answers late, out of order: the cancelled utterance first.
      send(ws, { t: 'transcript', id: 1, text: 'the old words' });
      send(ws, { t: 'failed', id: 1, kind: 'stt' });
      send(ws, { t: 'transcript', id: 2, text: 'the new words' });
    });
    const link: VoiceLink = await openLink(svc);
    link.listen(1, []);
    const first = link.end(1);
    link.cancel(1);
    expect(await kindOf(first)).toBe('cancelled');
    link.listen(2, []);
    expect(await link.end(2)).toEqual({ text: 'the new words' });
    link.close();
  });

  test('a transcript that comes before end (the service\'s own MAX_UTTERANCE_MS stop) is kept for end; frames for an answered id are not sent', async () => {
    const svc = await service(async (ws, next) => {
      await handshake(ws, next);
      await next(); // listen
      await next(); // frame
      send(ws, { t: 'transcript', id: 7, text: 'all of it' });
    });
    const link = await openLink(svc);
    link.listen(7, []);
    link.frame(7, new Int16Array(320));
    await new Promise((r) => setTimeout(r, 50));
    link.frame(7, new Int16Array(320));
    expect(await link.end(7)).toEqual({ text: 'all of it' });
    await new Promise((r) => setTimeout(r, 30));
    expect(svc.seen.filter((s) => 'frame' in s)).toHaveLength(1);
    link.close();
  });

  test('each id has its own reply timeout (STT after end, TTS to the first message), and the link stays usable', async () => {
    const svc = await service(async (ws, next) => {
      await handshake(ws, next);
      for (;;) {
        const s = await next();
        const m = 'msg' in s ? (s.msg as { t: string; id: number }) : null;
        if (m?.t === 'end' && m.id === 2) send(ws, { t: 'transcript', id: 2, text: 'answered' });
      }
    });
    const link = await openLink(svc, { sttReplyMs: 60, ttsFirstMs: 60 });
    link.listen(1, []);
    expect(await kindOf(link.end(1))).toBe('timeout');
    const check = await speakable([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }]);
    expect(await kindOf(link.speak(9, 'pan', check, () => {}))).toBe('timeout');
    link.listen(2, []);
    expect(await link.end(2)).toEqual({ text: 'answered' });
    expect(link.isOpen()).toBe(true);
    link.close();
  });

  test('the defaults: at least 20 s for a transcript and 30 s for the first TTS message (the service\'s own STT deadline is 20 s)', async () => {
    const { UPSTREAM_TIMING } = await import('../src/voice/upstream.js');
    expect(UPSTREAM_TIMING.sttReplyMs).toBeGreaterThanOrEqual(20_000);
    expect(UPSTREAM_TIMING.ttsFirstMs).toBeGreaterThanOrEqual(30_000);
  });

  test('core N7: a transcript over MAX_TEXT is refused for its id (too_long), never cut and never dropped', async () => {
    const svc = await service(async (ws, next) => {
      await handshake(ws, next);
      await next();
      await next();
      send(ws, { t: 'transcript', id: 3, text: 'a'.repeat(MAX_TEXT + 1) });
    });
    const link = await openLink(svc);
    link.listen(3, []);
    expect(await kindOf(link.end(3))).toBe('too_long');
    expect(link.isOpen()).toBe(true);
    link.close();
  });
});
