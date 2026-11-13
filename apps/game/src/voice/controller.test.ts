import { HANDS_FREE_IDLE_MS, PRE_ROLL_MS, VAD_HANGOVER_MS, FRAME_MS, decodeFrame } from '@kitchenquest/core/engine';
import { describe, expect, test } from 'vitest';
import { createStore, type PlayerStore } from '../state/store';
import { createVoiceController, type VoiceController, type VoicePhase } from './controller';
import { fakeAudio, socketWin, type FakeAudio, type FakeWebSocket } from './fakes.fixture';
import type { Player } from './playback';
import { serviceProvider, type VoiceProvider } from './providers';

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

/** A Storage held in a Map (the store's and the page's localStorage). */
function memStorage(): Storage & { dump(): string } {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
    dump: () => JSON.stringify([...m.entries()].sort()),
  };
}

function fakePlayer(): Player & { plays: number; stops: number } {
  const idle = new Set<() => void>();
  let speaking = false;
  const p = {
    plays: 0, stops: 0,
    play() { p.plays++; speaking = true; },
    stop() { p.stops++; if (speaking) { speaking = false; for (const fn of [...idle]) fn(); } },
    get speaking() { return speaking; },
    onIdle(fn: () => void) { idle.add(fn); return () => { idle.delete(fn); }; },
  };
  return p;
}

interface Rig {
  store: PlayerStore; storage: ReturnType<typeof memStorage>; page: ReturnType<typeof memStorage>;
  audio: FakeAudio; sockets: FakeWebSocket[]; provider: VoiceProvider; player: ReturnType<typeof fakePlayer>;
  child: { on: boolean }; sizzles: number[]; doc: EventTarget & { visibilityState: string };
  make(): VoiceController;
}

function rig(opts: { familyTable?: boolean; voiceOn?: boolean } = {}): Rig {
  const storage = memStorage();
  const page = memStorage();
  const store = createStore(storage);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, settings: { ...s.settings, familyTable: opts.familyTable ?? false, voice: { ...s.settings.voice, on: opts.voiceOn ?? true } } }));
  const sw = socketWin();
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const audio = fakeAudio({ location: sw.win.location, WebSocket: (sw.win as unknown as { WebSocket: unknown }).WebSocket, setTimeout, clearTimeout, localStorage: page, document: doc });
  const player = fakePlayer();
  const provider = serviceProvider(audio.win, store, { player, now: () => new Date(2026, 10, 13, 18, 5) });
  const child = { on: false };
  const sizzles: number[] = [];
  const r: Rig = {
    store, storage, page, audio, sockets: sw.sockets, provider, player, child, sizzles, doc,
    make: () => createVoiceController({
      win: audio.win, store, provider, conversationId: () => 'conv-1', childOn: () => child.on,
      earcon: () => sizzles.push(audio.getUserMedia.calls.length),
    }),
  };
  return r;
}

/** The socket answers hello `ready` with `state`. */
async function ready(r: Rig, state: unknown = { kind: 'available' }) {
  await flush();
  const ws = r.sockets.at(-1)!;
  if (ws.readyState === 0) ws.open();
  ws.serverSend({ t: 'ready', state });
  await flush();
  return ws;
}
const frame = (r: Rig, db: number, n = 1) => { for (let i = 0; i < n; i++) r.audio.nodes.at(-1)!.port.emit(new Int16Array(320).fill(db > -30 ? 3000 : 3), db); };
const phases = (c: VoiceController) => { const seen: VoicePhase[] = []; c.onPhase((p) => seen.push(p)); return seen; };
const sentTypes = (ws: FakeWebSocket) => ws.json().map((m) => m.t);

describe('createVoiceController', () => {
  test('constructing in Family Table mode throws; getUserMedia is never called and no socket opened (spies)', () => {
    const r = rig({ familyTable: true });
    expect(() => r.make()).toThrow(/Family Table/);
    expect(r.audio.getUserMedia.calls).toHaveLength(0);
    expect(r.sockets).toHaveLength(0);
    // The same for a child, voice off, and signed out.
    const c = rig();
    c.child.on = true;
    expect(() => c.make()).toThrow(/child/);
    expect(() => rig({ voiceOn: false }).make()).toThrow(/voice is off/);
    const out = rig();
    out.store.update((s) => ({ ...s, account: null }));
    expect(() => out.make()).toThrow(/signed in/);
    for (const x of [c, out]) { expect(x.audio.getUserMedia.calls).toHaveLength(0); expect(x.sockets).toHaveLength(0); }
    // Positive control: a grown-up, signed in, voice on, may.
    expect(() => rig().make()).not.toThrow();
  });

  test('Family Table on, voice off, or childOn() true while listening → every track stopped and the socket closed at once; nothing more sent', async () => {
    const triggers: [string, (r: Rig) => void, string][] = [
      ['family table', (r) => r.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } })), 'family_table'],
      ['voice off', (r) => r.store.update((s) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, on: false } } })), 'off'],
      ['child', (r) => { r.child.on = true; }, 'child'],
      ['signed out', (r) => r.store.update((s) => ({ ...s, account: null })), 'signed_out'],
    ];
    for (const [name, trigger, why] of triggers) {
      const r = rig();
      const c = r.make();
      const closedFor: string[] = [];
      c.onPhase((p) => { if (p === 'off') closedFor.push(name); });
      c.press();
      const ws = await ready(r);
      expect(r.audio.tracks.length, name).toBeGreaterThan(0);
      frame(r, -20, 5);
      expect(ws.frames().length, name).toBe(5);
      trigger(r);
      // The child flag lives outside the store: the very next frame finds it.
      frame(r, -20, 1);
      expect(r.audio.tracks.every((t) => t.stopped), name).toBe(true);
      expect(ws.readyState, name).toBe(3);
      expect(c.phase, name).toBe('off');
      expect(c.closedReason, name).toBe(why);
      expect(closedFor, name).toEqual([name]);
      const sent = ws.sent.length;
      frame(r, -20, 5);
      c.release();
      c.press();
      c.say({ items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], said: [] });
      c.startHandsFree();
      await flush();
      expect(ws.sent.length, name).toBe(sent);
      expect(ws.frames().length, name).toBe(5);
      expect(r.sockets, name).toHaveLength(1);
      expect(r.audio.getUserMedia.calls, name).toHaveLength(1);
    }
  });

  test('a microphone still opening when Family Table turns on is stopped the moment it arrives', async () => {
    const r = rig();
    const c = r.make();
    const release = r.audio.hold();
    c.press();
    await ready(r);
    expect(r.audio.getUserMedia.calls).toHaveLength(1);
    r.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    release();
    await flush();
    expect(r.audio.tracks.length).toBeGreaterThan(0);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    expect(c.phase).toBe('off');
  });

  test('press while speaking = barge-in: playback stops, cancel sent, a new utterance starts', async () => {
    const r = rig();
    const c = r.make();
    const seen = phases(c);
    c.say({ items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], said: [] });
    const ws = await ready(r);
    const speak = ws.json().find((m) => m.t === 'speak')!;
    ws.serverSend({ t: 'audio_start', id: speak.id, sampleRate: 22_050 });
    ws.serverBinary(new Uint8Array([0, 0, 0, speak.id as number, 1, 0]));
    expect(r.player.plays).toBe(1);
    expect(c.phase).toBe('speaking');
    c.press();
    expect(r.player.speaking).toBe(false);
    expect(ws.json().at(-1)).toEqual({ t: 'cancel', id: speak.id });
    await flush();
    const listen = ws.json().at(-1)!;
    expect(listen).toMatchObject({ t: 'listen', mode: 'hold' });
    expect(listen.id).not.toBe(speak.id);
    expect(c.phase).toBe('listening');
    expect(seen).toEqual(['speaking', 'listening']);
    // Audio still arriving for the cancelled speech is never played.
    ws.serverBinary(new Uint8Array([0, 0, 0, speak.id as number, 1, 0]));
    expect(r.player.plays).toBe(1);
  });

  test('hold-to-talk: every frame from press to release is sent under a fresh id, then end; the transcript is delivered with its id', async () => {
    const r = rig();
    const c = r.make();
    const got: [string, boolean, number][] = [];
    c.onTranscript((t, long, id) => got.push([t, long, id]));
    c.press();
    const ws = await ready(r);
    frame(r, -60, 3); // a quiet start still goes: the press says the player is talking
    frame(r, -20, 10);
    c.release();
    expect(c.phase).toBe('transcribing');
    const listen = ws.json().find((m) => m.t === 'listen')!;
    expect(ws.frames().map((f) => decodeFrame(f)!.id)).toEqual(Array(13).fill(listen.id));
    expect(ws.json().at(-1)).toEqual({ t: 'end', id: listen.id });
    // The microphone closes on release (hold-to-talk keeps it only while held).
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    ws.serverSend({ t: 'transcript', id: listen.id, text: 'next step' });
    await flush();
    expect(got).toEqual([['next step', false, listen.id]]);
    expect(c.lastUtteranceId).toBe(listen.id);
    expect(c.phase).toBe('waiting');
    // A second press: a new id, never the old one.
    c.press();
    await flush();
    const second = ws.json().filter((m) => m.t === 'listen').at(-1)!;
    expect(second.id).not.toBe(listen.id);
  });

  test('startHandsFree: frames are sent only from pre-roll to end; a minute of hiss sends nothing', async () => {
    const r = rig();
    const c = r.make();
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    c.startHandsFree();
    const ws = await ready(r);
    expect(c.handsFree).toBe(true);
    frame(r, -60, 3000); // a minute of a quiet kitchen's hiss
    expect(ws.frames()).toHaveLength(0);
    expect(sentTypes(ws)).toEqual(['hello']);
    frame(r, -20, 30); // 600 ms of speech
    frame(r, -60, 50);
    const listen = ws.json().find((m) => m.t === 'listen')!;
    expect(listen.mode).toBe('handsFree');
    // Pre-roll, the speech, and the hangover: nothing before or after.
    expect(ws.frames()).toHaveLength(PRE_ROLL_MS / FRAME_MS + 30 + VAD_HANGOVER_MS / FRAME_MS);
    expect(ws.json().at(-1)).toEqual({ t: 'end', id: listen.id });
    ws.serverSend({ t: 'transcript', id: listen.id, text: 'next step' });
    await flush();
    expect(got).toEqual(['next step']);
    // The microphone stays open in hands-free; stopping it closes it.
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    c.stopHandsFree();
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    expect(c.handsFree).toBe(false);
  });

  test('hands-free turns itself off when the page is hidden, and after HANDS_FREE_IDLE_MS with no speech', async () => {
    const r = rig();
    const c = r.make();
    const offs: string[] = [];
    c.onHandsFreeOff((why) => offs.push(why));
    c.startHandsFree();
    await ready(r);
    r.doc.visibilityState = 'hidden';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    expect(c.handsFree).toBe(false);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    // Idle: the timer is the window's.
    const timers: { fn: () => void; ms: number }[] = [];
    const t = rig();
    (t.audio.win as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; };
    (t.audio.win as unknown as { clearTimeout: unknown }).clearTimeout = () => undefined;
    const c2 = t.make();
    c2.onHandsFreeOff((why) => offs.push(why));
    c2.startHandsFree();
    await ready(t);
    const idle = timers.filter((x) => x.ms === HANDS_FREE_IDLE_MS).at(-1)!;
    idle.fn();
    expect(c2.handsFree).toBe(false);
    expect(offs).toEqual(['hidden', 'idle']);
  });

  test('timerSounding raises the threshold (B9): speech at the normal level while the alarm sounds sends nothing', async () => {
    const r = rig();
    const c = r.make();
    c.startHandsFree();
    const ws = await ready(r);
    frame(r, -60, 50);
    c.timerSounding(true);
    frame(r, -45, 50); // 15 dB over the floor: speech normally, not over the raised threshold
    frame(r, -60, 30);
    expect(ws.frames()).toHaveLength(0);
    c.timerSounding(false);
    frame(r, -45, 20);
    expect(ws.frames().length).toBeGreaterThan(0);
  });

  test('release plays the sizzle at once; a resting state → phase resting and no mic', async () => {
    const r = rig();
    const c = r.make();
    c.press();
    const ws = await ready(r);
    frame(r, -20, 5);
    expect(r.sizzles).toHaveLength(0);
    c.release();
    expect(r.sizzles).toHaveLength(1); // synchronously, before any answer
    expect(sentTypes(ws).at(-1)).toBe('end');
    // Resting from the first hello: no microphone at all.
    const t = rig();
    const c2 = t.make();
    c2.press();
    await ready(t, { kind: 'resting', until: '2026-12-01' });
    expect(c2.phase).toBe('resting');
    expect(t.audio.getUserMedia.calls).toHaveLength(0);
    c2.release();
    expect(t.sizzles).toHaveLength(0);
    // A listen the allowance refuses later: resting, the mic closed, no transcript.
    const u = rig();
    const c3 = u.make();
    const got: string[] = [];
    c3.onTranscript((x) => got.push(x));
    c3.press();
    const ws3 = await ready(u);
    frame(u, -20, 3);
    ws3.serverSend({ t: 'state', state: { kind: 'resting_today' } });
    await flush();
    expect(c3.phase).toBe('resting');
    expect(c3.state).toEqual({ kind: 'resting_today' });
    expect(u.audio.tracks.every((x) => x.stopped)).toBe(true);
    c3.release();
    await flush();
    expect(got).toEqual([]);
  });

  test('a socket drop mid-utterance → phase idle, no onTranscript, nothing retried (Review Focus 5)', async () => {
    const r = rig();
    const c = r.make();
    const got: string[] = [];
    const problems: string[] = [];
    c.onTranscript((t) => got.push(t));
    c.onProblem((p) => problems.push(p));
    c.press();
    const ws = await ready(r);
    frame(r, -20, 10);
    const before = ws.frames().length;
    ws.serverClose(1006);
    await flush();
    expect(c.phase).toBe('idle');
    expect(problems).toEqual(['network']);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    frame(r, -20, 5);
    c.release();
    await flush();
    expect(got).toEqual([]);
    expect(r.sockets).toHaveLength(1); // nothing reopened, nothing resent
    expect(ws.frames().length).toBe(before);
    // The next press is a new socket and a new listen, never the old frames.
    c.press();
    const ws2 = await ready(r);
    expect(r.sockets).toHaveLength(2);
    expect(ws2.frames()).toHaveLength(0);
  });

  test('no transcript or frame is written to the store or localStorage: snapshots before/after, with a positive control that writes one and fails (D1)', async () => {
    const SPOKEN = 'i am allergic to sesame';
    /** Runs a whole utterance to its transcript; returns what changed in storage, and whether the transcript came. */
    const run = async (leak: boolean) => {
      const r = rig();
      const snap = () => JSON.stringify(r.store.get()) + r.storage.dump() + r.page.dump();
      const c = r.make();
      await flush();
      const before = snap();
      let reached = false;
      c.onTranscript((t) => {
        reached = true;
        // The leaking fake: a careless listener that keeps what was heard.
        if (leak) r.page.setItem('kq.last-heard', t);
      });
      c.press();
      const ws = await ready(r);
      frame(r, -20, 20);
      c.release();
      const id = ws.json().find((m) => m.t === 'listen')!.id;
      ws.serverSend({ t: 'transcript', id, text: SPOKEN });
      await flush();
      c.close();
      const after = snap();
      return { reached, kept: before !== after, holdsWords: after.includes(SPOKEN) };
    };
    const clean = await run(false);
    expect(clean.reached).toBe(true);
    expect(clean.kept).toBe(false);
    expect(clean.holdsWords).toBe(false);
    const leaky = await run(true);
    expect(leaky.reached).toBe(true);
    expect(leaky.kept).toBe(true);
    expect(leaky.holdsWords).toBe(true);
  });
});
