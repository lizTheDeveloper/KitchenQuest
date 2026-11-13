// @vitest-environment happy-dom
// M7 Step 9: talking to the Pan in the panel (talk.ts through the panel, the real voice client over fake audio and a
// fake socket: never a real microphone or network). Extends panel.test.ts; kept apart for its rig.
import { buildCheckOffCard, buildProfileCard, encodeFrame, FILLER_AFTER_MS, UNDO_WINDOW_MS, type MarketRunView } from '@kitchenquest/core/engine';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { createStore, type PlayerState } from '../state/store';
import * as realVoice from '../voice';
import { fakeAudio, socketWin, type FakeWebSocket } from '../voice/fakes.fixture';
import type { Player } from '../voice/playback';
import type { MentorBackend, MentorInput } from './backend';
import { createChildFlag } from './child-flag';
import { createDialogue } from './dialogue';
import { HEARD_YES } from './heard-card';
import { mountMentorPanel, type MentorMode } from './panel';
import type { CardView, PanReply } from './reply';
import { createScriptedEngine } from './scripted';
import { TALK_LABEL, TALK_OFF_LABEL, UNAVAILABLE_BACKOFF_MS } from './talk';
import { createWeekTurn } from './week-turn';
import type { CardWriter } from './writer';

const T0 = new Date('2026-11-13T18:05:00');
const dialogue = createDialogue(content.pan);
const recipes = Object.entries(content.recipes).map(([slug, r]) => ({ slug, title: r.meta.title }));
const engine = createScriptedEngine({ dialogue, graph, ruleTerms: content.ruleTerms, recipes, now: () => T0 });
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (id: string) => content.pan.triggers[id].lines;
const empty = (extra: Partial<PanReply> = {}): PanReply => ({ items: [], cards: [], intents: [], actions: [], notice: null, ...extra });

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

const writer = { confirm: vi.fn(), reject: vi.fn(), undo: vi.fn(() => Promise.resolve({ status: 'undone', items: [] })) } as unknown as CardWriter;
const grantedVoice = { consents: [{ purpose: 'voice', withdrawnAt: null, current: true }], needsReconsent: [], notices: { voice: { version: 'v1', text: 'The voice notice.' } } };

interface Rig {
  root: HTMLElement; store: ReturnType<typeof createStore>; audio: ReturnType<typeof fakeAudio>; sockets: FakeWebSocket[];
  player: ReturnType<typeof fakePlayer>; inputs: MentorInput[]; child: ReturnType<typeof createChildFlag>; client: ApiClient & { consents: ReturnType<typeof vi.fn> };
  btn(): HTMLButtonElement | null; row(): HTMLElement | null;
  press(): void; release(): void; ready(state?: unknown): Promise<FakeWebSocket>; frames(n?: number): void;
  pan: ReturnType<typeof mountMentorPanel>;
}

async function rig(opts: { mode?: MentorMode; patch?: Partial<PlayerState>; voice?: Partial<PlayerState['settings']['voice']>; answer?: (i: MentorInput) => Promise<PanReply>; consents?: unknown } = {}): Promise<Rig> {
  document.body.replaceChildren();
  const root = document.createElement('div');
  document.body.append(root);
  const store = createStore(null);
  store.update((s) => ({ ...s, account: { email: 'cook@example.com' }, aiDisclosureSeen: true, ...opts.patch, settings: { ...s.settings, ...opts.patch?.settings, voice: { ...s.settings.voice, on: true, ...opts.voice } } }));
  const sw = socketWin();
  const docEvents = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const audio = fakeAudio({ location: sw.win.location, WebSocket: (sw.win as unknown as { WebSocket: unknown }).WebSocket, document: docEvents });
  const player = fakePlayer();
  const inputs: MentorInput[] = [];
  const child = createChildFlag();
  const backend: MentorBackend = { kind: 'scripted', reply: (i) => { inputs.push(i); return opts.answer?.(i) ?? Promise.resolve(empty({ items: [{ kind: 'said', said: dialogue.say('thanks') }] })); } };
  const client = {
    consents: vi.fn(() => Promise.resolve({ ok: true, status: 200, data: opts.consents ?? grantedVoice })),
    grantConsent: vi.fn(() => Promise.resolve({ ok: true, status: 201, data: { consent: {} } })),
  } as unknown as Rig['client'];
  const week = () => Promise.resolve(createWeekTurn({ store, client, now: () => T0, dialogue, recipes, cooks: {} }));
  const pan = mountMentorPanel(root, {
    week, mode: opts.mode ?? 'standard', backend, dialogue, writer, engine, client, forms: content.bureau.forms, store, child,
    reducedMotion: () => true, now: () => T0, conversationId: () => 'conv-1',
    voice: { win: audio.win, load: () => Promise.resolve({ ...realVoice, serviceProvider: (w: Window, s: typeof store) => realVoice.serviceProvider(w, s, { player, now: () => T0 }) }) },
  });
  pan.open();
  await flush();
  const btn = () => root.querySelector<HTMLButtonElement>('#pan-talk');
  const r: Rig = {
    root, store, audio, sockets: sw.sockets, player, inputs, child, client, pan, btn,
    row: () => root.querySelector<HTMLElement>('.pan-talk-row'),
    press: () => { btn()!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true })); },
    release: () => { btn()!.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true })); },
    ready: async (state: unknown = { kind: 'available' }) => {
      await flush();
      const ws = sw.sockets.at(-1)!;
      if (ws.readyState === 0) ws.open();
      ws.serverSend({ t: 'ready', state });
      await flush();
      return ws;
    },
    frames: (n = 5) => { for (let i = 0; i < n; i++) audio.nodes.at(-1)!.port.emit(new Int16Array(320).fill(3000), -20); },
  };
  return r;
}
const listenId = (ws: FakeWebSocket) => ws.json().filter((m) => m.t === 'listen').at(-1)!.id as number;
const speaks = (ws: FakeWebSocket) => ws.json().filter((m) => m.t === 'speak');
/** One spoken utterance: hold, speak, let go, and the API's transcript. */
async function utter(r: Rig, text: string, state?: unknown): Promise<FakeWebSocket> {
  r.press();
  const ws = r.sockets.length > 0 && r.sockets.at(-1)!.readyState === 1 ? r.sockets.at(-1)! : await r.ready(state);
  await flush();
  r.frames();
  r.release();
  await flush();
  ws.serverSend({ t: 'transcript', id: listenId(ws), text });
  await flush();
  return ws;
}
const bubbles = (r: Rig) => [...r.root.querySelectorAll('.bubbles > li.bubble')].map((li) => `${li.classList.contains('pan') ? 'pan' : 'you'}${li.classList.contains('spoken') ? '(spoken)' : ''}: ${li.querySelector('.bubble-text')!.textContent}`);

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('talking to the Pan (M7 Step 9)', () => {
  test('signed in + voice on: hold → release → bubble marked spoken; a slow reply speaks voice.filler.ledger once; the reply is spoken as reply/card items', async () => {
    const view: CardView = { origin: 'server', proposalId: 'p-1', expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(), card: buildProfileCard({ mealsPerWeek: 4 }), issuedTurn: 1 };
    const r = await rig({ answer: () => wait(FILLER_AFTER_MS + 150).then(() => empty({ replyId: 'r-1', items: [{ kind: 'said', said: { ...dialogue.say('thanks'), part: 0 } }], cards: [view] })) });
    expect(r.btn()!.textContent).toBe(TALK_LABEL);
    expect(r.row()!.hidden).toBe(false);
    r.press();
    const ws = await r.ready();
    expect(r.btn()!.getAttribute('aria-pressed')).toBe('true');
    r.frames();
    r.release();
    await flush();
    expect(ws.json().filter((m) => m.t === 'end')).toHaveLength(1);
    ws.serverSend({ t: 'transcript', id: listenId(ws), text: 'I ate it all at lunch' });
    await flush();
    expect(bubbles(r)).toEqual(['you(spoken): I ate it all at lunch']);
    expect(r.root.querySelector('.bubble.spoken')!.textContent).toContain('(spoken)');
    await wait(FILLER_AFTER_MS + 300);
    await flush();
    const said = speaks(ws);
    // The filler once, while the turn ran; then the reply, by id: its line part and its card, never text.
    expect(said).toHaveLength(2);
    expect(said[0].items).toEqual([{ kind: 'line', trigger: 'voice.filler.ledger', index: expect.any(Number) as number }]);
    expect(said[1].items).toEqual([{ kind: 'reply', replyId: 'r-1', part: 0 }, { kind: 'card', proposalId: 'p-1' }]);
    expect(JSON.stringify(said)).not.toContain('lunch');
    expect(r.inputs).toEqual([{ kind: 'transcript', text: 'I ate it all at lunch', utteranceId: listenId(ws) }]);
  });

  test('a fast reply has no filler; read-aloud off: the reply is drawn and nothing is spoken (say([]) ends the wait)', async () => {
    const r = await rig({ voice: { readAloud: false } });
    const ws = await utter(r, 'what should I cook');
    await wait(FILLER_AFTER_MS + 100);
    expect(speaks(ws)).toEqual([]);
    expect(r.root.querySelectorAll('.bubble.pan')).toHaveLength(1);
    expect(r.btn()!.dataset.phase).toBe('idle');
  });

  test('barge-in during a reply with a grammar check-off: audio stops, the ticked card and its Undo are drawn (Ruling 10)', async () => {
    const run: MarketRunView = { id: 'run-1', weekStart: '2026-11-09', doneAt: null, items: [{ key: 'shallot', name: 'shallot', ingredientId: 'shallot', stall: 'wen', forDishes: [], ticked: false }] };
    const co = buildCheckOffCard(run, ['shallot'], [], 'grammar')!;
    const view: CardView = { origin: 'server', proposalId: 'co-1', expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(), card: co, issuedTurn: 1 };
    const trail = { id: 'w-1', origin: 'server' as const, kind: 'check_off' as const, summary: co.summary, undoUntil: new Date(T0.getTime() + UNDO_WINDOW_MS).toISOString() };
    const r = await rig({ answer: () => Promise.resolve(empty({ replyId: 'r-2', items: [{ kind: 'said', said: { ...dialogue.say('thanks'), part: 0 } }], cards: [view], actions: [{ kind: 'confirmed', proposalId: 'co-1', trail }] })) });
    const ws = await utter(r, 'tick them off');
    await flush(20);
    const speak = speaks(ws).at(-1)!;
    ws.serverSend({ t: 'audio_start', id: speak.id, sampleRate: 22_050 });
    ws.serverBinary(encodeFrame(speak.id as number, new Int16Array(64)));
    await flush();
    expect(r.player.plays).toBeGreaterThan(0);
    // The player presses talk while the Pan is speaking: the audio stops at once and the speech is cancelled.
    const stopsBefore = r.player.stops;
    r.press();
    expect(r.player.stops).toBeGreaterThan(stopsBefore);
    expect(ws.json().some((m) => m.t === 'cancel' && m.id === speak.id)).toBe(true);
    // The write already done is still drawn: the ticked card, with its Undo.
    const card = r.root.querySelector('.pan-card-item')!;
    expect(card.textContent).toContain('shallot');
    expect([...card.querySelectorAll('button')].some((b) => b.textContent === 'Undo')).toBe(true);
    r.release();
  });

  test('Family Table: no talk button, getUserMedia never called; switching Family Table on mid-utterance closes the mic at once (Review Focus 4)', async () => {
    const ft = await rig({ mode: 'familyTable', patch: { settings: { ...createStore(null).get().settings, familyTable: true } } });
    expect(ft.btn()).toBeNull();
    expect(ft.root.querySelector('.pan-talk-row')).toBeNull();
    await flush();
    expect(ft.audio.getUserMedia.calls).toHaveLength(0);
    expect(ft.sockets).toHaveLength(0);
    // Standard, mid-utterance: the store flips (another tab, or Settings) and the microphone stops in that same change.
    const r = await rig();
    r.press();
    const ws = await r.ready();
    r.frames();
    const sent = ws.frames().length;
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    r.store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    r.frames();
    expect(ws.frames().length).toBe(sent);
    expect(ws.closedWith).not.toBeNull();
    expect(r.row()!.hidden).toBe(true);
  });

  test('signed out: no talk button; voice off: the button opens Settings → Voice', async () => {
    const out = await rig({ patch: { account: null } });
    expect(out.row()!.hidden).toBe(true);
    const off = await rig({ voice: { on: false } });
    expect(off.row()!.hidden).toBe(false);
    expect(off.btn()!.textContent).toBe(TALK_OFF_LABEL);
    off.press();
    off.btn()!.click();
    expect(off.audio.win.location.hash).toBe('#/settings');
    await flush();
    expect(off.audio.getUserMedia.calls).toHaveLength(0);
    expect(off.sockets).toHaveLength(0);
    // Turned on: the same control holds to talk.
    off.store.update((s) => ({ ...s, settings: { ...s.settings, voice: { ...s.settings.voice, on: true } } }));
    expect(off.btn()!.textContent).toBe(TALK_LABEL);
    // Keyboard: Space held on the button talks; let go sends.
    off.btn()!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    const ws = await off.ready();
    off.frames();
    off.btn()!.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    await flush();
    expect(ws.json().map((m) => m.t)).toEqual(['hello', 'listen', 'end']);
  });

  test('a reply that sets the child flag closes the controller and hides the button', async () => {
    const holder: { r?: Rig } = {};
    const r = holder.r = await rig({ answer: () => { holder.r!.child.set(); return Promise.resolve(empty({ items: [{ kind: 'said', said: dialogue.say('child.grownup') }] })); } });
    const ws = await utter(r, 'what should I cook');
    await flush(20);
    expect(r.row()!.hidden).toBe(true);
    expect(ws.closedWith).not.toBeNull();
    expect(speaks(ws)).toEqual([]);
    // Nothing opens again in this conversation.
    r.btn()!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }));
    await flush();
    expect(r.sockets).toHaveLength(1);
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
  });

  test('carry G3: a device-only child flag closes a microphone that is still starting, at once', async () => {
    const r = await rig();
    r.audio.startSuspended = true;
    r.audio.resumeHangs = true;
    r.press();
    await r.ready();
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    r.child.set();
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
  });

  test('the socket drops mid-utterance: voice.unavailable once, text box focused, nothing resent (Review Focus 5)', async () => {
    const r = await rig();
    r.press();
    const ws = await r.ready();
    r.frames();
    ws.serverClose(1006);
    await flush();
    r.release();
    await flush();
    const said = [...r.root.querySelectorAll('.bubble.pan')].map((b) => b.textContent);
    expect(said.filter((t) => lines('voice.unavailable').includes(t))).toHaveLength(1);
    expect(document.activeElement?.id).toBe('pan-text');
    expect(r.inputs).toEqual([]);
    expect(r.sockets).toHaveLength(1);
    expect(ws.json().filter((m) => m.t === 'listen')).toHaveLength(1);
  });

  test('carry 5: an unavailable close makes a fresh controller only after a backoff; carry 4 (n3): after consent_required the consents are read again first', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const r = await rig();
    r.press();
    const ws = await r.ready();
    ws.serverSend({ t: 'closed', reason: 'unavailable' });
    ws.serverClose(1011);
    await flush();
    r.release();
    r.press();
    await flush();
    expect(r.sockets).toHaveLength(1); // within the backoff: nothing reopens, and the line says so
    r.release();
    vi.setSystemTime(new Date(T0.getTime() + UNAVAILABLE_BACKOFF_MS + 1));
    r.press();
    await flush();
    expect(r.sockets).toHaveLength(2);
    r.release();
    vi.useRealTimers();
    // consent_required, consent still granted on a re-read: no card is asked for again.
    const c = await rig();
    c.press();
    const cws = await c.ready();
    cws.serverSend({ t: 'closed', reason: 'consent_required' });
    cws.serverClose(4403);
    await flush();
    expect(c.client.consents).toHaveBeenCalled();
    expect(c.root.querySelector('.consent-card')).toBeNull();
    c.release();
    // Withdrawn meanwhile: the voice consent card (Form 3-C/VOICE), by tap.
    const m = await rig({ consents: { consents: [], needsReconsent: [], notices: { voice: { version: 'v1', text: 'The voice notice.' } } } });
    m.press();
    const mws = await m.ready();
    mws.serverSend({ t: 'closed', reason: 'consent_required' });
    mws.serverClose(4403);
    await flush(20);
    expect(m.root.querySelector('.consent-card')?.getAttribute('data-purpose')).toBe('voice');
    expect(m.root.textContent).toContain('Permission to Talk Out Loud');
  });

  test('resting: the state line names a day, never a number; the next press asks a fresh controller, so a lifted rest is noticed', async () => {
    const r = await rig();
    r.press();
    await r.ready({ kind: 'resting', until: '2026-11-19' });
    r.release();
    await flush();
    const text = r.root.querySelector('.bubbles')!.textContent;
    expect(text).toContain('Thursday 19 November');
    expect(text).not.toMatch(/\d+\s*(min|minutes|s|left|remaining)\b/);
    expect(r.audio.getUserMedia.calls).toHaveLength(0);
    r.press();
    await r.ready({ kind: 'available' });
    expect(r.sockets).toHaveLength(2);
    expect(r.audio.getUserMedia.calls).toHaveLength(1);
    r.release();
  });

  test('the heard card: a spoken "yes" never confirms it; its tap sends the confirmed words and the reply is spoken', async () => {
    const r = await rig();
    const ws = await utter(r, "I can't eat sesame");
    await flush(20);
    expect(r.inputs).toEqual([]);
    const card = r.root.querySelector('.heard-card')!;
    expect(card.querySelector('.heard-spelled')!.textContent).toBe('S-E-S-A-M-E');
    expect(speaks(ws).at(-1)!.items).toEqual([{ kind: 'heard', utteranceId: listenId(ws) }]);
    // A spoken yes is a new turn of its own, never this card's tap.
    await utter(r, 'yes');
    await flush(20);
    expect(r.inputs).toEqual([{ kind: 'transcript', text: 'yes', utteranceId: listenId(ws) }]);
    expect([...card.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
    const before = speaks(ws).length;
    [...card.querySelectorAll('button')].find((b) => b.textContent === HEARD_YES)!.click();
    await flush(20);
    expect(r.inputs.at(-1)).toEqual({ kind: 'transcript', text: "I can't eat sesame", heard: { words: ['sesame'] }, utteranceId: 1 });
    // The tapped turn's reply is spoken too (its var-free line is said by the API; 'thanks' has no dot: check_screen).
    expect(speaks(ws).length).toBe(before + 1);
  });
});
