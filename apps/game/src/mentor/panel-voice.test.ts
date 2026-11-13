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
import { MIC_READY_TEXT, TALK_BLOCKED_LABEL, TALK_COOK_LABEL, TALK_LABEL, TALK_OFF_LABEL, UNAVAILABLE_BACKOFF_MS } from './talk';
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

  test('fix round 1 (I-2) and 2: a server Family Table refusal says voice.family_table once and marks the control off; each later press asks again (no loop), and the control comes back once the block lifts', async () => {
    const r = await rig();
    const refuse = async () => {
      r.press();
      await flush();
      const ws = r.sockets.at(-1)!;
      ws.open();
      ws.serverSend({ t: 'closed', reason: 'family_table' });
      ws.serverClose(4452);
      await flush();
      r.release();
      await flush();
    };
    const said = () => [...r.root.querySelectorAll('.bubble.pan')].filter((b) => lines('voice.family_table').includes(b.textContent)).length;
    await refuse();
    expect(said()).toBe(1);
    expect(r.row()!.hidden).toBe(false);
    expect(r.btn()!.dataset.phase).toBe('blocked');
    expect(r.btn()!.textContent).toBe(TALK_BLOCKED_LABEL);
    expect(r.audio.getUserMedia.calls).toHaveLength(0);
    // Still blocked: the press is one hello, refused, and the line is not said again.
    await refuse();
    expect(r.sockets).toHaveLength(2);
    expect(said()).toBe(1);
    // The other device left Family Table: the next press's hello is answered, and the control is back.
    r.press();
    const ws = await r.ready();
    expect(r.btn()!.dataset.phase).toBe('listening');
    r.release();
    await flush();
    expect(ws.json().map((m) => m.t)).toContain('listen');
    // A new block later is said again.
    await refuse();
    expect(said()).toBe(2);
  });

  test('fix round 1 (I-2): a server child refusal says voice.child_block once (round 3, N-2); a cleared conversation behaves the same, never silently', async () => {
    const r = await rig();
    const refuse = async () => {
      r.press();
      await flush();
      const ws = r.sockets.at(-1)!;
      ws.open();
      ws.serverSend({ t: 'closed', reason: 'child' });
      ws.serverClose(4451);
      await flush();
      r.release();
      await flush();
    };
    await refuse();
    const grownup = () => [...r.root.querySelectorAll('.bubble.pan')].filter((b) => lines('voice.child_block').includes(b.textContent)).length;
    expect(grownup()).toBe(1);
    expect(r.btn()!.dataset.phase).toBe('blocked');
    // The conversation is cleared (the device's own child flag forgets): the control is back, and the same refusal
    // gets the same line again (one per refusal, each needing a press).
    r.child.reset();
    expect(r.btn()!.dataset.phase).not.toBe('blocked');
    await refuse();
    expect(r.sockets).toHaveLength(2);
    expect(grownup()).toBe(2);
  });

  test('fix round 1 (M-2): consents that cannot be read after consent_required say voice.unavailable, never the consent card', async () => {
    const r = await rig();
    r.client.consents.mockReturnValue(Promise.resolve({ ok: false, status: 0, error: { code: 'network', message: '' } }));
    r.press();
    const ws = await r.ready();
    ws.serverSend({ t: 'closed', reason: 'consent_required' });
    ws.serverClose(4403);
    await flush(20);
    expect(r.root.querySelector('.consent-card')).toBeNull();
    expect([...r.root.querySelectorAll('.bubble.pan')].some((b) => lines('voice.unavailable').includes(b.textContent))).toBe(true);
  });

  test('fix round 1 (M-4): a drop between turns says so without taking focus from where the player is', async () => {
    const r = await rig();
    const ws = await utter(r, 'what should I cook');
    await flush(20);
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    ws.serverClose(1006);
    await flush();
    expect(document.activeElement).toBe(other);
  });

  test('fix round 1 (M-7): the status line follows the turn: answering, then speaking', async () => {
    let answer!: (r: PanReply) => void;
    const r = await rig({ answer: () => new Promise((res) => { answer = res; }) });
    const ws = await utter(r, 'what should I cook');
    const state = () => r.root.querySelector('.pan-talk-state')!.textContent;
    expect(state()).toBe('The Pan is answering.');
    answer(empty({ items: [{ kind: 'said', said: dialogue.say('thanks') }] }));
    await flush(20);
    expect(speaks(ws)).toHaveLength(1);
    expect(state()).toBe('The Pan is speaking. Hold to interrupt.');
  });

  test('fix round 1 (M-1): a working session resets the unavailable backoff', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: T0 });
    const r = await rig();
    const drop = async () => {
      const ws = r.sockets.at(-1)!;
      ws.serverSend({ t: 'closed', reason: 'unavailable' });
      ws.serverClose(1011);
      await flush();
      r.release();
    };
    r.press();
    await r.ready();
    await drop();
    vi.setSystemTime(new Date(T0.getTime() + UNAVAILABLE_BACKOFF_MS + 1));
    // A working session: a full utterance answered.
    await utter(r, 'what should I cook');
    await flush(20);
    await drop();
    // The backoff is the first one again, not doubled.
    vi.setSystemTime(new Date(T0.getTime() + 2 * UNAVAILABLE_BACKOFF_MS + 2));
    r.press();
    await flush();
    expect(r.sockets).toHaveLength(3);
    r.release();
  });

  test('fix round 1 (M-3): with voice off the control asks Settings to focus its Voice section', async () => {
    const { takeFocus } = await import('../shell/focus-intent');
    const off = await rig({ voice: { on: false } });
    off.btn()!.click();
    expect(off.audio.win.location.hash).toBe('#/settings');
    expect(takeFocus('voice-settings')).toBe(true);
  });

  test('fix round 3 (the intake-lazy flake): signed out, opening the panel never loads the talk control; signing in while it is open loads it', async () => {
    const r = await rig({ patch: { account: null } });
    expect(r.btn()).toBeNull(); // talk.ts never loaded: nothing of it is drawn
    expect(r.row()!.hidden).toBe(true);
    r.store.update((s) => ({ ...s, account: { email: 'cook@example.com' } }));
    await vi.waitFor(() => { expect(r.btn()).not.toBeNull(); });
    expect(r.row()!.hidden).toBe(false);
  });

  test('fix round 3 (I-A): an allow given after letting go shows "microphone ready" in the status line, without taking focus', async () => {
    const r = await rig();
    const allow = r.audio.hold();
    r.press();
    await r.ready();
    r.release();
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    allow();
    await flush();
    expect(r.root.querySelector('.pan-talk-state')!.textContent).toBe(MIC_READY_TEXT);
    expect(document.activeElement).toBe(other);
  });

  test('fix round 3 (N-1): a refused microphone names the browser\'s permission (voice.mic_blocked), not the generic line', async () => {
    const r = await rig();
    r.audio.fail.gum = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    r.press();
    await r.ready();
    await flush();
    r.release();
    const said = [...r.root.querySelectorAll('.bubble.pan')].map((b) => b.textContent);
    expect(said.filter((t) => lines('voice.mic_blocked').includes(t))).toHaveLength(1);
    expect(said.some((t) => lines('voice.unavailable').includes(t))).toBe(false);
    expect(lines('voice.mic_blocked').every((l) => /browser/.test(l))).toBe(true);
  });

  test('fix round 3 (N-2): a server child block on this device says the neutral voice.child_block, not the line to a child', async () => {
    const r = await rig();
    r.press();
    await flush();
    const ws = r.sockets.at(-1)!;
    ws.open();
    ws.serverSend({ t: 'closed', reason: 'child' });
    ws.serverClose(4451);
    await flush();
    r.release();
    const said = [...r.root.querySelectorAll('.bubble.pan')].map((b) => b.textContent);
    expect(said.filter((t) => lines('voice.child_block').includes(t))).toHaveLength(1);
    expect(said.some((t) => lines('child.grownup').includes(t))).toBe(false);
  });

  test('fix round 3 (N-3): a press that ended with no listen does not leave the control "engaged": a later drop takes no focus', async () => {
    const r = await rig();
    const ws = await utter(r, 'what should I cook'); // a first, complete turn
    await flush(20);
    const listens = ws.json().filter((m) => m.t === 'listen').length;
    r.press();
    r.release(); // let go before the microphone opened: no listen goes
    await flush(20);
    expect(ws.json().filter((m) => m.t === 'listen')).toHaveLength(listens);
    const other = document.createElement('input');
    document.body.append(other);
    other.focus();
    ws.serverClose(1006);
    await flush();
    expect(document.activeElement).toBe(other);
  });
});


describe('M7 Step 10: the panel\'s port for hands-free cook mode (cookVoice)', () => {
  test('null in Family Table and signed out (Rulings 8 and 9); a spoken turn is the player\'s spoken bubble, then the heard check before any backend (Ruling 4); a food-free question reaches the backend as a transcript (D6)', async () => {
    expect((await rig({ mode: 'familyTable' })).pan.cookVoice()).toBeNull();
    expect((await rig({ patch: { account: null } })).pan.cookVoice()).toBeNull();
    const r = await rig();
    const port = r.pan.cookVoice()!;
    expect(port.conversationId()).toBe('conv-1');
    expect(port.childOn()).toBe(false);
    const changes: boolean[] = [];
    const un = port.onChild(() => changes.push(port.childOn()));
    const heard = await port.spoken("I can't eat sesame", 7);
    expect(r.inputs).toEqual([]); // nothing sent before the tap
    expect(heard!.items.some((i) => i.kind === 'heard')).toBe(true);
    await flush(20);
    expect(r.root.querySelector('.heard-card')).not.toBeNull();
    expect(bubbles(r)[0]).toBe("you(spoken): I can't eat sesame");
    // A spoken yes is a turn of its own: it never taps the card.
    await port.spoken('yes', 8);
    await flush(20);
    expect([...r.root.querySelector('.heard-card')!.querySelectorAll('button')].every((b) => !b.disabled)).toBe(true);
    await port.spoken('how long do I keep stirring', 9);
    expect(r.inputs.at(-1)).toEqual({ kind: 'transcript', text: 'how long do I keep stirring', utteranceId: 9 });
    r.child.set();
    expect(changes).toEqual([true]);
    expect(port.childOn()).toBe(true);
    un();
  });
});

describe('M7 Step 10 fix round 1 (I1): one voice controller at a time; hands-free cook mode owns voice while it is on', () => {
  test('hands-free on → the talk control reads "Hands-free is on", a press opens nothing, and the microphone was opened once in all', async () => {
    vi.stubEnv('VITE_HANDS_FREE', 'on');
    try {
      const r = await rig();
      const { claimVoice } = await import('./voice-owner');
      const { startCookVoice } = await import('../cook/cook-voice');
      // Cook mode's own controller, on the same browser: claimed first, then started.
      const release = claimVoice('cook');
      await flush();
      expect(r.btn()!.textContent).toBe(TALK_COOK_LABEL);
      expect(r.btn()!.getAttribute('aria-disabled')).toBe('true');
      const cookCtl = realVoice.createVoiceController({ win: r.audio.win, store: r.store, provider: realVoice.serviceProvider(r.audio.win, r.store, { player: r.player, now: () => T0 }), conversationId: () => null, childOn: () => false, earcon: () => undefined });
      const cv = startCookVoice({ controller: cookCtl, hooks: { next() {}, back() {}, timerStart: () => false, timerStop: () => 'which', currentStep: () => 0, stepCount: () => 3, speakStep: null }, localDate: () => '2026-11-13', doc: document, toPan: () => Promise.resolve(null), say: (t) => dialogue.say(t), show: () => undefined, answered: () => undefined, openCards: () => [], readAloud: () => true });
      await r.ready();
      expect(r.audio.getUserMedia.calls).toHaveLength(1);
      const socketsBefore = r.sockets.length;
      r.press();
      await flush();
      r.release();
      await flush();
      expect(r.audio.getUserMedia.calls).toHaveLength(1); // never a second microphone
      expect(r.sockets).toHaveLength(socketsBefore); // nor a second socket
      // Hands-free off: the talk control is back.
      cv.stop('user');
      release();
      await flush();
      expect(r.btn()!.textContent).toBe(TALK_LABEL);
      expect(r.btn()!.hasAttribute('aria-disabled')).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  test('a talk controller holding the microphone is closed the moment cook mode claims voice (its tracks stopped)', async () => {
    const r = await rig();
    const { claimVoice } = await import('./voice-owner');
    r.press();
    await r.ready();
    await flush();
    expect(r.audio.tracks.some((t) => !t.stopped)).toBe(true);
    const release = claimVoice('cook');
    expect(r.audio.tracks.every((t) => t.stopped)).toBe(true);
    release();
    release(); // twice is harmless
  });
});

describe('M7 Step 10 fix round 2: outside hands-free a spoken yes still goes the normal way (Rulings 10 and 12)', () => {
  test('hold-to-talk "yes please" with a non-severe server card open is sent as a transcript, for the server\'s spoken_yes; no "tap the card" cue', async () => {
    const view: CardView = { origin: 'server', proposalId: 'p-1', expiresAt: new Date(T0.getTime() + 3_600_000).toISOString(), card: buildProfileCard({ mealsPerWeek: 4 }), issuedTurn: 1 };
    let n = 0;
    const r = await rig({ answer: () => Promise.resolve(empty({ replyId: `r-${++n}`, items: [{ kind: 'said', said: { ...dialogue.say('thanks'), part: 0 } }], cards: n === 1 ? [view] : [] })) });
    await utter(r, 'how many meals do I cook');
    await flush(20);
    expect(r.root.querySelector('.pan-card')).not.toBeNull();
    await utter(r, 'yes please');
    await flush(20);
    expect(r.inputs.at(-1)).toEqual({ kind: 'transcript', text: 'yes please', utteranceId: expect.any(Number) as number });
    expect(r.root.textContent).not.toContain('Tap the card to say yes.');
  });
});
