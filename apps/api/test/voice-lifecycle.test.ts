// M7 Step 5 fix round 1 (review-task5.md): the voice socket's lifetime and metering.
// I1: the session and the `voice` consent are re-checked on every listen and speak, and sign-out, consent withdrawals
// and account delete close every voice socket of the player. I2 / m3: speech that went upstream is charged once,
// before the next listen can pass the allowance. m4, m5, m7, m9, m10: one too_long per id, the socket's own date for
// steps, a mapped close on an internal error, a heartbeat, and limits on opens and queued bytes.
import type { AddressInfo } from 'node:net';
import { FRAME_MS, MAX_TEXT, MAX_UTTERANCE_MS, VOICE_CLOSE_CODES } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { defaultCatalog } from '../src/catalog.js';
import { withdrawConsent } from '../src/consent/ledger.js';
import { NOTICES } from '../src/consent/notices.js';
import { sessions, usageEvents } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { RECIPES_DIR, syncCanon } from '../src/recipes/sync.js';
import type { Db } from '../src/types.js';
import { FREE_VOICE_SECONDS_PER_30_DAYS } from '../src/voice/constants.js';
import { VOICE_OPENS_PER_MINUTE } from '../src/voice/routes.js';
import { voiceRegistry } from '../src/voice/registry.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';
import { connectVoice, FakeUpstream, type FakeUpstreamOptions, type VoiceClient } from './helpers/fake-upstream.js';

const config = testConfig({ VOICE_ENABLED: 'true', VOICE_SERVICE_URL: 'ws://127.0.0.1:9', VOICE_SERVICE_TOKEN: 'test-token' });
const NOW = new Date('2026-11-12T10:00:00Z');
const CLOCK = { localDate: '2026-11-12', localTime: '10:00' };

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance | undefined;
let mailer: CaptureMailer;
let upstream: FakeUpstream;
let port = 0;
let seq = 0;
const clients: VoiceClient[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
  await syncCanon(db, RECIPES_DIR, defaultCatalog().graph, NOW);
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await app?.close();
  app = undefined;
});

async function start(opts: FakeUpstreamOptions = {}, timing: { voicePingMs?: number } = {}): Promise<void> {
  mailer = new CaptureMailer();
  upstream = new FakeUpstream(opts);
  app = await buildApp({ config, db, mailer, ai: null, now: () => NOW, logger: false, voiceUpstream: upstream, ...timing });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}
const call = (cookie: string, opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });
async function grant(cookie: string, purpose: 'voice' | 'health_data') {
  expect((await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } })).statusCode).toBe(201);
}
async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app!, mailer, `vlife${++seq}@example.com`);
  await grant(cookie, 'voice');
  return { cookie, id: (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id };
}
async function ready(cookie: string): Promise<VoiceClient> {
  const c = await connectVoice(port, { cookie });
  clients.push(c);
  c.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK });
  expect((await c.next()).t).toBe('ready');
  return c;
}
/** An utterance left open, mid-way: listen and some frames, no end. */
async function midUtterance(c: VoiceClient, id = 1): Promise<void> {
  c.send({ t: 'listen', id, mode: 'hold' });
  for (let i = 0; i < 5; i++) c.frame(id);
  await new Promise((r) => setTimeout(r, 60));
  expect(upstream.utterances.at(-1)).toMatchObject({ frames: 5, cancelled: false });
}
const sttRows = async (userId: string) =>
  (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).filter((r) => r.feature === 'voice_stt').map((r) => r.units);
const settle = () => new Promise((r) => setTimeout(r, 80));
/** A transcribe that waits on a gate, so the client can act between `end` and the answer. */
function gated(): { opts: FakeUpstreamOptions; release(): void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return { opts: { transcribe: async (u) => (await gate, `heard ${u.frames} frames`) }, release: () => release() };
}

describe('I1: every voice socket of the player closes when access ends', () => {
  test.each([
    ['sign-out (POST /auth/logout)', 'signed_out', (p: { cookie: string }) => call(p.cookie, { method: 'POST', url: '/auth/logout' })],
    ['voice consent withdrawal', 'consent_required', (p: { cookie: string }) => call(p.cookie, { method: 'DELETE', url: '/me/consents/voice', payload: {} })],
    [
      'health_data withdrawal',
      'consent_required',
      async (p: { cookie: string }) => call(p.cookie, { method: 'DELETE', url: '/me/consents/health_data', payload: { healthData: 'keep' } }),
    ],
    ['account delete', 'signed_out', (p: { cookie: string }) => call(p.cookie, { method: 'DELETE', url: '/me', payload: { confirm: 'delete my account' } })],
  ] as const)('%s closes a socket open mid-utterance with %s; the utterance is dropped upstream', async (_name, reason, act) => {
    await start();
    const p = await player();
    if (_name.startsWith('health')) await grant(p.cookie, 'health_data');
    const c = await ready(p.cookie);
    await midUtterance(c);
    expect((await act(p)).statusCode).toBe(204);
    expect(await c.closed).toBe(VOICE_CLOSE_CODES[reason]);
    expect(c.msgs.at(-1)).toEqual({ t: 'closed', reason });
    expect(upstream.utterances.at(-1)).toMatchObject({ cancelled: true });
    expect(voiceRegistry.openSockets(p.id)).toBe(0);
  });

  test('re-checked on every listen and speak: a session revoked out of band (the row gone) → signed_out; a voice grant withdrawn out of band → consent_required', async () => {
    await start();
    const p = await player();
    const c = await ready(p.cookie);
    await db.delete(sessions).where(eq(sessions.userId, p.id));
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.signed_out);
    expect(upstream.utterances).toEqual([]);

    const q = await player();
    const d = await ready(q.cookie);
    await withdrawConsent(db, q.id, 'voice', NOW); // the ledger directly: no route, no registry call
    d.send({ t: 'speak', id: 2, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }] });
    expect(await d.closed).toBe(VOICE_CLOSE_CODES.consent_required);
    expect(upstream.speeches).toEqual([]);
  });

  test('another player of the same server keeps their socket through all of it', async () => {
    await start();
    const p = await player();
    const other = await player();
    const theirs = await ready(other.cookie);
    await ready(p.cookie);
    expect((await call(p.cookie, { method: 'POST', url: '/auth/logout' })).statusCode).toBe(204);
    await settle();
    expect(theirs.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('I2 / m3: speech that went upstream is charged once, before the next listen', () => {
  test('listen, frames, end, cancel → one voice_stt row (the service decoded it); a cancel while still listening → none', async () => {
    const g = gated();
    await start(g.opts);
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 60; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    c.send({ t: 'cancel', id: 1 });
    await settle();
    g.release();
    await settle();
    expect(await sttRows(p.id)).toEqual([2]);
    c.send({ t: 'listen', id: 2, mode: 'hold' });
    for (let i = 0; i < 60; i++) c.frame(2);
    c.send({ t: 'cancel', id: 2 });
    await settle();
    expect(await sttRows(p.id)).toEqual([2]);
  });

  test('replaced after end → charged; the socket closed after end → charged; the loop listen/frames/end/cancel is charged every time', async () => {
    const g = gated();
    await start(g.opts);
    const p = await player();
    const c = await ready(p.cookie);
    for (let k = 1; k <= 3; k++) {
      c.send({ t: 'listen', id: k, mode: 'hold' });
      for (let i = 0; i < 50; i++) c.frame(k);
      c.send({ t: 'end', id: k });
      c.send({ t: 'cancel', id: k });
    }
    c.send({ t: 'listen', id: 9, mode: 'hold' });
    for (let i = 0; i < 50; i++) c.frame(9);
    c.send({ t: 'end', id: 9 });
    c.send({ t: 'listen', id: 10, mode: 'hold' }); // replaces 9 while it is being transcribed
    for (let i = 0; i < 50; i++) c.frame(10);
    c.send({ t: 'end', id: 10 });
    await settle();
    c.ws.terminate(); // 10 is in flight, after end
    await c.closed;
    await settle();
    g.release();
    await settle();
    expect(await sttRows(p.id)).toEqual([1, 1, 1, 1, 1]);
  });

  test('m3: the next listen, sent at once, sees the last utterance\'s seconds (3599 s used + 2 s → resting), with no wait for the transcript', async () => {
    const g = gated();
    await start(g.opts);
    const p = await player();
    await db.insert(usageEvents).values({ userId: p.id, feature: 'voice_stt', units: FREE_VOICE_SECONDS_PER_30_DAYS - 1, costMicroUsd: 0, createdAt: new Date('2026-11-01T09:00:00Z') });
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 100; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    c.send({ t: 'listen', id: 2, mode: 'hold' });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'failed', id: 1, kind: 'stt' });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'state', state: { kind: 'resting', until: '2026-12-01' } });
    g.release();
  });

  test('m3: an answered utterance is recorded before its transcript is sent', async () => {
    await start();
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 50; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    await c.next((m) => m.t === 'transcript');
    expect(await sttRows(p.id)).toEqual([1]);
  });

  test('the service down after end is still not charged', async () => {
    const g = gated();
    await start(g.opts);
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 50; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    await settle();
    upstream.down();
    expect(await c.next((m) => m.t === 'failed')).toEqual({ t: 'failed', id: 1, kind: 'upstream' });
    await settle();
    expect(await sttRows(p.id)).toEqual([]);
  });
});

describe('Minors', () => {
  test('m4: an utterance past MAX_UTTERANCE_MS whose transcript is also over MAX_TEXT gets one too_long, never two', async () => {
    await start({ transcribe: () => 'x'.repeat(MAX_TEXT + 1) });
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < MAX_UTTERANCE_MS / FRAME_MS + 5; i++) c.frame(1);
    await settle();
    await settle();
    expect(c.msgs.filter((m) => m.t !== 'ready')).toEqual([{ t: 'too_long', id: 1 }]);
  });

  test("m5: a step item is checked on the socket's own date (hello's clock), not the date the item carries", async () => {
    await start();
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'speak', id: 1, items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 0, localDate: '2026-11-14' }] });
    await c.next((m) => m.t === 'audio_end');
    expect(upstream.speeches[0].chunks.map((x) => x.text).join(' ')).toBe('Rinse split moong dal in a bowl two or three times, until the water runs mostly clear.');
  });

  test('m7: an unexpected error closes with closed unavailable (4503), never a bare 1011', async () => {
    await start();
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    await settle();
    c.frame(1, 100); // the fake service throws on a frame that is not 20 ms
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.unavailable);
    expect(c.msgs.at(-1)).toEqual({ t: 'closed', reason: 'unavailable' });
  });

  test('m9: a peer that stops answering pings is terminated and leaves the registry', async () => {
    await start({}, { voicePingMs: 60 });
    const p = await player();
    const c = await ready(p.cookie);
    expect(voiceRegistry.openSockets(p.id)).toBe(1);
    // A live client answers pings by itself: still open after several rounds.
    await new Promise((r) => setTimeout(r, 250));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    (c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    const t0 = Date.now();
    while (voiceRegistry.openSockets(p.id) > 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(voiceRegistry.openSockets(p.id)).toBe(0);
  });

  test(`m10: more than VOICE_OPENS_PER_MINUTE (${VOICE_OPENS_PER_MINUTE}) opens a minute → 429 before the upgrade`, async () => {
    await start();
    const p = await player();
    const statuses: number[] = [];
    for (let i = 0; i <= VOICE_OPENS_PER_MINUTE; i++) {
      statuses.push(
        await new Promise<number>((resolve) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/voice`, { headers: { cookie: `kq_session=${p.cookie}`, origin: 'http://localhost:5173' } });
          ws.on('open', () => {
            ws.close();
            resolve(101);
          });
          ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
          ws.on('error', () => {});
        }),
      );
    }
    expect(statuses.slice(0, VOICE_OPENS_PER_MINUTE).every((s) => s === 101)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test('m10: the queue is capped by bytes: megabytes of frames while a listen waits close the socket bad_message', async () => {
    let open!: () => void;
    const opening = new Promise<void>((r) => (open = r));
    await start({ openGate: opening });
    const p = await player();
    const c = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 300; i++) c.frame(99, 8000); // 16 KB each, a stale id
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.bad_message);
    open();
  });
});
