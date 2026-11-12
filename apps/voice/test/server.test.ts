// M7 Step 2: the WebSocket server. Only the API may connect (a shared bearer token, compared in constant time); the
// service knows no user and logs only enums and numbers.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect as netConnect, type Socket } from 'node:net';
import { encodeFrame, HANDS_FREE_IDLE_MS } from '@kitchenquest/core';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { boot } from '../src/boot';
import { fakeStt, fakeTts } from '../src/engines/fake';
import type { LogKind } from '../src/log';
import { CONGESTED_GRACE_MS, createVoiceServer, HEADERS_TIMEOUT_MS, IDLE_TIMEOUT_MS, MAX_BUFFERED, MAX_PRE_UPGRADE, REQUEST_TIMEOUT_MS, socketIo } from '../src/server';
import { connect, freePort, testConfig, TEST_TOKEN, upgradeStatus } from './helpers';

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(maxConnections = 2) {
  const logs: [LogKind, Record<string, number | boolean> | undefined][] = [];
  const server = createVoiceServer({
    config: testConfig({ maxConnections }),
    stt: fakeStt(() => 'hello'),
    tts: fakeTts(),
    log: (kind, fields) => logs.push([kind, fields]),
    // The I3 probes open 300 sockets at once to test the upgrade handler itself; the default pre-upgrade cap
    // (MAX_PRE_UPGRADE, Step 3) would cut most of them before their headers, which its own test covers.
    limits: { preUpgrade: 1000 },
  });
  servers.push(server);
  const port = await server.listen(0);
  return { server, port, logs };
}

describe('createVoiceServer', () => {
  test('no Authorization: Bearer <token> → refused with HTTP 401 before the upgrade, logged as auth_fail only; bad JSON → bad_message; maxConnections+1 refused with 503', async () => {
    const { port, logs } = await start(2);
    const headers = [
      null,
      'Bearer wrong',
      `Bearer ${TEST_TOKEN.slice(0, -1)}`,
      `Bearer ${TEST_TOKEN}x`,
      'Bearer ',
      `Basic ${Buffer.from(`api:${TEST_TOKEN}`).toString('base64')}`, // the right secret under another scheme
    ];
    // Fix round 1 (I3): authentication happens in the HTTP upgrade handler; no WebSocket ever exists for these.
    for (const h of headers) expect(await upgradeStatus(port, h === null ? {} : { authorization: h }), String(h)).toBe(401);
    await expect(connect(port, 'Bearer wrong')).rejects.toThrow(/401/);
    expect(logs.map(([k]) => k)).toEqual(Array(7).fill('auth_fail'));
    expect(logs.every(([, f]) => f === undefined)).toBe(true);
    // M3: any Origin header (a browser) is refused, even with the right token.
    logs.length = 0;
    expect(await upgradeStatus(port, { authorization: `Bearer ${TEST_TOKEN}`, origin: 'http://localhost:5173' })).toBe(403);
    expect(logs).toEqual([['auth_fail', { origin: true }]]);
    expect(await upgradeStatus(port, { authorization: `Bearer ${TEST_TOKEN}` })).toBe(101);
    await new Promise((r) => setTimeout(r, 20));

    logs.length = 0;
    const a = await connect(port);
    a.send({ t: 'hello', v: 1 });
    expect(await a.next()).toMatchObject({ kind: 'msg', msg: { t: 'ready', stt: 'fake-stt', tts: 'fake-tts', sampleRate: 22_050 } });
    a.ws.send('{not json');
    expect(await a.closed).toBe(4400);
    await new Promise((r) => setTimeout(r, 20));
    expect(logs.map(([k]) => k)).toEqual(['conn_open', 'bad_message', 'conn_close']);

    // An unknown message shape and an undecodable frame are bad too.
    const b = await connect(port);
    b.send({ t: 'hello', v: 1, extra: true });
    expect(await b.closed).toBe(4400);
    const odd = await connect(port);
    odd.send({ t: 'hello', v: 1 });
    await odd.next();
    odd.send(new Uint8Array([0, 0, 0, 1, 7])); // odd byte count
    expect(await odd.closed).toBe(4400);

    // Capacity: two open, the third refused with HTTP 503 before the upgrade, and a slot frees when one closes.
    const c1 = await connect(port);
    const c2 = await connect(port);
    expect(await upgradeStatus(port, { authorization: `Bearer ${TEST_TOKEN}` })).toBe(503);
    c1.ws.close();
    await c1.closed;
    await new Promise((r) => setTimeout(r, 20));
    const c4 = await connect(port);
    c4.send({ t: 'hello', v: 1 });
    expect((await c4.next()).kind).toBe('msg');
    c2.ws.close();
    c4.ws.close();
    await Promise.all([c2.closed, c4.closed]);
    // Every log field is a number or a boolean.
    for (const [, f] of logs) for (const v of Object.values(f ?? {})) expect(['number', 'boolean']).toContain(typeof v);
  });

  test('close() ends every open session and stops listening', async () => {
    const { server, port } = await start(2);
    const c = await connect(port);
    c.send({ t: 'hello', v: 1 });
    await c.next();
    await server.close();
    expect(await c.closed).toBe(1001);
    await expect(connect(port)).rejects.toThrow();
  });
});

describe('boot (P11)', () => {
  test('a dev env boots the fake engines on VOICE_PORT and answers hello; production refuses the fake engine and a short token', async () => {
    const port = await freePort();
    const service = await boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: String(port), VOICE_ENGINE: 'fake' });
    expect(service.port).toBe(port);
    servers.push(service);
    const c = await connect(service.port);
    c.send({ t: 'hello', v: 1 });
    expect(await c.next()).toMatchObject({ kind: 'msg', msg: { t: 'ready', stt: 'fake-stt', tts: 'fake-tts' } });
    c.ws.close();
    await c.closed;
    // Production: refused by config first (the fake engine, a short token); the bench gate is bench-gate.test.ts.
    await expect(boot({ NODE_ENV: 'production', VOICE_SERVICE_TOKEN: 'p'.repeat(32), VOICE_ENGINE: 'fake' })).rejects.toThrow(/VOICE_ENGINE=fake/);
    await expect(boot({ NODE_ENV: 'production', VOICE_SERVICE_TOKEN: TEST_TOKEN.slice(0, 31), VOICE_ENGINE: 'worker' })).rejects.toThrow(/32 bytes/);
  });
});

test('P2: apps/voice/src never imports speechText or speechChunks; the API alone renders and chunks speech', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  expect(files).toContain('session.ts');
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\bspeech(Text|Chunks)\b/);
});

describe('fix round 1 (review I1, I3)', () => {
  // The reviewer's probe (test/fixtures/upgrade-probe.mjs), in a child process: memory measured here is the server's.
  async function probe(port: number, authorization: string, count = 300): Promise<{ closedWithin: number; statuses: Map<string, number> }> {
    const script = fileURLToPath(new URL('./fixtures/upgrade-probe.mjs', import.meta.url));
    const junk = authorization.includes(TEST_TOKEN) ? '0' : '1';
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, [script, String(port), authorization, String(count), junk], { timeout: 20_000 }, (err, stdout) => (err ? reject(new Error(`upgrade probe failed: ${err.message}`)) : resolve(stdout)));
    });
    const r = JSON.parse(out) as { closedWithin: number; statuses: Record<string, number> };
    return { closedWithin: r.closedWithin, statuses: new Map(Object.entries(r.statuses)) };
  }

  test('I3: 300 unauthenticated upgrades are refused with 401 and every socket is closed by the server within 3 s; memory stays bounded', async () => {
    const { port, logs } = await start(2);
    const before = process.memoryUsage();
    const { closedWithin, statuses } = await probe(port, 'Bearer wrong');
    const after = process.memoryUsage();
    expect(closedWithin).toBeLessThan(3000);
    expect(statuses.get('401')).toBe(300);
    expect(logs.filter(([k]) => k === 'auth_fail')).toHaveLength(300);
    expect(logs.some(([k]) => k === 'conn_open')).toBe(false);
    // The server never reads the 300 KB each socket sent (88 MB in all): it grows by far less than one socket's worth each.
    expect(after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers)).toBeLessThan(20 * 1024 * 1024);
  });

  test('I3: over capacity, pending upgrades count: 300 authorised upgrades against maxConnections 2 → 2 upgraded, 298 refused with 503, all closed', async () => {
    const { port } = await start(2);
    const { closedWithin, statuses } = await probe(port, `Bearer ${TEST_TOKEN}`);
    expect(statuses.get('503')).toBe(298);
    expect(statuses.get('101')).toBe(2);
    expect(closedWithin).toBeLessThan(3000);
  });

  test('I1: an error thrown while handling a message fails that session with 1011 and logs only fatal; the server keeps serving', async () => {
    const logs: [LogKind, unknown][] = [];
    let first = true;
    const tts = fakeTts();
    const server = createVoiceServer({
      config: testConfig(),
      stt: fakeStt(() => 'x'),
      tts: {
        get model(): string {
          if (first) {
            first = false;
            throw new Error('model getter crash zebrapeanut71');
          }
          return tts.model;
        },
        sampleRate: tts.sampleRate,
        synthesize: tts.synthesize,
      },
      log: (k, f) => logs.push([k, f]),
    });
    servers.push(server);
    const port = await server.listen(0);
    const a = await connect(port);
    a.send({ t: 'hello', v: 1 });
    expect(await a.closed).toBe(1011);
    const b = await connect(port);
    b.send({ t: 'hello', v: 1 });
    expect((await b.next()).kind).toBe('msg');
    b.ws.close();
    await b.closed;
    expect(logs.map(([k]) => k)).toContain('fatal');
    expect(logs.find(([k]) => k === 'fatal')).toEqual(['fatal', undefined]);
    expect(JSON.stringify(logs)).not.toContain('zebrapeanut71');
  });
});

describe('fix round 2 (review N4): a client that stops reading', () => {
  function fakeWs() {
    const sent: unknown[] = [];
    const closes: number[] = [];
    let terminated = 0;
    const ws = {
      bufferedAmount: 0,
      send: (d: unknown) => void sent.push(d),
      close: (code: number) => void closes.push(code),
      terminate: () => void terminated++,
    };
    return { ws, sent, closes, terminated: () => terminated };
  }

  test(`a send that leaves bufferedAmount over MAX_BUFFERED closes the socket with 1011 and reports congestion; under it, nothing closes`, () => {
    const { ws, closes } = fakeWs();
    const io = socketIo(ws);
    ws.bufferedAmount = MAX_BUFFERED;
    expect(io.frame(new Uint8Array(8))).toBe(true);
    io.json({ t: 'failed', id: 1, kind: 'tts' });
    expect(closes).toEqual([]);
    ws.bufferedAmount = MAX_BUFFERED + 1;
    expect(io.frame(new Uint8Array(8))).toBe(false);
    expect(closes).toEqual([1011]);
    // Once closing, nothing more is queued and it is not closed twice.
    const before = closes.length;
    expect(io.frame(new Uint8Array(8))).toBe(false);
    io.json({ t: 'failed', id: 1, kind: 'tts' });
    expect(closes).toHaveLength(before);
  });

  test('a JSON send over the bound closes with 1011 too', () => {
    const { ws, sent, closes } = fakeWs();
    const io = socketIo(ws);
    ws.bufferedAmount = MAX_BUFFERED + 10;
    io.json({ t: 'failed', id: 1, kind: 'tts' });
    expect(closes).toEqual([1011]);
    io.json({ t: 'failed', id: 2, kind: 'tts' });
    expect(sent).toHaveLength(1);
  });
});

describe('fix round 3 (review F2): a congested close ends the session at once', () => {
  test(`over MAX_BUFFERED: the session is stopped at once (onShut), and the socket is terminated after CONGESTED_GRACE_MS, not ws's 30 s`, () => {
    vi.useFakeTimers();
    try {
      const sent: unknown[] = [];
      const closes: number[] = [];
      let terminated = 0;
      let shut = 0;
      const ws = { bufferedAmount: MAX_BUFFERED + 1, send: (d: unknown) => void sent.push(d), close: (c: number) => void closes.push(c), terminate: () => void terminated++ };
      const io = socketIo(ws, () => shut++);
      expect(io.frame(new Uint8Array(4))).toBe(false);
      expect(closes).toEqual([1011]);
      expect(shut).toBe(1);
      expect(terminated).toBe(0);
      vi.advanceTimersByTime(CONGESTED_GRACE_MS - 1);
      expect(terminated).toBe(0);
      vi.advanceTimersByTime(1);
      expect(terminated).toBe(1);
      expect(CONGESTED_GRACE_MS).toBeLessThanOrEqual(2000);
      // Once shut, nothing more: no second close, onShut or terminate.
      io.json({ t: 'failed', id: 1, kind: 'tts' });
      io.frame(new Uint8Array(4));
      vi.advanceTimersByTime(10_000);
      expect([closes.length, shut, terminated]).toEqual([1, 1, 1]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a real client that stops reading: after the congested close, its listen and end reach no engine', async () => {
    let calls = 0;
    const server = createVoiceServer({
      config: testConfig(),
      stt: { model: 'counting', transcribe: () => (calls++, Promise.resolve('x')) },
      // A TTS that floods: one speak yields far more than MAX_BUFFERED in big pieces, faster than any socket drains.
      tts: {
        model: 'flood',
        sampleRate: 22_050,
        synthesize: async function* (_t, _v, signal) {
          for (let i = 0; i < 400 && !signal.aborted; i++) yield new Int16Array(64 * 1024);
        },
      },
      log: () => {},
    });
    servers.push(server);
    const c = await connect(await server.listen(0));
    c.send({ t: 'hello', v: 1 });
    await c.next();
    const socket = (c.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    c.send({ t: 'speak', id: 1, voice: 'pan', chunks: [{ text: 'flood', cache: false }] });
    await new Promise((r) => setTimeout(r, 300));
    c.send({ t: 'listen', id: 2, hint: [] });
    c.send(encodeFrame(2, new Int16Array(320)));
    c.send({ t: 'end', id: 2 });
    await new Promise((r) => setTimeout(r, CONGESTED_GRACE_MS + 300));
    expect(calls).toBe(0);
    // Reading again: the server already dropped the socket (terminate), so its 1011 close frame never arrives.
    socket.resume();
    const code = await Promise.race([c.closed, new Promise((r) => setTimeout(() => r('still open'), 3000))]);
    expect(code).toBe(1006);
  });
});

describe('Step 3: slow headers, pre-upgrade sockets, silent sockets and the bind address (N3, review M2, C-38)', () => {
  async function startWith(limits: Parameters<typeof createVoiceServer>[0]['limits'], config = testConfig()) {
    const logs: [LogKind, Record<string, number | boolean> | undefined][] = [];
    const server = createVoiceServer({ config, stt: fakeStt(() => 'hello'), tts: fakeTts(), log: (kind, fields) => logs.push([kind, fields]), limits });
    servers.push(server);
    return { port: await server.listen(0), logs };
  }

  /** A raw TCP client; resolves with how long the server took to close it, and what it answered. */
  function rawSocket(port: number, host = '127.0.0.1'): { sock: Socket; closed: Promise<{ ms: number; data: string }> } {
    const started = Date.now();
    const sock = netConnect(port, host);
    let data = '';
    sock.on('data', (d: Buffer) => (data += d.toString('latin1')));
    sock.on('error', () => {});
    return { sock, closed: new Promise((resolve) => sock.once('close', () => resolve({ ms: Date.now() - started, data }))) };
  }

  test(`N3: fixed header and request timeouts (${HEADERS_TIMEOUT_MS} ms, ${REQUEST_TIMEOUT_MS} ms): a client trickling its headers a byte at a time is cut off`, async () => {
    expect(HEADERS_TIMEOUT_MS).toBeLessThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(5000);
    const { port, logs } = await startWith(undefined);
    const { sock, closed } = rawSocket(port);
    const header = `GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAuthorization: Bearer ${TEST_TOKEN}\r\nX-Pad: ${'a'.repeat(200)}`;
    let i = 0;
    const drip = setInterval(() => {
      if (!sock.destroyed && i < header.length) sock.write(header[i++]);
    }, 50);
    const { ms } = await closed;
    clearInterval(drip);
    expect(i).toBeLessThan(header.length); // cut off mid-headers, never upgraded
    expect(ms).toBeGreaterThanOrEqual(HEADERS_TIMEOUT_MS - 100);
    expect(ms).toBeLessThan(HEADERS_TIMEOUT_MS + 1500);
    expect(logs.some(([k]) => k === 'conn_open')).toBe(false);
  });

  test(`N3: at most MAX_PRE_UPGRADE (${MAX_PRE_UPGRADE}) sockets may wait before their upgrade; one over is destroyed at once, and a slot frees when one goes`, async () => {
    const { port } = await startWith({ preUpgrade: 3 });
    const idle = [rawSocket(port), rawSocket(port), rawSocket(port)];
    await new Promise((r) => setTimeout(r, 100));
    const over = rawSocket(port);
    const { ms, data } = await over.closed;
    expect(ms).toBeLessThan(500);
    expect(data).toBe(''); // never read, never answered
    expect(idle.every((s) => !s.sock.destroyed)).toBe(true);
    // An authorised upgrade is refused only while the slots are full: free one and it goes through.
    idle[0].sock.destroy();
    await idle[0].closed;
    await new Promise((r) => setTimeout(r, 50));
    expect(await upgradeStatus(port, { authorization: `Bearer ${TEST_TOKEN}` })).toBe(101);
    for (const s of idle) s.sock.destroy();
  });

  test('review M2: a socket that never says hello, or goes silent after it, is closed with 4408; one that keeps talking stays open', async () => {
    expect(IDLE_TIMEOUT_MS).toBeGreaterThan(HANDS_FREE_IDLE_MS); // a hands-free cook can be quiet that long
    const { port, logs } = await startWith({ helloMs: 200, idleMs: 400 });
    const mute = await connect(port);
    const quiet = await connect(port);
    quiet.send({ t: 'hello', v: 1 });
    await quiet.next();
    const chatty = await connect(port);
    chatty.send({ t: 'hello', v: 1 });
    await chatty.next();
    const t0 = Date.now();
    const talk = setInterval(() => chatty.send({ t: 'cancel', id: 1 }), 100);
    expect(await mute.closed).toBe(4408);
    expect(Date.now() - t0).toBeLessThan(400);
    expect(await quiet.closed).toBe(4408);
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(talk);
    expect(chatty.ws.readyState).toBe(chatty.ws.OPEN);
    expect(await chatty.closed).toBe(4408); // and once it stops, it goes too
    await new Promise((r) => setTimeout(r, 50)); // the server's own close event, and its log line
    expect(logs.filter(([k, f]) => k === 'conn_close' && f?.code === 4408)).toHaveLength(3);
  });

  test('C-38: the server binds config.host only (127.0.0.2 here): the same port on 127.0.0.1 refuses the connection', async () => {
    const { port } = await startWith(undefined, testConfig({ host: '127.0.0.2' }));
    const ok = await connect(port, `Bearer ${TEST_TOKEN}`, '127.0.0.2');
    ok.ws.close();
    await ok.closed;
    await expect(connect(port, `Bearer ${TEST_TOKEN}`, '127.0.0.1')).rejects.toThrow(/ECONNREFUSED/);
  });
});
