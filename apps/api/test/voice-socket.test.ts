// M7 Step 5: the voice socket, GET /voice, end to end over a real listening app and a `ws` client, with a FakeUpstream
// for the voice service (no network beyond loopback). Each title states its assertion (D3).
import type { AddressInfo } from 'node:net';
import { MAX_TEXT, MAX_UTTERANCE_MS, FRAME_MS, VOICE_CLOSE_CODES, type ServerMsg } from '@kitchenquest/core';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { usageEvents } from '../src/db/schema.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import type { Db } from '../src/types.js';
import { FREE_VOICE_SECONDS_PER_30_DAYS, VOICE_COST_MICROUSD_PER_SECOND } from '../src/voice/constants.js';
import { MAX_UTTERANCES_PER_USER, TRANSCRIPTS_KEPT } from '../src/voice/routes.js';
import { setAccessibility } from '../src/voice/settings.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb, type Sql } from './helpers/db.js';
import { connectVoice, FakeUpstream, type FakeUpstreamOptions, type VoiceClient } from './helpers/fake-upstream.js';

export const voiceConfig = testConfig({ VOICE_ENABLED: 'true', VOICE_SERVICE_URL: 'ws://127.0.0.1:9', VOICE_SERVICE_TOKEN: 'test-token' });
const NOW = new Date('2026-11-12T10:00:00Z');
const CLOCK = { localDate: '2026-11-12', localTime: '10:00' };

let db: Db;
let sql: Sql;
let closeDb: () => Promise<void>;
let app: FastifyInstance | undefined;
let mailer: CaptureMailer;
let port = 0;
let upstream: FakeUpstream;
let clock = NOW.getTime();
let seq = 0;
const clients: VoiceClient[] = [];

beforeAll(async () => {
  ({ db, sql, close: closeDb } = await testDb());
});
afterAll(async () => {
  await closeDb?.();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.ws.terminate();
  await app?.close();
  app = undefined;
});

async function start(opts: FakeUpstreamOptions = {}): Promise<void> {
  mailer = new CaptureMailer();
  clock = NOW.getTime();
  upstream = new FakeUpstream(opts);
  app = await buildApp({ config: voiceConfig, db, mailer, ai: null, now: () => new Date(clock), logger: false, voiceUpstream: upstream });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
}

const call = (cookie: string, opts: InjectOptions) => app!.inject({ ...opts, cookies: { kq_session: cookie } });
async function grant(cookie: string, purpose: 'voice' | 'health_data') {
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose, noticeVersion: NOTICES[purpose]!.version } });
  expect(res.statusCode, res.body).toBe(201);
}
async function player(opts: { voice?: boolean } = {}): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app!, mailer, `vsock${++seq}@example.com`);
  if (opts.voice !== false) await grant(cookie, 'voice');
  return { cookie, id: (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id };
}
async function client(cookie?: string, origin?: string | null): Promise<VoiceClient> {
  const c = await connectVoice(port, { cookie, origin });
  clients.push(c);
  return c;
}
/** A socket past hello, with its `ready`. */
async function ready(cookie: string, hello: object = {}): Promise<{ c: VoiceClient; state: ServerMsg }> {
  const c = await client(cookie);
  c.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK, ...hello });
  return { c, state: await c.next() };
}
const speechOf = (userId: string) => db.select().from(usageEvents).where(eq(usageEvents.userId, userId));
const settle = () => new Promise((r) => setTimeout(r, 60));

/** Every table's row count: "no other table written" compares these. */
async function rowCounts(): Promise<Record<string, number>> {
  const tables = await sql<{ t: string }[]>`select table_name as t from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`;
  const out: Record<string, number> = {};
  for (const { t } of tables) out[t] = Number((await sql.unsafe(`select count(*)::int as n from "${t}"`))[0].n);
  return out;
}

describe('opening (B5)', () => {
  test('no cookie → signed_out; no Origin header → bad_origin; a cross-site Origin → bad_origin; no voice grant → consent_required', async () => {
    await start();
    const p = await player();
    const cases: [VoiceClient, string][] = [
      [await client(undefined), 'signed_out'],
      [await client('not-a-session'), 'signed_out'],
      [await client(p.cookie, null), 'bad_origin'],
      [await client(p.cookie, 'https://evil.example'), 'bad_origin'],
      [await client(undefined, 'https://evil.example'), 'bad_origin'],
    ];
    const noGrant = await player({ voice: false });
    cases.push([await client(noGrant.cookie), 'consent_required']);
    for (const [c, reason] of cases) {
      expect(await c.closed, reason).toBe(VOICE_CLOSE_CODES[reason as keyof typeof VOICE_CLOSE_CODES]);
      expect(c.msgs).toEqual([{ t: 'closed', reason }]);
    }
    expect(VOICE_CLOSE_CODES.signed_out).toBe(4401);
    expect(VOICE_CLOSE_CODES.bad_origin).toBe(4403);
    expect(upstream.opens).toBe(0);
  });

  test('listen before hello → closed bad_message (B5)', async () => {
    await start();
    const p = await player();
    const c = await client(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    expect(await c.closed).toBe(4400);
    expect(c.msgs).toEqual([{ t: 'closed', reason: 'bad_message' }]);
    // so does a frame before hello, a message core refuses, and a second hello
    const f = await client(p.cookie);
    f.frame(1);
    expect(await f.closed).toBe(4400);
    const junk = await client(p.cookie);
    junk.send({ t: 'speak', id: 1, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0, text: 'say this' }] });
    expect(await junk.closed).toBe(4400);
    const { c: twice } = await ready(p.cookie);
    twice.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK });
    expect(await twice.closed).toBe(4400);
    expect(upstream.utterances).toEqual([]);
  });

  test('carry 4: hello takes the player clock, checked as GET /voice/status checks it: a bad time or a date two days off → bad_message', async () => {
    await start();
    const p = await player();
    for (const clockOf of [{ localTime: '9:00' }, { localDate: '2026-11-14' }, { localTime: '25:00' }]) {
      const c = await client(p.cookie);
      c.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK, ...clockOf });
      expect(await c.closed, JSON.stringify(clockOf)).toBe(4400);
    }
    // every real offset is fine: UTC+14 and UTC−12 at NOW
    expect((await ready(p.cookie, { localDate: '2026-11-13', localTime: '00:00' })).state).toEqual({ t: 'ready', state: { kind: 'available' } });
    expect((await ready(p.cookie, { localDate: '2026-11-11', localTime: '22:00' })).state).toEqual({ t: 'ready', state: { kind: 'available' } });
  });
});

describe('listening', () => {
  test('listen + 25 frames + end → transcript; exactly one voice_stt row, units = ceil(25 × 20 ms / 1000) = 1; no other table written', async () => {
    await start();
    const p = await player();
    const { c, state } = await ready(p.cookie);
    expect(state).toEqual({ t: 'ready', state: { kind: 'available' } });
    const before = await rowCounts();
    c.send({ t: 'listen', id: 5, mode: 'hold' });
    for (let i = 0; i < 25; i++) c.frame(5);
    c.send({ t: 'end', id: 5 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'transcript', id: 5, text: 'heard 25 frames' });
    await settle();
    expect(upstream.framesForwarded).toBe(25);
    const rows = await speechOf(p.id);
    expect(rows.map((r) => [r.feature, r.units, r.costMicroUsd])).toEqual([['voice_stt', 1, VOICE_COST_MICROUSD_PER_SECOND]]);
    const after = await rowCounts();
    expect(after).toEqual({ ...before, usage_events: before.usage_events + 1 });
    // The hint went upstream; the voice service gets no user id (C-15): the fake saw a hint and ids only.
    expect(upstream.utterances[0]).toMatchObject({ id: expect.any(Number), frames: 25, ended: true });
    expect(upstream.utterances[0].hint.length).toBeGreaterThan(0);
  });

  test('frames past MAX_UTTERANCE_MS → too_long, then the transcript; frames for a stale id are dropped', async () => {
    await start();
    const p = await player();
    const { c } = await ready(p.cookie);
    const max = MAX_UTTERANCE_MS / FRAME_MS;
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    c.frame(99); // not the live id
    for (let i = 0; i < max + 10; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'too_long', id: 1 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'transcript', id: 1, text: `heard ${max} frames` });
    await settle();
    expect(upstream.framesForwarded).toBe(max);
    expect((await speechOf(p.id)).map((r) => r.units)).toEqual([MAX_UTTERANCE_MS / 1000]);
    // A frame for the finished id, and an `end` for it, change nothing.
    c.frame(1);
    c.send({ t: 'end', id: 1 });
    await settle();
    expect(upstream.framesForwarded).toBe(max);
    expect(c.msgs.filter((m) => m.t !== 'ready')).toHaveLength(2);
  });

  test('resting (free, 3600 s) → state resting and nothing forwarded; accessibility on → available', async () => {
    await start();
    const p = await player();
    await db.insert(usageEvents).values({ userId: p.id, feature: 'voice_stt', units: FREE_VOICE_SECONDS_PER_30_DAYS, costMicroUsd: 0, createdAt: new Date('2026-11-01T09:00:00Z') });
    const { c, state } = await ready(p.cookie);
    expect(state).toEqual({ t: 'ready', state: { kind: 'resting', until: '2026-12-01' } });
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 5; i++) c.frame(1);
    c.send({ t: 'end', id: 1 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'state', state: { kind: 'resting', until: '2026-12-01' } });
    // and a speak rests too
    c.send({ t: 'speak', id: 2, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }] });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'state', state: { kind: 'resting', until: '2026-12-01' } });
    await settle();
    expect(upstream.utterances).toEqual([]);
    expect(upstream.speeches).toEqual([]);
    expect(upstream.opens).toBe(0);

    await grant(p.cookie, 'health_data');
    await setAccessibility(db, voiceConfig.keyring, p.id, true, NOW, 'test');
    const { c: again, state: open } = await ready(p.cookie);
    expect(open).toEqual({ t: 'ready', state: { kind: 'available' } });
    again.send({ t: 'listen', id: 3, mode: 'hold' });
    again.frame(3);
    again.send({ t: 'end', id: 3 });
    expect(await again.next((m) => m.t === 'transcript')).toEqual({ t: 'transcript', id: 3, text: 'heard 1 frames' });
  });

  test('the allowance runs out during an utterance: it finishes and is transcribed; the next listen rests (Review Focus 5)', async () => {
    await start();
    const p = await player();
    await db.insert(usageEvents).values({ userId: p.id, feature: 'voice_stt', units: FREE_VOICE_SECONDS_PER_30_DAYS - 1, costMicroUsd: 0, createdAt: new Date('2026-11-01T09:00:00Z') });
    const { c, state } = await ready(p.cookie);
    expect(state).toEqual({ t: 'ready', state: { kind: 'available' } });
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 150; i++) c.frame(1); // 3 s: over the last second left
    c.send({ t: 'end', id: 1 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'transcript', id: 1, text: 'heard 150 frames' });
    await settle();
    c.send({ t: 'listen', id: 2, mode: 'hold' });
    expect(await c.next((m) => m.t === 'state')).toEqual({ t: 'state', state: { kind: 'resting', until: '2026-12-01' } });
    expect(upstream.utterances).toHaveLength(1);
  });

  test('a second socket of the same user closes the first with another_tab', async () => {
    await start();
    const p = await player();
    const { c: first } = await ready(p.cookie);
    first.send({ t: 'listen', id: 1, mode: 'hold' });
    first.frame(1);
    await settle();
    const { c: second, state } = await ready(p.cookie);
    expect(await first.closed).toBe(VOICE_CLOSE_CODES.another_tab);
    expect(first.msgs.at(-1)).toEqual({ t: 'closed', reason: 'another_tab' });
    expect(state).toEqual({ t: 'ready', state: { kind: 'available' } });
    // the first one's utterance was dropped, never recorded
    await settle();
    expect(upstream.utterances[0]).toMatchObject({ cancelled: true });
    expect(await speechOf(p.id)).toEqual([]);
    second.send({ t: 'listen', id: 1, mode: 'hold' });
    second.frame(1);
    second.send({ t: 'end', id: 1 });
    expect(await second.next((m) => m.t === 'transcript')).toMatchObject({ t: 'transcript', id: 1 });
  });

  test('upstream down → failed upstream; the socket stays open and the next listen works once it is back', async () => {
    await start();
    const p = await player();
    const { c } = await ready(p.cookie);
    // down before the link opens
    upstream.down();
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'failed', id: 1, kind: 'upstream' });
    upstream.up();
    c.send({ t: 'listen', id: 2, mode: 'hold' });
    for (let i = 0; i < 3; i++) c.frame(2);
    await settle();
    // down mid-utterance: the end is answered failed upstream, nothing recorded
    upstream.down();
    c.send({ t: 'end', id: 2 });
    expect(await c.next((m) => m.t === 'failed' && m.id === 2)).toEqual({ t: 'failed', id: 2, kind: 'upstream' });
    await settle();
    expect(await speechOf(p.id)).toEqual([]);
    upstream.up();
    c.send({ t: 'listen', id: 3, mode: 'hold' });
    c.frame(3);
    c.send({ t: 'end', id: 3 });
    expect(await c.next((m) => m.t === 'transcript')).toEqual({ t: 'transcript', id: 3, text: 'heard 1 frames' });
    expect(c.ws.readyState).toBe(c.ws.OPEN);
    expect(upstream.opens).toBe(3);
  });

  test('a misconfigured service (the token refused) closes voice with unavailable', async () => {
    await start();
    const p = await player();
    const { c } = await ready(p.cookie);
    upstream.down('auth');
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.unavailable);
    expect(c.msgs.at(-1)).toEqual({ t: 'closed', reason: 'unavailable' });
  });
});

describe('ids, timeouts and usage (carries 2, 5, 7)', () => {
  test('carry 2: a listen while the last utterance waits for its transcript answers that one failed stt and never awaits it; upstream ids are fresh even when the client reuses one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await start({ transcribe: async (u) => (u.id === 1 ? (await gate, 'late words') : `heard ${u.frames} frames`) });
    const p = await player();
    const { c } = await ready(p.cookie);
    c.send({ t: 'listen', id: 7, mode: 'hold' });
    c.frame(7);
    c.send({ t: 'end', id: 7 });
    await settle();
    c.send({ t: 'listen', id: 7, mode: 'hold' }); // the same client id again
    c.frame(7);
    c.send({ t: 'end', id: 7 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'failed', id: 7, kind: 'stt' });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'transcript', id: 7, text: 'heard 1 frames' });
    release();
    await settle();
    // the replaced utterance's late transcript is never sent; both are charged once (fix round 1, I2: the first's end
    // had gone upstream, so the service decoded it)
    expect(c.msgs.filter((m) => m.t === 'transcript')).toHaveLength(1);
    expect(upstream.utterances.map((u) => u.id)).toEqual([1, 2]);
    expect(upstream.utterances[0].cancelled).toBe(true);
    expect((await speechOf(p.id)).map((r) => r.units)).toEqual([1, 1]);
  });

  test('carry 5: a cancelled utterance is not recorded, an answered one exactly once; never more than MAX_UTTERANCES_PER_USER in flight', async () => {
    await start();
    expect(MAX_UTTERANCES_PER_USER).toBe(1);
    const p = await player();
    const { c } = await ready(p.cookie);
    c.send({ t: 'listen', id: 1, mode: 'hold' });
    for (let i = 0; i < 60; i++) c.frame(1);
    c.send({ t: 'cancel', id: 1 });
    c.send({ t: 'listen', id: 2, mode: 'hold' });
    for (let i = 0; i < 60; i++) c.frame(2);
    c.send({ t: 'end', id: 2 });
    c.send({ t: 'end', id: 2 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'transcript', id: 2, text: 'heard 60 frames' });
    await settle();
    expect((await speechOf(p.id)).map((r) => [r.feature, r.units])).toEqual([['voice_stt', 2]]);
    expect(upstream.utterances.map((u) => [u.cancelled, u.ended])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test('carry 7: a transcript over MAX_TEXT is refused (too_long), never cut; a blank one (spaces and zero-width characters) is failed stt; neither is kept for heard items', async () => {
    await start({ transcribe: (u) => (u.frames === 2 ? 'x'.repeat(MAX_TEXT + 1) : u.frames === 3 ? ' \u200b \u200b ' : 'i am allergic to sesame') });
    const p = await player();
    const { c } = await ready(p.cookie);
    const utter = (id: number, frames: number) => {
      c.send({ t: 'listen', id, mode: 'hold' });
      for (let i = 0; i < frames; i++) c.frame(id);
      c.send({ t: 'end', id });
    };
    utter(1, 2);
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'too_long', id: 1 });
    utter(2, 3);
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'failed', id: 2, kind: 'stt' });
    c.send({ t: 'speak', id: 3, items: [{ kind: 'heard', utteranceId: 1 }] });
    await c.next((m) => m.t === 'audio_end');
    expect(upstream.speeches.at(-1)!.chunks.map((x) => x.text).join(' ')).toBe("It's on the screen; read it there.");
    utter(4, 1);
    expect(await c.next((m) => m.t === 'transcript')).toEqual({ t: 'transcript', id: 4, text: 'i am allergic to sesame' });
    c.send({ t: 'speak', id: 5, items: [{ kind: 'heard', utteranceId: 4 }] });
    await c.next((m) => m.t === 'audio_end' && m.id === 5);
    expect(upstream.speeches.at(-1)!.chunks.map((x) => x.text).join(' ')).toBe("I heard sesame: S. E. S. A. M. E. Tap the card if that's right.");
  });

  test(`a socket keeps its last ${TRANSCRIPTS_KEPT} transcripts for heard items, and none after close`, async () => {
    await start({ transcribe: () => 'peanut' });
    const p = await player();
    const { c } = await ready(p.cookie);
    for (let id = 1; id <= TRANSCRIPTS_KEPT + 1; id++) {
      c.send({ t: 'listen', id, mode: 'hold' });
      c.frame(id);
      c.send({ t: 'end', id });
      await c.next((m) => m.t === 'transcript' && m.id === id);
    }
    c.send({ t: 'speak', id: 50, items: [{ kind: 'heard', utteranceId: 1 }, { kind: 'heard', utteranceId: TRANSCRIPTS_KEPT + 1 }] });
    await c.next((m) => m.t === 'audio_end');
    expect(upstream.speeches.at(-1)!.chunks.map((x) => x.text).join(' ')).toBe("It's on the screen; read it there. I heard peanut. Tap the card if that's right.");
    c.ws.close();
    await c.closed;
    const { c: next } = await ready(p.cookie);
    next.send({ t: 'speak', id: 51, items: [{ kind: 'heard', utteranceId: TRANSCRIPTS_KEPT + 1 }] });
    await next.next((m) => m.t === 'audio_end');
    expect(upstream.speeches.at(-1)!.chunks.map((x) => x.text).join(' ')).toBe("It's on the screen; read it there.");
  });
});

describe('speaking', () => {
  test('speak → audio_start, the frames under the client id, audio_end; voice_tts recorded, never counted; a new speak replaces the old (no audio_end for it)', async () => {
    await start({ ttsFrames: 3 });
    const p = await player();
    const { c } = await ready(p.cookie);
    c.send({ t: 'speak', id: 9, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }] });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'audio_start', id: 9, sampleRate: 22_050 });
    expect(await c.next((m) => m.t !== 'ready')).toEqual({ t: 'audio_end', id: 9 });
    expect(c.frames).toEqual([
      { id: 9, samples: 441 },
      { id: 9, samples: 441 },
      { id: 9, samples: 441 },
    ]);
    expect(upstream.speeches[0]).toMatchObject({ voice: 'pan', chunks: [{ text: "It's on the screen;", cache: true }, { text: 'read it there.', cache: true }] });
    await settle();
    expect((await speechOf(p.id)).map((r) => [r.feature, r.units])).toEqual([['voice_tts', 1]]);
    // cancel stops it: no audio_end, nothing recorded
    c.send({ t: 'speak', id: 10, items: [{ kind: 'line', trigger: 'voice.check_screen', index: 1 }] });
    c.send({ t: 'cancel', id: 10 });
    await settle();
    expect(c.msgs.some((m) => m.t === 'audio_end' && m.id === 10)).toBe(false);
    expect(await speechOf(p.id)).toHaveLength(1);
    // the Pan's speech never makes a player rest
    expect((await ready(p.cookie)).state).toEqual({ t: 'ready', state: { kind: 'available' } });
  });
});
