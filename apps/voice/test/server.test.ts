// M7 Step 2: the WebSocket server. Only the API may connect (a shared bearer token, compared in constant time); the
// service knows no user and logs only enums and numbers.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { boot } from '../src/boot';
import { fakeStt, fakeTts } from '../src/engines/fake';
import type { LogKind } from '../src/log';
import { createVoiceServer } from '../src/server';
import { connect, testConfig, TEST_TOKEN } from './helpers';

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
  test('no Authorization: Bearer <token> → closed 4401, logged as auth_fail only; bad JSON → bad_message; maxConnections+1 refused', async () => {
    const { port, logs } = await start(2);
    const headers = [
      null,
      'Bearer wrong',
      `Bearer ${TEST_TOKEN.slice(0, -1)}`,
      `Bearer ${TEST_TOKEN}x`,
      'Bearer ',
      `Basic ${Buffer.from(`api:${TEST_TOKEN}`).toString('base64')}`, // the right secret under another scheme
    ];
    for (const h of headers) {
      const c = await connect(port, h);
      expect(await c.closed, String(h)).toBe(4401);
    }
    expect(logs.map(([k]) => k)).toEqual(Array(6).fill('auth_fail'));
    expect(logs.every(([, f]) => f === undefined)).toBe(true);

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

    // Capacity: two open, the third refused with 1013 (try again later), and a slot frees when one closes.
    const c1 = await connect(port);
    const c2 = await connect(port);
    const c3 = await connect(port);
    expect(await c3.closed).toBe(1013);
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
    const service = await boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: '0', VOICE_ENGINE: 'fake' });
    servers.push(service);
    const c = await connect(service.port);
    c.send({ t: 'hello', v: 1 });
    expect(await c.next()).toMatchObject({ kind: 'msg', msg: { t: 'ready', stt: 'fake-stt', tts: 'fake-tts' } });
    c.ws.close();
    await c.closed;
    await expect(boot({ VOICE_SERVICE_TOKEN: TEST_TOKEN, VOICE_PORT: '0', VOICE_ENGINE: 'worker' })).rejects.toThrow(/Step 3/);
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
