// M7 Ruling 17 (overrides P4/C2), Review Focus 4: the per-user voice block is server-held. A child flag in ANY of the
// user's conversations, or a Family Table report from the device, closes every voice socket of that user, refuses
// hello (conversationId null included) and refuses listen, whatever the device says. Another user is never affected.
import type { AddressInfo } from 'node:net';
import { VOICE_CLOSE_CODES } from '@kitchenquest/core';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/app.js';
import { NOTICES } from '../src/consent/notices.js';
import { CaptureMailer } from '../src/mail/mailer.js';
import { MEMORY_TTL_MS } from '../src/mentor/constants.js';
import type { Db } from '../src/types.js';
import { CHILD_BLOCK_TTL_MS, voiceRegistry } from '../src/voice/registry.js';
import { signIn } from './helpers/auth.js';
import { testConfig } from './helpers/config.js';
import { testDb } from './helpers/db.js';
import { connectVoice, FakeUpstream, type VoiceClient } from './helpers/fake-upstream.js';

const config = testConfig({ VOICE_ENABLED: 'true', VOICE_SERVICE_URL: 'ws://127.0.0.1:9', VOICE_SERVICE_TOKEN: 'test-token' });
const NOW = new Date('2026-11-12T10:00:00Z');
const CLOCK = { localDate: '2026-11-12', localTime: '10:00' };

let db: Db;
let closeDb: () => Promise<void>;
let app: FastifyInstance;
let mailer: CaptureMailer;
let upstream: FakeUpstream;
let port = 0;
let clock = NOW.getTime();
let seq = 0;
const clients: VoiceClient[] = [];

beforeAll(async () => {
  ({ db, close: closeDb } = await testDb());
  mailer = new CaptureMailer();
  upstream = new FakeUpstream();
  app = await buildApp({ config, db, mailer, ai: null, now: () => new Date(clock), logger: false, voiceUpstream: upstream });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await app?.close();
  await closeDb?.();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.ws.terminate();
  clock = NOW.getTime();
});

const call = (cookie: string, opts: InjectOptions) => app.inject({ ...opts, cookies: { kq_session: cookie } });
async function player(): Promise<{ cookie: string; id: string }> {
  const cookie = await signIn(app, mailer, `vblock${++seq}@example.com`);
  const res = await call(cookie, { method: 'POST', url: '/me/consents', payload: { purpose: 'voice', noticeVersion: NOTICES.voice!.version } });
  expect(res.statusCode).toBe(201);
  return { cookie, id: (await call(cookie, { method: 'GET', url: '/me' })).json<{ id: string }>().id };
}
async function hello(cookie: string, over: object = {}): Promise<VoiceClient> {
  const c = await connectVoice(port, { cookie });
  clients.push(c);
  c.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK, ...over });
  await c.next();
  return c;
}
/** Fix round 2: two installs of the game, each with its own random device id. */
const DEVICE_A = '0f1e2d3c-4b5a-4968-8776-655443322110';
const DEVICE_B = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const familyTable = (cookie: string, on: unknown, deviceId: string = DEVICE_A) => call(cookie, { method: 'PUT', url: '/voice/family-table', payload: { on, deviceId } });
const isReady = (c: VoiceClient) => c.msgs[0]?.t === 'ready';

describe('the registry (P3)', () => {
  test('the child block lasts the mentor child-flag TTL, then lifts; sweep drops it', () => {
    expect(CHILD_BLOCK_TTL_MS).toBe(MEMORY_TTL_MS);
    voiceRegistry.childFlagged('u-ttl', 1000);
    expect(voiceRegistry.blocked('u-ttl', 1000 + CHILD_BLOCK_TTL_MS - 1)).toBe('child');
    expect(voiceRegistry.blocked('u-ttl', 1000 + CHILD_BLOCK_TTL_MS)).toBeNull();
    voiceRegistry.childFlagged('u-ttl2', 0);
    voiceRegistry.sweep(CHILD_BLOCK_TTL_MS);
    expect(voiceRegistry.blocked('u-ttl2', 0)).toBeNull();
  });
});

describe('Ruling 17: both flags close every socket of the user', () => {
  test('a child flag in conversation A closes a socket that said hello with conversationId B, and one that said hello with null', async () => {
    const p = await player();
    const b = await hello(p.cookie, { conversationId: 'conversation-b' });
    expect(isReady(b)).toBe(true);
    // A second socket of the same user replaces the first (another_tab); so take each case on its own socket in turn.
    voiceRegistry.childFlagged(p.id, clock); // what mentor/turn.ts calls when a child flag is set in conversation A (Step 6)
    expect(await b.closed).toBe(VOICE_CLOSE_CODES.child);
    expect(b.msgs.at(-1)).toEqual({ t: 'closed', reason: 'child' });

    const q = await player();
    const n = await hello(q.cookie, { conversationId: null });
    expect(isReady(n)).toBe(true);
    n.send({ t: 'listen', id: 1, mode: 'hold' });
    n.frame(1);
    await new Promise((r) => setTimeout(r, 50));
    voiceRegistry.childFlagged(q.id, clock);
    expect(await n.closed).toBe(VOICE_CLOSE_CODES.child);
    // the utterance in flight was dropped upstream
    expect(upstream.utterances.at(-1)).toMatchObject({ cancelled: true });
  });

  test("hello with conversationId null while a child flag is set in any of the user's conversations → closed child", async () => {
    const p = await player();
    voiceRegistry.childFlagged(p.id, clock);
    for (const conversationId of [null, 'some-other-conversation']) {
      const c = await hello(p.cookie, { conversationId });
      expect(await c.closed).toBe(VOICE_CLOSE_CODES.child);
      expect(c.msgs).toEqual([{ t: 'closed', reason: 'child' }]);
    }
    // ... for the child-flag TTL; then voice opens again
    clock += CHILD_BLOCK_TTL_MS;
    expect(isReady(await hello(p.cookie))).toBe(true);
  });

  test('PUT /voice/family-table {on:true} closes the open socket with family_table; a new hello and a listen are refused even though that client sends familyTable:false (the device is wrong)', async () => {
    const p = await player();
    const c = await hello(p.cookie);
    expect(isReady(c)).toBe(true);
    expect((await familyTable(p.cookie, true)).statusCode).toBe(204);
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.family_table);
    expect(c.msgs.at(-1)).toEqual({ t: 'closed', reason: 'family_table' });
    const again = await hello(p.cookie, { familyTable: false });
    expect(await again.closed).toBe(VOICE_CLOSE_CODES.family_table);
    expect(again.msgs).toEqual([{ t: 'closed', reason: 'family_table' }]);
    // a listen sent straight after the hello never reaches the voice service
    const before = upstream.utterances.length;
    const sneaky = await connectVoice(port, { cookie: p.cookie });
    clients.push(sneaky);
    sneaky.send({ t: 'hello', v: 1, conversationId: null, familyTable: false, ...CLOCK });
    sneaky.send({ t: 'listen', id: 1, mode: 'hold' });
    sneaky.frame(1);
    sneaky.send({ t: 'end', id: 1 });
    expect(await sneaky.closed).toBe(VOICE_CLOSE_CODES.family_table);
    expect(upstream.utterances.length).toBe(before);
    // a listen on a socket that was open before the block is refused too
    expect((await familyTable(p.cookie, false)).statusCode).toBe(204);
    const open = await hello(p.cookie);
    expect(isReady(open)).toBe(true);
    voiceRegistry.setFamilyTable(p.id, true);
    expect(await open.closed).toBe(VOICE_CLOSE_CODES.family_table);
  });

  test('hello with familyTable:true sets the server flag; a device that never reported on cannot clear it (fix round 2); a device\'s on→off does, and voice opens again', async () => {
    const p = await player();
    const c = await hello(p.cookie, { familyTable: true });
    expect(await c.closed).toBe(VOICE_CLOSE_CODES.family_table);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    expect(await (await hello(p.cookie)).closed).toBe(VOICE_CLOSE_CODES.family_table);
    // B's start-up {on:false}: B never reported on, so nothing changes (the hello-added block stands: fail-safe).
    expect((await familyTable(p.cookie, false, DEVICE_B)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    // A device that turns Family Table on, then off, lifts it.
    expect((await familyTable(p.cookie, true, DEVICE_A)).statusCode).toBe(204);
    expect((await familyTable(p.cookie, false, DEVICE_A)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBeNull();
    const back = await hello(p.cookie);
    expect(isReady(back)).toBe(true);
    back.send({ t: 'listen', id: 1, mode: 'hold' });
    back.frame(1);
    back.send({ t: 'end', id: 1 });
    expect(await back.next((m) => m.t === 'transcript')).toMatchObject({ t: 'transcript', id: 1 });
  });

  test('another user is never affected by these flags', async () => {
    const blocked = await player();
    const other = await player();
    const theirs = await hello(other.cookie);
    expect(isReady(theirs)).toBe(true);
    voiceRegistry.childFlagged(blocked.id, clock);
    expect((await familyTable(blocked.cookie, true)).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect(theirs.ws.readyState).toBe(theirs.ws.OPEN);
    theirs.send({ t: 'listen', id: 1, mode: 'hold' });
    theirs.frame(1);
    theirs.send({ t: 'end', id: 1 });
    expect(await theirs.next((m) => m.t === 'transcript')).toMatchObject({ t: 'transcript', id: 1 });
    expect(voiceRegistry.blocked(other.id, clock)).toBeNull();
  });

  test('PUT /voice/family-table: strict body, signed in only', async () => {
    const p = await player();
    for (const bad of [
      { on: 'yes', deviceId: DEVICE_A }, { on: true, deviceId: DEVICE_A, extra: 1 }, {}, { on: true },
      // Fix round 2: the device id is strictly a UUID's shape, nothing else.
      { on: true, deviceId: 'not-a-uuid' }, { on: true, deviceId: DEVICE_A.toUpperCase() }, { on: true, deviceId: `${DEVICE_A}0` },
      { on: true, deviceId: 7 }, { on: true, deviceId: 'cook@example.com' }, { on: false, deviceId: '' },
    ]) {
      expect((await call(p.cookie, { method: 'PUT', url: '/voice/family-table', payload: bad })).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await app.inject({ method: 'PUT', url: '/voice/family-table', payload: { on: true, deviceId: DEVICE_A } })).statusCode).toBe(401);
    expect(voiceRegistry.blocked(p.id, clock)).toBeNull();
  });

  test('fix round 2: device B\'s {on:false} does not clear device A\'s block; A\'s own {on:false} does; with both on, the block lasts until both are off', async () => {
    const p = await player();
    expect((await familyTable(p.cookie, true, DEVICE_A)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    // B starts up, not in Family Table, and reports so: A's block stands.
    expect((await familyTable(p.cookie, false, DEVICE_B)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    expect(await (await hello(p.cookie)).closed).toBe(VOICE_CLOSE_CODES.family_table);
    // Both in Family Table: one leaving keeps the block.
    expect((await familyTable(p.cookie, true, DEVICE_B)).statusCode).toBe(204);
    expect((await familyTable(p.cookie, false, DEVICE_A)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    expect((await familyTable(p.cookie, false, DEVICE_B)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBeNull();
    expect(isReady(await hello(p.cookie))).toBe(true);
    // A device id is the user's own: another user's report with the same id never touches this one.
    const q = await player();
    expect((await familyTable(p.cookie, true, DEVICE_A)).statusCode).toBe(204);
    expect((await familyTable(q.cookie, false, DEVICE_A)).statusCode).toBe(204);
    expect(voiceRegistry.blocked(p.id, clock)).toBe('family_table');
    expect((await familyTable(p.cookie, false, DEVICE_A)).statusCode).toBe(204);
  });
});
