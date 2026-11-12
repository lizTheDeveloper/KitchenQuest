// M7 Step 2: the WebSocket server. Only the API may connect (a shared bearer token, compared in constant time); the
// service knows no user and logs only enums and numbers.
import { readdirSync, readFileSync } from 'node:fs';
import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { boot } from '../src/boot';
import { fakeStt, fakeTts } from '../src/engines/fake';
import type { LogKind } from '../src/log';
import { createVoiceServer } from '../src/server';
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
  test('a dev env boots the fake engines on VOICE_PORT and answers hello; production refuses until the Step 3 bench gate exists', async () => {
    const port = await freePort();
    const service = await boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: String(port), VOICE_ENGINE: 'fake' });
    expect(service.port).toBe(port);
    servers.push(service);
    const c = await connect(service.port);
    c.send({ t: 'hello', v: 1 });
    expect(await c.next()).toMatchObject({ kind: 'msg', msg: { t: 'ready', stt: 'fake-stt', tts: 'fake-tts' } });
    c.ws.close();
    await c.closed;
    await expect(boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: String(port), VOICE_ENGINE: 'worker' })).rejects.toThrow(/Step 3/);
    // Production: refused by config first (fake engine, empty files), and by the gate even when config would pass.
    await expect(boot({ NODE_ENV: 'production', VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_ENGINE: 'fake' })).rejects.toThrow(/VOICE_ENGINE=fake/);
    await expect(boot({ NODE_ENV: 'production', VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_ENGINE: 'worker' })).rejects.toThrow(/files/);
  });
});

test('P2: apps/voice/src never imports speechText or speechChunks; the API alone renders and chunks speech', () => {
  const dir = fileURLToPath(new URL('../src/', import.meta.url));
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
  expect(files).toContain('session.ts');
  for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/\bspeech(Text|Chunks)\b/);
});

describe('fix round 1 (review I1, I3)', () => {
  // The reviewer's probe: 300 raw upgrades with a bad token, each then sending 5 × 60 KB and never answering a close.
  // A socket that is upgraded (101) is kept open, so every refusal is concurrent with it; it is destroyed at the end.
  async function probe(port: number, authorization: string, count = 300): Promise<{ closedWithin: number; statuses: Map<string, number> }> {
    const junk = Buffer.alloc(60 * 1024, 0x4b);
    const statuses = new Map<string, number>();
    const upgraded: Socket[] = [];
    const started = Date.now();
    await Promise.all(
      Array.from(
        { length: count },
        () =>
          new Promise<void>((resolve) => {
            const sock = netConnect(port, '127.0.0.1', () => {
              sock.write(
                'GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
                  `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: ${authorization}\r\n\r\n`,
              );
              if (!authorization.includes(TEST_TOKEN)) for (let i = 0; i < 5; i++) sock.write(junk);
            });
            let head = '';
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              const status = /^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 'none';
              statuses.set(status, (statuses.get(status) ?? 0) + 1);
              resolve();
            };
            sock.on('data', (d: Buffer) => {
              if (head.length < 64) head += d.toString('latin1');
              if (head.startsWith('HTTP/1.1 101')) {
                upgraded.push(sock);
                finish();
              }
            });
            sock.on('error', () => {});
            sock.on('close', finish);
          }),
      ),
    );
    const closedWithin = Date.now() - started;
    for (const u of upgraded) u.destroy();
    return { closedWithin, statuses };
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
    // The server never reads the 1.5 MB per socket it was sent: growth far below 300 × 300 KB (~88 MB).
    expect(after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers)).toBeLessThan(30 * 1024 * 1024);
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
