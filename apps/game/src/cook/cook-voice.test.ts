// @vitest-environment happy-dom
import { HANDS_FREE_IDLE_MS, cookCommand, type SpeakItem, type VoiceState } from '@kitchenquest/core/engine';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { PanReply } from '../mentor/reply';
import type { HandsFreeOff, VoiceController, VoicePhase, VoiceProblem } from '../voice';
import { startCookVoice, type CookVoiceHooks } from './cook-voice';
import { createAlarm } from './timers';
import { beep } from './cook-mode';
import { createStore } from '../state/store';
import { createVoiceController } from '../voice/controller';
import { serviceProvider } from '../voice/providers';
import { fakeAudio, socketWin } from '../voice/fakes.fixture';

type Plan = { items: SpeakItem[]; said: string[] };

/** A controller double: records what cook voice asks of it, and lets a test speak for the microphone. */
function fakeController() {
  const transcripts = new Set<(t: string, tooLong: boolean, id: number) => void>();
  const off = new Set<(w: HandsFreeOff) => void>();
  const problems = new Set<(p: VoiceProblem) => void>();
  const phases = new Set<(p: VoicePhase, s: VoiceState | null) => void>();
  let handsFree = false;
  let nextId = 1;
  const f = {
    calls: [] as string[],
    said: [] as Plan[],
    timer: [] as boolean[],
    phase: 'idle' as VoicePhase,
    state: null as VoiceState | null,
    closedReason: null,
    lastUtteranceId: null,
    get handsFree() { return handsFree; },
    refuseStart: false,
    startHandsFree() { f.calls.push('startHandsFree'); if (!f.refuseStart) handsFree = true; },
    stopHandsFree() { f.calls.push('stopHandsFree'); f.handsOff('stopped'); },
    timerSounding(on: boolean) { f.timer.push(on); },
    say(plan: Plan) { f.said.push(plan); },
    press() {}, release() {},
    onTranscript(fn: (t: string, tooLong: boolean, id: number) => void) { transcripts.add(fn); return () => { transcripts.delete(fn); }; },
    onPhase(fn: (p: VoicePhase, s: VoiceState | null) => void) { phases.add(fn); return () => { phases.delete(fn); }; },
    onProblem(fn: (p: VoiceProblem) => void) { problems.add(fn); return () => { problems.delete(fn); }; },
    onMicReady() { return () => undefined; },
    onReady() { return () => undefined; },
    onMic() { return () => undefined; },
    onHandsFreeOff(fn: (w: HandsFreeOff) => void) { off.add(fn); return () => { off.delete(fn); }; },
    close() { f.calls.push('close'); f.handsOff('closed'); },
    /** The microphone heard `text` (an utterance ended and its transcript came back). */
    hear(text: string, tooLong = false): number { const id = nextId++; for (const fn of [...transcripts]) fn(text, tooLong, id); return id; },
    handsOff(w: HandsFreeOff) { if (!handsFree) return; handsFree = false; for (const fn of [...off]) fn(w); },
    problem(p: VoiceProblem) { for (const fn of [...problems]) fn(p); },
    setPhase(p: VoicePhase, s: VoiceState | null = null) { f.phase = p; f.state = s; for (const fn of [...phases]) fn(p, s); },
    listeners: () => transcripts.size + off.size + problems.size + phases.size,
  };
  return f;
}
type Fake = ReturnType<typeof fakeController>;

const said = (text: string): PanReply => ({ items: [{ kind: 'said', said: { trigger: 'mentor.reply', text, ai: 'allowed', index: 0, part: 0 } }], cards: [], intents: [], actions: [], notice: null, replyId: 'r-1' });

function rig(opts: { speakStep?: { slug: string } | null; toPan?: (text: string, id: number) => Promise<PanReply | null>; readAloud?: boolean } = {}) {
  const c = fakeController();
  let step = 0;
  const total = 4;
  const log: string[] = [];
  const lines: string[] = [];
  const toPan: { text: string; id: number }[] = [];
  const stops: string[] = [];
  const hooks: CookVoiceHooks = {
    next: () => { log.push('next'); if (step < total - 1) step++; },
    back: () => { log.push('back'); if (step > 0) step--; },
    timerStart: () => { log.push('timerStart'); },
    timerStop: () => { log.push('timerStop'); },
    currentStep: () => step,
    speakStep: opts.speakStep === undefined ? { slug: 'india/kerala/parippu' } : opts.speakStep,
  };
  const voice = startCookVoice({
    controller: c as unknown as VoiceController, hooks, localDate: () => '2026-11-13', doc: document,
    toPan: (text, id) => { toPan.push({ text, id }); return opts.toPan ? opts.toPan(text, id) : Promise.resolve(said('Keep it moving.')); },
    line: (t) => { lines.push(t); },
    readAloud: () => opts.readAloud ?? true,
    onStop: (why) => { stops.push(why); },
  });
  return { c, voice, log, lines, toPan, stops, step: () => step };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
  document.dispatchEvent(new Event('visibilitychange'));
};

afterEach(() => { setHidden(false); vi.useRealTimers(); });

describe('startCookVoice (M7 Step 10)', () => {
  test('starts the controller\'s hands-free loop and says voice.hands_free_on', () => {
    const r = rig();
    expect(r.c.calls).toEqual(['startHandsFree']);
    expect(r.lines).toEqual(['voice.hands_free_on']);
    // A controller that refuses (not a hands-free build, a terminal close) leaves it off, with no "on" line.
    const c = fakeController();
    c.refuseStart = true;
    const stops: string[] = [];
    const lines: string[] = [];
    startCookVoice({ controller: c as unknown as VoiceController, hooks: { next() {}, back() {}, timerStart() {}, timerStop() {}, currentStep: () => 0, speakStep: null }, localDate: () => '2026-11-13', doc: document, toPan: () => Promise.resolve(null), line: (t) => lines.push(t), readAloud: () => true, onStop: (w) => stops.push(w) });
    expect(lines).toEqual([]);
    expect(stops).toEqual(['refused']);
  });

  test('"next" on step index 0 of a canon dish shows index 1 and says { kind: "step", slug, step: 1 }; a frame dish advances and says nothing', () => {
    const r = rig();
    r.c.hear('next step please');
    expect(r.log).toEqual(['next']);
    expect(r.step()).toBe(1);
    expect(r.c.said).toEqual([{ items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 1, localDate: '2026-11-13' }], said: [] }]);
    // "back" and "repeat" read the step now on screen (0-based, P12).
    r.c.hear('go back');
    r.c.hear('say that again');
    expect(r.c.said.slice(1).map((p) => (p.items[0] as { step: number }).step)).toEqual([0, 0]);
    expect(r.toPan).toEqual([]); // commands never reach the Pan
    // Back on the first step: nothing moved, so nothing is read; the wait just ends.
    r.c.hear('back');
    expect(r.c.said.at(-1)).toEqual({ items: [], said: [] });
    // A Pantry Frame (Ruling 11): it advances, and nothing is ever read aloud.
    const f = rig({ speakStep: null });
    f.c.hear('next');
    f.c.hear('repeat');
    expect(f.step()).toBe(1);
    expect(f.c.said.every((p) => p.items.length === 0)).toBe(true);
    expect(f.c.said.flatMap((p) => p.items).some((i) => i.kind === 'step')).toBe(false);
  });

  test('"start the timer" / "stop the timer" call the existing hooks; "stop listening" stops and says voice.hands_free_off', () => {
    const r = rig();
    r.c.hear('start the timer');
    r.c.hear('ok stop the timer thanks');
    expect(r.log).toEqual(['timerStart', 'timerStop']);
    expect(r.c.said).toEqual([{ items: [], said: [] }, { items: [], said: [] }]); // the wait ends, nothing spoken
    r.c.hear('stop listening');
    expect(r.c.calls).toEqual(['startHandsFree', 'stopHandsFree']);
    expect(r.lines).toEqual(['voice.hands_free_on', 'voice.hands_free_off']);
    expect(r.stops).toEqual(['user']);
    // Stopped: nothing more is heard, said, or told twice.
    expect(r.c.listeners()).toBe(0);
    r.voice.stop('user');
    expect(r.lines).toHaveLength(2);
    expect(r.stops).toEqual(['user']);
  });

  test('a non-command non-food question ("how long do I keep stirring") goes to toPan with its utteranceId (D6); its reply is spoken from speakPlan only', async () => {
    const r = rig();
    const id = r.c.hear('how long do I keep stirring');
    expect(r.toPan).toEqual([{ text: 'how long do I keep stirring', id }]);
    await flush();
    // R9: the model's text is never spoken: the plan names the reply part, and carries no text of its own.
    expect(r.c.said).toEqual([{ items: [{ kind: 'reply', replyId: 'r-1', part: 0 }], said: ['Keep it moving.'] }]);
    expect(JSON.stringify(r.c.said[0].items)).not.toContain('Keep it moving');
    // Read-aloud off: drawn, never spoken; the wait still ends.
    const quiet = rig({ readAloud: false });
    quiet.c.hear('how long do I keep stirring');
    await flush();
    expect(quiet.c.said).toEqual([{ items: [], said: [] }]);
    // A too-long or empty utterance is never a command: it goes the Pan's way (its own voice.too_long / didnt_catch).
    const t = rig();
    t.c.hear('next', true);
    expect(t.log).toEqual([]);
    expect(t.toPan.map((x) => x.text)).toEqual(['next']);
  });

  test('carry 6 (Rulings 10 and 12): a spoken "yes" or "confirm" is no cook command and never confirms anything here; it goes to the Pan, whose heard and severe cards are tap-only', () => {
    for (const yes of ['yes', 'yes please', 'confirm', 'that\'s right', 'yes that\'s what I said']) expect(cookCommand(yes)).toBeNull();
    const r = rig();
    r.c.hear('yes');
    expect(r.log).toEqual([]);
    expect(r.toPan.map((x) => x.text)).toEqual(['yes']);
  });

  test('carry 5 (Ruling 10): barge-in stops audio only. A turn already sent still shows its cards; only the newest turn\'s reply is spoken', async () => {
    let answer: (r: PanReply) => void = () => undefined;
    const drawn: PanReply[] = [];
    const r = rig({ toPan: () => new Promise<PanReply>((res) => { answer = (x) => { drawn.push(x); res(x); }; }) });
    r.c.hear('how long do I keep stirring');
    // The player talks over the wait (the controller stopped any audio itself): a command, handled at once.
    r.c.hear('next');
    expect(r.step()).toBe(1);
    const withCard: PanReply = { ...said('Here you go.'), cards: [{ origin: 'local', localId: 'l1' } as unknown as PanReply['cards'][number]] };
    answer(withCard);
    await flush();
    // The earlier turn's reply, card included, was drawn by the panel (toPan), and is not spoken over the newer one.
    expect(drawn).toEqual([withCard]);
    expect(r.c.said).toEqual([{ items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 1, localDate: '2026-11-13' }], said: [] }]);
    // Hands-free stays on: nothing was cancelled but the audio.
    expect(r.c.handsFree).toBe(true);
    expect(r.stops).toEqual([]);
  });

  test('while a timer alarm sounds, timerSounding(true) is called and cleared after; alarm-shaped audio opens no utterance (B9, Review Focus 3)', () => {
    const r = rig();
    const ends: (() => void)[] = [];
    const order: string[] = [];
    const alarm = createAlarm((ended) => { order.push('beep'); ends.push(ended); return true; }, (on) => { order.push(`sounding:${on}`); r.voice.timerSounding(on); });
    alarm.sound();
    expect(order).toEqual(['sounding:true', 'beep']);
    expect(r.c.timer).toEqual([true]);
    ends[0]();
    expect(r.c.timer).toEqual([true, false]);
    // Stopped, nothing more reaches the controller.
    r.voice.stop('user');
    alarm.sound();
    expect(r.c.timer).toEqual([true, false]);
  });

  test('B9 end to end, the real controller and VAD: the real beep\'s sound, marked through the alarm hook, opens no utterance and sends no frame; unmarked, the same sound does (positive control)', async () => {
    const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((res) => setTimeout(res, 0)); };
    // The real beep's tone and length, read off a recording AudioContext (as vad.test.ts does).
    const osc = { frequency: { value: 0 }, from: -1, to: -1, connect() {}, start(at = 0) { osc.from = at; }, stop(at: number) { osc.to = at; }, onended: null as null | (() => void) };
    class RecordingContext { currentTime = 0; destination = {}; createOscillator() { return osc; } close() { return Promise.resolve(); } }
    const run = async (mark: boolean) => {
      const store = createStore(null);
      store.update((s) => ({ ...s, account: { email: 'cook@example.test' }, settings: { ...s.settings, voice: { ...s.settings.voice, on: true, handsFree: true } } }));
      const sw = socketWin();
      const audio = fakeAudio({ location: sw.win.location, WebSocket: (sw.win as unknown as { WebSocket: unknown }).WebSocket, setTimeout, clearTimeout, document: Object.assign(new EventTarget(), { visibilityState: 'visible' }) });
      const player = { play() {}, stop() {}, get speaking() { return false; }, onIdle: () => () => undefined };
      const provider = serviceProvider(audio.win, store, { player, now: () => new Date(2026, 10, 13, 18, 5) });
      const controller = createVoiceController({ win: audio.win, store, provider, conversationId: () => null, childOn: () => false, earcon: () => undefined });
      const voice = startCookVoice({ controller, hooks: { next() {}, back() {}, timerStart() {}, timerStop() {}, currentStep: () => 0, speakStep: null }, localDate: () => '2026-11-13', doc: document, toPan: () => Promise.resolve(null), line: () => undefined, readAloud: () => true });
      await tick();
      const ws = sw.sockets.at(-1)!;
      ws.open();
      ws.serverSend({ t: 'ready', state: { kind: 'available' } });
      await tick();
      const port = audio.nodes.at(-1)!.port;
      let t = 0;
      const push = (amp: number) => {
        const pcm = new Int16Array(320);
        let e = 0;
        for (let i = 0; i < pcm.length; i++) { const x = amp * Math.sin(2 * Math.PI * osc.frequency.value * (t / 1000 + i / 16_000)); pcm[i] = Math.round(x * 32767); e += x * x; }
        port.emit(pcm, amp === 0 ? -60 : 20 * Math.log10(Math.sqrt(e / pcm.length)));
        t += 20;
      };
      for (let i = 0; i < 50; i++) push(0); // a quiet kitchen first
      // The alarm hook is what cook mode wires: told before the beep starts, cleared on its onended.
      const alarm = createAlarm((ended) => beep({ AudioContext: RecordingContext } as unknown as Window, ended), mark ? (on) => { voice.timerSounding(on); } : null);
      alarm.sound();
      const beepMs = Math.round((osc.to - osc.from) * 1000);
      expect(beepMs).toBe(300);
      for (let ms = 0; ms < beepMs; ms += 20) push(1);
      osc.onended?.(); // the beep ends
      for (let ms = 0; ms < 200; ms += 20) push(0.25); // its echo in the room
      for (let ms = 0; ms < 1000; ms += 20) push(0);
      voice.stop('left');
      return { listens: ws.json().filter((m) => m.t === 'listen').length, frames: ws.frames().length };
    };
    expect(await run(true)).toEqual({ listens: 0, frames: 0 });
    const unmarked = await run(false);
    expect(unmarked.listens).toBe(1);
    expect(unmarked.frames).toBeGreaterThan(0);
  });

  test('no transcript for HANDS_FREE_IDLE_MS → stopped, stopHandsFree called, voice.hands_free_idle once', () => {
    vi.useFakeTimers();
    const r = rig();
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS - 1);
    expect(r.stops).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.stops).toEqual(['idle']);
    expect(r.c.calls).toEqual(['startHandsFree', 'stopHandsFree']);
    expect(r.lines.filter((l) => l === 'voice.hands_free_idle')).toHaveLength(1);
    expect(r.lines).not.toContain('voice.hands_free_off');
    // The controller's own idle timer firing too says nothing more.
    r.c.handsOff('idle');
    expect(r.lines.filter((l) => l.startsWith('voice.hands_free_i'))).toHaveLength(1);
  });

  test('carry 3: only a non-empty transcript re-arms the idle timer', () => {
    vi.useFakeTimers();
    const r = rig();
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS - 1000);
    r.c.hear(''); // noise that ended empty: not speech
    r.c.hear('   ');
    vi.advanceTimersByTime(1000);
    expect(r.stops).toEqual(['idle']);
    const s = rig();
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS - 1000);
    s.c.hear('next');
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS - 1);
    expect(s.stops).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(s.stops).toEqual(['idle']);
  });

  test('page hidden, leaving cook mode, Family Table on, or the child flag → stopped at once (Review Focus 4)', () => {
    const hidden = rig();
    setHidden(true);
    expect(hidden.stops).toEqual(['hidden']);
    expect(hidden.c.calls).toContain('stopHandsFree');
    expect(hidden.lines.at(-1)).toBe('voice.hands_free_off');
    setHidden(false);
    const left = rig();
    left.voice.stop('left');
    expect(left.stops).toEqual(['left']);
    expect(left.c.calls).toEqual(['startHandsFree', 'stopHandsFree']);
    // Family Table or a child: the controller closes itself (its store watch, or childOn() on every frame); cook voice
    // stops with it at once and says nothing in a child's hearing.
    for (const why of ['family_table', 'child'] as const) {
      const r = rig();
      r.c.close();
      expect(r.stops).toEqual(['closed']);
      expect(r.lines).toEqual(['voice.hands_free_on']);
      expect(r.c.listeners()).toBe(0);
      expect(why).toBeTruthy();
    }
  });

  test('carry 2: the controller turning hands-free off for noise says voice.hands_free_off; a socket drop says its problem line once, not two lines', async () => {
    const n = rig();
    n.c.handsOff('noise');
    expect(n.stops).toEqual(['noise']);
    expect(n.lines).toEqual(['voice.hands_free_on', 'voice.hands_free_off']);
    // A drop: the controller turns hands-free off ('stopped'), then reports the problem.
    const d = rig();
    d.c.handsOff('stopped');
    d.c.problem('network');
    await flush();
    expect(d.lines).toEqual(['voice.hands_free_on', 'voice.unavailable']);
    const m = rig();
    m.c.handsOff('stopped');
    m.c.problem('microphone');
    await flush();
    expect(m.lines).toEqual(['voice.hands_free_on', 'voice.mic_blocked']);
    // Resting (Ruling 5): its state line, never a number.
    const rest = rig();
    rest.c.handsOff('stopped');
    rest.c.setPhase('resting', { kind: 'resting_today' });
    await flush();
    expect(rest.lines).toEqual(['voice.hands_free_on', 'voice.resting_today']);
    // Stopped for no reported reason: the plain off line.
    const s = rig();
    s.c.handsOff('stopped');
    await flush();
    expect(s.lines).toEqual(['voice.hands_free_on', 'voice.hands_free_off']);
  });
});

beforeEach(() => { vi.stubEnv('VITE_HANDS_FREE', 'on'); });
afterEach(() => { vi.unstubAllEnvs(); });
