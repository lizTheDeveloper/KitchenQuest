import { HANDS_FREE_IDLE_MS, MAX_UTTERANCE_MS, PRE_ROLL_MS, VAD_HANGOVER_MS, FRAME_MS, decodeFrame } from '@kitchenquest/core/engine';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createStore, type PlayerStore } from '../state/store';
import { RESUME_TIMEOUT_MS } from './capture';
import { createVoiceController, type VoiceController, type VoicePhase } from './controller';
import { TIMER_TAIL_MS, type Vad } from './vad';
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

function rig(opts: { familyTable?: boolean; voiceOn?: boolean; vad?: () => Vad } = {}): Rig {
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
      ...(opts.vad ? { createVad: opts.vad } : {}),
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

// Hands-free is a build switch (C9; fix round 1, M7): these tests run as a VITE_HANDS_FREE=on build.
beforeEach(() => { vi.stubEnv('VITE_HANDS_FREE', 'on'); });
afterEach(() => { vi.unstubAllEnvs(); });

/** Captures the window's timers (the hands-free idle timer is the window's). */
function windowTimers(r: Rig) {
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const w = r.audio.win as unknown as { setTimeout: unknown; clearTimeout: unknown };
  w.setTimeout = (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  w.clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  return { idle: () => timers.filter((t) => t.ms === HANDS_FREE_IDLE_MS && !t.cleared), all: timers };
}

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

  test('M7 Step 10: onMic tells when the microphone opens and closes (the Listening pill), in hands-free and on a press; nothing before it opens', async () => {
    const r = rig();
    const c = r.make();
    const seen: boolean[] = [];
    c.onMic((open) => seen.push(open));
    c.startHandsFree();
    expect(seen).toEqual([]); // no hello answered, no microphone yet
    await ready(r);
    expect(seen).toEqual([true]);
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    frame(r, -60, 10);
    expect(seen).toEqual([true]); // frames don't repeat it
    c.stopHandsFree();
    expect(seen).toEqual([true, false]);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    c.press();
    await flush();
    expect(seen).toEqual([true, false, true]);
    c.close();
    expect(seen).toEqual([true, false, true, false]);
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
    frame(r, -60, TIMER_TAIL_MS / FRAME_MS); // the alarm's echo tail (fix round 1, I2)
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

  test('fix round 1 (I1): the reviewer\'s probe, a minute of a steady fan in hands-free: bounded audio leaves, real speech over the fan is heard, and hands-free still times out', async () => {
    const r = rig();
    const timers = windowTimers(r);
    const c = r.make();
    const offs: string[] = [];
    c.onHandsFreeOff((w) => offs.push(w));
    c.startHandsFree();
    const ws = await ready(r);
    frame(r, -60, 50);
    frame(r, -40, 3000); // the extractor fan, for a minute
    // Bounded: no more than five seconds of the fan left the device.
    expect(ws.frames().length * FRAME_MS).toBeLessThan(5000);
    // The service heard nothing it could use in the fan (failed stt): no transcript, so the idle timer is not re-armed.
    for (const m of ws.json().filter((x) => x.t === 'listen')) ws.serverSend({ t: 'failed', id: m.id, kind: 'stt' });
    await flush();
    // Recovered: the player over the fan starts a new listen, with frames.
    const listensBefore = ws.json().filter((m) => m.t === 'listen').length;
    const framesBefore = ws.frames().length;
    frame(r, -15, 30);
    frame(r, -40, 30);
    expect(ws.json().filter((m) => m.t === 'listen').length).toBe(listensBefore + 1);
    expect(ws.frames().length).toBeGreaterThan(framesBefore);
    // Times out: noise never re-armed the idle timer (only a transcript does), so the one armed at start still runs.
    expect(timers.idle()).toHaveLength(1);
    timers.idle()[0].fn();
    expect(c.handsFree).toBe(false);
    expect(offs).toEqual(['idle']);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
  });

  test('fix round 1 (I1): only a real transcript re-arms the idle timer; an empty one does not', async () => {
    const r = rig();
    const timers = windowTimers(r);
    const c = r.make();
    c.startHandsFree();
    const ws = await ready(r);
    const speak = async (answer: unknown) => {
      frame(r, -60, 50);
      frame(r, -20, 20);
      frame(r, -60, 20);
      const id = ws.json().filter((m) => m.t === 'listen').at(-1)!.id;
      ws.serverSend(answer === null ? { t: 'failed', id, kind: 'stt' } : { t: 'transcript', id, text: answer });
      await flush();
    };
    const armed = () => timers.all.filter((t) => t.ms === HANDS_FREE_IDLE_MS).length;
    const start = armed();
    await speak(null);
    expect(armed()).toBe(start);
    await speak('next step');
    expect(armed()).toBe(start + 1);
  });

  test('fix round 1 (I1): utterances that hit the cap back to back turn hands-free off ("noise")', async () => {
    // A scripted VAD: every utterance runs to the cap.
    let n = 0;
    const capping = (): Vad => ({
      push: (pcm) => {
        n++;
        if (n % 100 === 1) return { start: [pcm] };
        if (n % 100 === 0) return { speech: pcm, end: true, capped: true };
        return { speech: pcm };
      },
      setRaised: () => undefined,
    });
    const r = rig({ vad: capping });
    const c = r.make();
    const offs: string[] = [];
    c.onHandsFreeOff((w) => offs.push(w));
    c.startHandsFree();
    await ready(r);
    frame(r, -40, 100);
    expect(c.handsFree).toBe(true); // one capped utterance is not yet noise
    frame(r, -40, 100);
    expect(c.handsFree).toBe(false);
    expect(offs).toEqual(['noise']);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
  });

  test('fix round 1 (M1): the page hidden mid-press releases the press: end is sent and the microphone closes', async () => {
    const r = rig();
    const c = r.make();
    c.press();
    const ws = await ready(r);
    frame(r, -20, 5);
    r.doc.visibilityState = 'hidden';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    expect(ws.json().at(-1)).toMatchObject({ t: 'end' });
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    const sent = ws.frames().length;
    frame(r, -20, 5);
    expect(ws.frames().length).toBe(sent);
  });

  test('fix round 1 (M2): after a terminal close (consent_required, signed_out, bad_origin, unavailable) say() and press() open nothing; network may try again', async () => {
    for (const [reason, code] of [['consent_required', 4412], ['signed_out', 4401], ['bad_origin', 4403], ['unavailable', 4503]] as const) {
      const r = rig();
      const c = r.make();
      const problems: string[] = [];
      c.onProblem((p) => problems.push(p));
      c.say({ items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], said: [] });
      const ws = await ready(r);
      ws.serverSend({ t: 'closed', reason });
      ws.serverClose(code);
      await flush();
      c.say({ items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], said: [] });
      c.press();
      c.startHandsFree();
      await flush();
      expect(r.sockets, reason).toHaveLength(1);
      expect(r.audio.getUserMedia.calls, reason).toHaveLength(0);
      expect(problems[0], reason).toBe(reason);
      expect(problems.length, reason).toBeGreaterThan(1); // the press is told why
    }
    const n = rig();
    const c = n.make();
    c.say({ items: [{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], said: [] });
    const ws = await ready(n);
    ws.serverClose(1006);
    await flush();
    c.press();
    await flush();
    expect(n.sockets).toHaveLength(2);
  });

  test('fix round 1 (M3): speech that starts while the last transcript is out is sent once it arrives, never lost', async () => {
    const r = rig();
    const c = r.make();
    const got: string[] = [];
    c.onTranscript((t) => got.push(t));
    c.startHandsFree();
    const ws = await ready(r);
    frame(r, -60, 50);
    frame(r, -20, 20);
    frame(r, -60, 40); // ends: transcribing (and a pause longer than the pre-roll)
    const first = ws.json().filter((m) => m.t === 'listen')[0].id;
    expect(c.phase).toBe('transcribing');
    frame(r, -20, 20); // the player goes on before the transcript is back
    frame(r, -60, 20);
    expect(ws.json().filter((m) => m.t === 'listen')).toHaveLength(1);
    ws.serverSend({ t: 'transcript', id: first, text: 'next step' });
    await flush();
    const listens = ws.json().filter((m) => m.t === 'listen');
    expect(listens).toHaveLength(2);
    const second = listens[1].id as number;
    expect(ws.frames().filter((f) => decodeFrame(f)!.id === second).length).toBe(PRE_ROLL_MS / FRAME_MS + 20 + VAD_HANGOVER_MS / FRAME_MS);
    expect(ws.json().at(-1)).toEqual({ t: 'end', id: second });
    expect(got).toEqual(['next step']);
  });

  test('fix round 1 (M7): startHandsFree does nothing in a build without VITE_HANDS_FREE=on (C9)', async () => {
    vi.stubEnv('VITE_HANDS_FREE', '');
    const r = rig();
    const c = r.make();
    c.startHandsFree();
    await flush();
    expect(c.handsFree).toBe(false);
    expect(r.sockets).toHaveLength(0);
    expect(r.audio.getUserMedia.calls).toHaveLength(0);
    expect(MAX_UTTERANCE_MS).toBe(30_000);
  });

  test('fix round 2 (R1): while the microphone\'s resume never settles, close, the Family Table guard, release and hands-free stop each stop the tracks at once; a timeout stops them and says microphone', async () => {
    const hung = async (act: (r: Rig, c: VoiceController) => void, mode: 'press' | 'handsFree') => {
      const r = rig();
      r.audio.startSuspended = true;
      r.audio.resumeHangs = true;
      const c = r.make();
      if (mode === 'press') c.press(); else c.startHandsFree();
      await ready(r);
      expect(r.audio.tracks.length).toBeGreaterThan(0);
      expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
      act(r, c);
      expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    };
    await hung((_r, c) => { c.close('child'); }, 'press');
    await hung((r) => { r.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } })); }, 'press');
    await hung((_r, c) => { c.release(); }, 'press');
    await hung((_r, c) => { c.stopHandsFree(); }, 'handsFree');
    // The timeout: the tracks stop and the player hears the microphone line.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const r = rig();
      r.audio.startSuspended = true;
      r.audio.resumeHangs = true;
      const c = r.make();
      const problems: string[] = [];
      c.onProblem((p) => problems.push(p));
      c.press();
      await ready(r);
      await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS + 1);
      await flush();
      expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
      expect(problems).toContain('microphone');
      expect(c.phase).toBe('idle');
    } finally { vi.useRealTimers(); }
  });

  test('fix round 2 (F3): a second hands-free start while the transcript is out keeps the first held speech too', async () => {
    const r = rig();
    const c = r.make();
    c.startHandsFree();
    const ws = await ready(r);
    frame(r, -60, 50);
    frame(r, -20, 20);
    frame(r, -60, 40); // the first utterance ends: transcribing
    const first = ws.json().filter((m) => m.t === 'listen')[0].id;
    frame(r, -20, 20); // held speech 1
    frame(r, -60, 40);
    frame(r, -20, 20); // held speech 2
    frame(r, -60, 40);
    ws.serverSend({ t: 'transcript', id: first, text: 'next step' });
    await flush();
    const listens = ws.json().filter((m) => m.t === 'listen');
    expect(listens).toHaveLength(2);
    const second = listens[1].id as number;
    const each = PRE_ROLL_MS / FRAME_MS + 20 + VAD_HANGOVER_MS / FRAME_MS;
    expect(ws.frames().filter((f) => decodeFrame(f)!.id === second).length).toBe(2 * each);
  });

  test('Step 9 carry (G1): a press, or a hands-free start, in the mic-start window after a release opens the microphone afresh; hands-free is never on with no microphone', async () => {
    const r = rig();
    r.audio.startSuspended = true;
    r.audio.resumeAfterMs = 60;
    const c = r.make();
    const problems: string[] = [];
    c.onProblem((p) => problems.push(p));
    c.press();
    const ws = await ready(r);
    c.release(); // the first open's tracks are stopped while its context is still starting
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    c.press(); // within the same window
    await new Promise((res) => setTimeout(res, 200));
    await flush();
    // Not silently dead: a second microphone, live, and a listen on its way.
    expect(r.audio.getUserMedia.calls).toHaveLength(2);
    expect(r.audio.tracks.slice(2).every((t) => !t.stopped)).toBe(true);
    expect(ws.json().filter((m) => m.t === 'listen')).toHaveLength(1);
    expect(c.phase).toBe('listening');
    expect(problems).toEqual([]);
    c.close();
    // Hands-free: stop then start in the window → on, with a live microphone.
    const h = rig();
    h.audio.startSuspended = true;
    h.audio.resumeAfterMs = 60;
    const hc = h.make();
    hc.startHandsFree();
    await ready(h);
    hc.stopHandsFree();
    hc.startHandsFree();
    await new Promise((res) => setTimeout(res, 200));
    await flush();
    expect(hc.handsFree).toBe(true);
    expect(h.audio.tracks.some((t) => !t.stopped)).toBe(true);
    // Refused outright meanwhile: hands-free turns off and the player is told, never "on" and deaf.
    const d = rig();
    const dc = d.make();
    const dp: string[] = [];
    dc.onProblem((p) => dp.push(p));
    const offs: string[] = [];
    dc.onHandsFreeOff((w) => offs.push(w));
    d.audio.fail.gum = new Error('NotAllowedError');
    dc.startHandsFree();
    await ready(d);
    await flush();
    expect(dc.handsFree).toBe(false);
    expect(offs).toEqual(['stopped']);
    expect(dp).toEqual(['microphone']);
  });

  test('Step 9 carry (G2): no microphone problem after the player already let go (the start times out after the release)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      const r = rig();
      r.audio.startSuspended = true;
      r.audio.resumeHangs = true;
      const c = r.make();
      const problems: string[] = [];
      c.onProblem((p) => problems.push(p));
      c.press();
      await ready(r);
      c.release();
      await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS + 1);
      await flush();
      expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
      expect(problems).toEqual([]);
      expect(c.phase).toBe('idle');
      // Positive control: still held when it times out → the problem is reported.
      const h = rig();
      h.audio.startSuspended = true;
      h.audio.resumeHangs = true;
      const hc = h.make();
      const hp: string[] = [];
      hc.onProblem((p) => hp.push(p));
      hc.press();
      await ready(h);
      await vi.advanceTimersByTimeAsync(RESUME_TIMEOUT_MS + 1);
      await flush();
      expect(hp).toEqual(['microphone']);
    } finally { vi.useRealTimers(); }
  });

  test('Step 9 carry (G3): a device-only child flag closes a microphone that is still starting, at once (tracks handed over: stopped, controller closed)', async () => {
    const r = rig();
    const release = r.audio.hold(); // the permission prompt is up
    const c = r.make();
    c.press();
    await ready(r);
    r.child.on = true; // set on the device only: no store change, no server close, no frame yet
    release();
    await flush();
    expect(r.audio.tracks.length).toBeGreaterThan(0);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    expect(c.closedReason).toBe('child');
    expect(r.sockets.at(-1)!.json().filter((m) => m.t === 'listen')).toHaveLength(0);
  });

  test('fix round 1 (I-3), round 3 (I-A): a permission refusal answered after the player let go is still reported; an allow after release opens nothing and says the microphone is ready', async () => {
    const r = rig();
    const answer = r.audio.hold(); // the browser's permission prompt: the player lets go to answer it
    const c = r.make();
    const problems: string[] = [];
    c.onProblem((p) => problems.push(p));
    c.press();
    await ready(r);
    c.release();
    r.audio.fail.gum = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    answer();
    await flush();
    expect(problems).toEqual(['microphone']);
    expect(c.phase).toBe('idle');
    // Allowed after release: the tracks are stopped as they arrive, and nothing is reported (no error).
    const a = rig();
    const allow = a.audio.hold();
    const ac = a.make();
    const ap: string[] = [];
    ac.onProblem((p) => ap.push(p));
    let readyCues = 0;
    ac.onMicReady(() => { readyCues++; });
    ac.press();
    const ws = await ready(a);
    ac.release();
    allow();
    await flush();
    expect(ap).toEqual([]);
    // I-A: the grant is never silent: one cue, so the player knows to press again.
    expect(readyCues).toBe(1);
    expect(a.audio.tracks.length).toBeGreaterThan(0);
    expect(a.audio.tracks.every((t) => t.stopped)).toBe(true);
    expect(ws.json().filter((m) => m.t === 'listen')).toHaveLength(0);
  });

  test('fix round 3 (I-A): no ready cue when the player is still holding (the mic is used), or once the controller closed', async () => {
    const r = rig();
    const c = r.make();
    let cues = 0;
    c.onMicReady(() => { cues++; });
    c.press();
    await ready(r);
    await flush();
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    c.release();
    await flush();
    expect(cues).toBe(0);
    const k = rig();
    const allow = k.audio.hold();
    const kc = k.make();
    let kcues = 0;
    kc.onMicReady(() => { kcues++; });
    kc.press();
    await ready(k);
    kc.close('child');
    allow();
    await flush();
    expect(kcues).toBe(0);
  });
});
