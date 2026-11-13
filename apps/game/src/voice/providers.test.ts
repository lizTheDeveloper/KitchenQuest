import { decodeFrame, encodeFrame, MAX_SPEAK_ITEMS, type SpeakItem } from '@kitchenquest/core/engine';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createStore } from '../state/store';
import { socketWin, type FakeWebSocket } from './fakes.fixture';
import type { Player } from './playback';
import { devBrowserProvider, handsFreeBuild, providerKind, serviceProvider } from './providers';

afterEach(() => { vi.unstubAllEnvs(); });
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const T = new Date(2026, 10, 13, 18, 5); // local time

function fakePlayer() {
  const played: [number, number, number][] = [];
  const idle = new Set<() => void>();
  let stopped = 0;
  let speaking = false;
  const player: Player & { finish(): void; stopped(): number } = {
    play: (id, pcm, rate) => { played.push([id, pcm.length, rate]); speaking = true; },
    stop: () => { stopped++; if (speaking) { speaking = false; for (const fn of [...idle]) fn(); } },
    get speaking() { return speaking; },
    onIdle: (fn) => { idle.add(fn); return () => { idle.delete(fn); }; },
    finish: () => { speaking = false; for (const fn of [...idle]) fn(); },
    stopped: () => stopped,
  };
  return { player, played };
}

async function setup(opts: { familyTable?: boolean } = {}) {
  const store = createStore(null);
  if (opts.familyTable) store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
  const { win, sockets } = socketWin();
  const { player, played } = fakePlayer();
  const provider = serviceProvider(win, store, { player, now: () => T });
  const hello = provider.hello('conv-1', '2026-11-13');
  await flush();
  const ws: FakeWebSocket = sockets[0];
  ws.open();
  ws.serverSend({ t: 'ready', state: { kind: 'available' } });
  return { provider, ws, sockets, player, played, store, state: await hello };
}

describe('serviceProvider', () => {
  test('hello carries familyTable from the store, the player\'s local date and time, and the conversation', async () => {
    const { ws, state } = await setup();
    expect(state).toEqual({ kind: 'available' });
    expect(ws.json()[0]).toEqual({ t: 'hello', v: 1, conversationId: 'conv-1', localDate: '2026-11-13', localTime: '18:05', familyTable: false });
    const store = createStore(null);
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    const { win, sockets } = socketWin();
    void serviceProvider(win, store, { player: fakePlayer().player, now: () => T }).hello(null, '2026-11-13').catch(() => undefined);
    await flush();
    sockets[0].open();
    expect(sockets[0].json()[0]).toMatchObject({ conversationId: null, familyTable: true });
  });

  test('serviceProvider maps listen/end/cancel/speak to the protocol; a closed socket ends the utterance with text ""', async () => {
    const { provider, ws, played, player } = await setup();
    const u = provider.listen('hold');
    u.push(Int16Array.from([1, 2]));
    const ended = u.end();
    expect(ws.json().slice(1)).toEqual([{ t: 'listen', id: u.id, mode: 'hold' }, { t: 'end', id: u.id }]);
    expect(decodeFrame(ws.frames()[0])?.id).toBe(u.id);
    // Another listen's transcript is not this one's (replies are matched by id).
    ws.serverSend({ t: 'transcript', id: u.id + 100, text: 'nope' });
    ws.serverSend({ t: 'transcript', id: u.id, text: 'next step' });
    await expect(ended).resolves.toEqual({ text: 'next step', tooLong: false });
    // Pushing after end sends nothing.
    const frames = ws.frames().length;
    u.push(Int16Array.from([3]));
    expect(ws.frames().length).toBe(frames);

    // too_long, then the transcript of what came.
    const long = provider.listen('hold');
    ws.serverSend({ t: 'too_long', id: long.id });
    long.push(Int16Array.from([9])); // the API has ended it: not sent
    expect(ws.frames().length).toBe(frames);
    const longEnd = long.end();
    ws.serverSend({ t: 'transcript', id: long.id, text: 'a very long story' });
    await expect(longEnd).resolves.toEqual({ text: 'a very long story', tooLong: true });

    // M7 Step 11 (F4-1): a too_long with `safety` is the final answer (no transcript follows): it ends the utterance at
    // once, empty, and an emergency is marked; before or after the frame-cap too_long, with or without end sent.
    const over = provider.listen('hold');
    const overEnd = over.end();
    ws.serverSend({ t: 'too_long', id: over.id, safety: 'emergency' });
    await expect(overEnd).resolves.toEqual({ text: '', tooLong: true, emergency: true });
    const capped = provider.listen('handsFree');
    ws.serverSend({ t: 'too_long', id: capped.id });
    const cappedEnd = capped.end();
    ws.serverSend({ t: 'too_long', id: capped.id, safety: 'emergency' });
    await expect(cappedEnd).resolves.toEqual({ text: '', tooLong: true, emergency: true });
    const plain = provider.listen('hold');
    const plainEnd = plain.end();
    ws.serverSend({ t: 'too_long', id: plain.id, safety: 'none' });
    await expect(plainEnd).resolves.toEqual({ text: '', tooLong: true });

    // A failed STT: an empty transcript.
    const f = provider.listen('handsFree');
    const fEnd = f.end();
    ws.serverSend({ t: 'failed', id: f.id, kind: 'stt' });
    await expect(fEnd).resolves.toEqual({ text: '', tooLong: false });
    expect(ws.json().find((m) => m.t === 'listen' && m.id === f.id)).toEqual({ t: 'listen', id: f.id, mode: 'handsFree' });

    // Cancel: sent, and the utterance ends empty.
    const c = provider.listen('hold');
    const cEnd = c.end();
    c.cancel();
    expect(ws.json().at(-1)).toEqual({ t: 'cancel', id: c.id });
    await expect(cEnd).resolves.toEqual({ text: '', tooLong: false });

    // Speak: items as given (at most MAX_SPEAK_ITEMS), audio played under its id, done after audio_end and the queue.
    const items: SpeakItem[] = Array.from({ length: MAX_SPEAK_ITEMS + 2 }, (_, i) => ({ kind: 'line', trigger: 'voice.check_screen', index: i }));
    const s = provider.speak(items, ['ignored by the service']);
    const speakMsg = ws.json().at(-1)!;
    expect(speakMsg).toMatchObject({ t: 'speak' });
    expect((speakMsg.items as unknown[]).length).toBe(MAX_SPEAK_ITEMS);
    const sid = speakMsg.id as number;
    ws.serverBinary(encodeFrame(sid, new Int16Array(10))); // before audio_start: no rate, not played
    ws.serverSend({ t: 'audio_start', id: sid, sampleRate: 22_050 });
    ws.serverBinary(encodeFrame(sid, new Int16Array(10)));
    ws.serverBinary(encodeFrame(sid + 1, new Int16Array(10))); // another id: ignored
    expect(played).toEqual([[sid, 10, 22_050]]);
    let done = false;
    void s.done.then(() => { done = true; });
    ws.serverSend({ t: 'audio_end', id: sid });
    await flush();
    expect(done).toBe(false); // still playing
    player.finish();
    await flush();
    expect(done).toBe(true);

    // Stop: playback halts, cancel is sent, done.
    const s2 = provider.speak([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], []);
    const sid2 = ws.json().at(-1)!.id as number;
    ws.serverSend({ t: 'audio_start', id: sid2, sampleRate: 22_050 });
    ws.serverBinary(encodeFrame(sid2, new Int16Array(10)));
    s2.stop();
    expect(ws.json().at(-1)).toEqual({ t: 'cancel', id: sid2 });
    await expect(s2.done).resolves.toBeUndefined();

    // Every id is fresh: never reused for a listen or a speak.
    const ids = ws.json().filter((m) => m.t === 'listen' || m.t === 'speak').map((m) => m.id as number);
    expect(new Set(ids).size).toBe(ids.length);

    // The socket drops mid-utterance: the utterance ends with "" and the provider says why, once.
    const events: unknown[] = [];
    provider.onEvent((e) => events.push(e));
    const d = provider.listen('hold');
    const dEnd = d.end();
    ws.serverClose(1006);
    await expect(dEnd).resolves.toEqual({ text: '', tooLong: false });
    expect(events).toEqual([{ kind: 'closed', reason: 'network' }]);
    // Nothing is retried: no new socket, and a listen now ends "" at once.
    const after = provider.listen('hold');
    await expect(after.end()).resolves.toEqual({ text: '', tooLong: false });
  });

  test('a refused listen (the allowance is resting) ends the utterance "" and reports the state', async () => {
    const { provider, ws } = await setup();
    const events: unknown[] = [];
    provider.onEvent((e) => events.push(e));
    const u = provider.listen('hold');
    const ended = u.end();
    ws.serverSend({ t: 'state', state: { kind: 'resting', until: '2026-12-01' } });
    await expect(ended).resolves.toEqual({ text: '', tooLong: false });
    expect(events).toEqual([{ kind: 'state', state: { kind: 'resting', until: '2026-12-01' } }]);
  });

  test('a closed provider sends nothing more and closes the socket', async () => {
    const { provider, ws, player } = await setup();
    provider.close();
    expect(ws.readyState).toBe(3);
    expect(player.stopped()).toBeGreaterThan(0);
    const n = ws.sent.length;
    provider.listen('hold').push(new Int16Array(3));
    await provider.speak([{ kind: 'line', trigger: 'voice.check_screen', index: 0 }], []).done;
    expect(ws.sent.length).toBe(n);
  });
});

describe('the provider seam (Ruling 1)', () => {
  test('providerKind() is "service" and devBrowserProvider throws when import.meta.env.DEV is false', async () => {
    vi.stubEnv('VITE_VOICE_PROVIDER', 'browser');
    vi.stubEnv('DEV', false);
    expect(providerKind()).toBe('service');
    await expect(devBrowserProvider({} as Window)).rejects.toThrow(/dev server only/);
    // Positive control: on the dev server, asked for, it is the browser's.
    vi.stubEnv('DEV', true);
    expect(providerKind()).toBe('browser');
    vi.stubEnv('VITE_VOICE_PROVIDER', '');
    expect(providerKind()).toBe('service');
  });

  test('hands-free shows only in a VITE_HANDS_FREE=on build (C9)', () => {
    vi.stubEnv('VITE_HANDS_FREE', 'on');
    expect(handsFreeBuild()).toBe(true);
    vi.stubEnv('VITE_HANDS_FREE', '');
    expect(handsFreeBuild()).toBe(false);
  });
});
