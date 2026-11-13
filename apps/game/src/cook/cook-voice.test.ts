// @vitest-environment happy-dom
import { HANDS_FREE_IDLE_MS, cookCommand, type SpeakItem, type VoiceState } from '@kitchenquest/core/engine';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Said } from '../mentor/dialogue';
import type { PanReply } from '../mentor/reply';
import type { HandsFreeOff, VoicePhase, VoiceProblem } from '../voice';
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

const said = (text: string): PanReply => ({ items: [{ kind: 'said', said: { trigger: 'mentor.reply', text, ai: 'allowed', index: 0, part: 0 } }], cards: [], intents: [], actions: [], notice: null, replyId: 'r-1' });

/** The deps every test needs but doesn't look at. */
const quietDeps = {
  localDate: () => '2026-11-13', doc: document, toPan: () => Promise.resolve(null),
  say: (t: string): Said => ({ trigger: t, text: t, ai: 'never', index: 0 }), show: () => undefined, answered: () => undefined, readAloud: () => true,
  openCards: () => [],
};
const noHooks: CookVoiceHooks = { next() {}, back() {}, timerStart: () => false, timerStop: () => 'which', currentStep: () => 0, stepCount: () => 3, speakStep: null };

function rig(opts: {
  speakStep?: { slug: string } | null; toPan?: (text: string, id: number, tooLong?: boolean) => Promise<PanReply | null>; readAloud?: boolean;
  step?: number; timerStart?: () => boolean; timerStop?: () => 'stopped' | 'which'; cards?: () => string[];
} = {}) {
  const c = fakeController();
  let step = opts.step ?? 0;
  const total = 4;
  const log: string[] = [];
  /** Every Pan line drawn: the first-paint bank's (`say`) and the cues' (`show`). */
  const lines: string[] = [];
  const toPan: { text: string; id: number }[] = [];
  const overLong: string[] = [];
  const stops: string[] = [];
  const answered: { r: PanReply; tap: boolean }[] = [];
  const hooks: CookVoiceHooks = {
    next: () => { log.push('next'); if (step < total - 1) step++; },
    back: () => { log.push('back'); if (step > 0) step--; },
    timerStart: () => { log.push('timerStart'); return opts.timerStart?.() ?? true; },
    timerStop: () => { log.push('timerStop'); return opts.timerStop?.() ?? 'stopped'; },
    currentStep: () => step,
    stepCount: () => total,
    speakStep: opts.speakStep === undefined ? { slug: 'india/kerala/parippu' } : opts.speakStep,
  };
  const voice = startCookVoice({
    controller: c, hooks, localDate: () => '2026-11-13', doc: document,
    toPan: (text, id, tooLong) => {
      if (tooLong === true) { overLong.push(text); return opts.toPan ? opts.toPan(text, id, true) : Promise.resolve(null); }
      toPan.push({ text, id });
      return opts.toPan ? opts.toPan(text, id) : Promise.resolve(said('Keep it moving.'));
    },
    say: (t) => { lines.push(t); return { trigger: t, text: `[${t}]`, ai: 'never', index: 1 }; },
    show: (r) => { for (const i of r.items) if (i.kind === 'said') lines.push(i.said.trigger); },
    answered: (r, tap) => { answered.push({ r, tap }); },
    openCards: opts.cards ?? (() => []),
    readAloud: () => opts.readAloud ?? true,
    onStop: (why) => { stops.push(why); },
  });
  return { c, voice, log, lines, toPan, overLong, stops, answered, step: () => step };
}
/** The var-free lines a controller was asked to speak (Ruling 15: by trigger and index, never text). */
const spokenLines = (c: ReturnType<typeof fakeController>) => c.said.flatMap((p) => p.items).flatMap((i) => (i.kind === 'line' ? [i.trigger] : []));
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
    startCookVoice({ ...quietDeps, controller: c, hooks: noHooks, say: (t) => { lines.push(t); return quietDeps.say(t); }, onStop: (w) => stops.push(w) });
    expect(lines).toEqual([]);
    expect(stops).toEqual(['refused']);
  });

  test('"next" on step index 0 of a canon dish shows index 1 and says { kind: "step", slug, step: 1 }; a frame dish advances and only ever says voice.step_on_screen (fix round 1, M1)', () => {
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
    // Back on the first step: it stays, and the step on screen is read again (never silence, M1).
    r.c.hear('back');
    expect(r.c.said.at(-1)).toEqual({ items: [{ kind: 'step', slug: 'india/kerala/parippu', step: 0, localDate: '2026-11-13' }], said: [] });
    // A Pantry Frame (Ruling 11): it advances; its steps are never read, only the var-free voice.step_on_screen.
    const f = rig({ speakStep: null });
    f.c.hear('next');
    f.c.hear('repeat');
    expect(f.step()).toBe(1);
    expect(f.c.said.flatMap((p) => p.items).some((i) => i.kind === 'step')).toBe(false);
    expect(f.c.said).toEqual([0, 1].map(() => ({ items: [{ kind: 'line', trigger: 'voice.step_on_screen', index: 1 }], said: ['[voice.step_on_screen]'] })));
  });

  test('"start the timer" / "stop the timer" call the existing hooks; "stop listening" stops and says voice.hands_free_off', () => {
    const r = rig();
    r.c.hear('start the timer');
    r.c.hear('ok stop the timer thanks');
    expect(r.log).toEqual(['timerStart', 'timerStop']);
    // Fix round 1 (I3, M1): each says, aloud and in the panel, what happened (var-free cues, by index).
    expect(spokenLines(r.c)).toEqual(['voice.cook.timer_started', 'voice.cook.timer_stopped']);
    expect(r.c.said.every((p) => p.said.length === 1 && p.said[0] !== '')).toBe(true);
    // No timer to start, or no single timer that just went off: said so, and the hook stopped nothing.
    const none = rig({ timerStart: () => false, timerStop: () => 'which' });
    none.c.hear('start the timer');
    none.c.hear('stop the alarm');
    expect(spokenLines(none.c)).toEqual(['voice.cook.no_timer', 'voice.cook.timer_which']);
    expect(none.lines).toEqual(['voice.hands_free_on', 'voice.cook.no_timer', 'voice.cook.timer_which']);
    r.c.hear('stop listening');
    expect(r.c.calls).toEqual(['startHandsFree', 'stopHandsFree']);
    expect(r.lines.filter((l) => l.startsWith('voice.hands_free'))).toEqual(['voice.hands_free_on', 'voice.hands_free_off']);
    expect(r.stops).toEqual(['user']);
    // Stopped: nothing more is heard, said, or told twice.
    expect(r.c.listeners()).toBe(0);
    const before = r.lines.length;
    r.voice.stop('user');
    expect(r.lines).toHaveLength(before);
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
    // Fix round 3 (N1): a too-long utterance is never a command and is never sent: voice.too_long, said aloud.
    const t = rig();
    t.c.hear('next', true);
    await flush();
    expect(t.log).toEqual([]);
    expect(t.toPan).toEqual([]);
    expect(spokenLines(t.c)).toEqual(['voice.too_long']);
  });

  test('carry 6 (Rulings 10 and 12): a spoken "yes" or "confirm" is no cook command and never confirms anything here; fix round 2: in hands-free it is not even sent to the Pan', () => {
    for (const yes of ['yes', 'yes please', 'confirm', 'that\'s right', 'yes that\'s what I said']) expect(cookCommand(yes)).toBeNull();
    const r = rig();
    r.c.hear('yes');
    expect(r.log).toEqual([]);
    expect(r.toPan).toEqual([]);
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
      const voice = startCookVoice({ ...quietDeps, controller, hooks: noHooks });
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
    expect(left.lines).toEqual(['voice.hands_free_on']); // fix round 1 (M6): leaving says nothing, as a close doesn't
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

describe('M7 Step 10 fix round 1', () => {
  test('I4: on the last step a spoken "next" never finishes: it says voice.cook.last_step; loose chatter ("what now", "carry on", "and then") is no command there and goes the Pan\'s way; elsewhere it still moves the step', () => {
    const r = rig({ step: 3 });
    r.c.hear('next step');
    r.c.hear('ok next please');
    expect(r.log).toEqual([]);
    expect(r.step()).toBe(3);
    expect(spokenLines(r.c)).toEqual(['voice.cook.last_step', 'voice.cook.last_step']);
    for (const chatter of ['what now', 'carry on', 'and then', "what's next", 'go on']) r.c.hear(chatter);
    expect(r.log).toEqual([]);
    expect(r.toPan.map((t) => t.text)).toEqual(['what now', 'carry on', 'and then', "what's next", 'go on']);
    // Not the last step: the same words are navigation.
    const mid = rig({ step: 1 });
    mid.c.hear('carry on');
    expect(mid.log).toEqual(['next']);
    expect(mid.toPan).toEqual([]);
  });

  test('I5: a reply is handed to cook mode with whether it needs a tap (a card or a heard card); a plain reply needs none', async () => {
    const card = { ...said('Here.'), cards: [{ origin: 'local', localId: 'l1' } as unknown as PanReply['cards'][number]] };
    const heard: PanReply = { ...said('I heard sesame.'), items: [{ kind: 'heard', check: { terms: [] } as never, utteranceId: 1, onPick: () => Promise.resolve(said('')) }] };
    for (const [reply, tap] of [[said('Two minutes.'), false], [card, true], [heard, true]] as const) {
      const r = rig({ toPan: () => Promise.resolve(reply) });
      r.c.hear('how long do I keep stirring');
      await flush();
      expect(r.answered).toEqual([{ r: reply, tap }]);
    }
  });

  test('M3: a problem that did not stop hands-free is never reused for a later plain stop', async () => {
    const r = rig();
    r.c.problem('network'); // reported while hands-free stayed on
    await flush();
    r.c.handsOff('stopped');
    await flush();
    expect(r.lines).toEqual(['voice.hands_free_on', 'voice.hands_free_off']);
  });
});

describe('M7 Step 10 fix round 2 (controller ruling): in hands-free a spoken yes confirms nothing', () => {
  test('"yes please", "yes", "confirm" and the like never reach the Pan; with a card open the cue voice.cook.tap_card is said once per card', () => {
    let cards = ['server:p-1'];
    const r = rig({ cards: () => cards });
    r.c.hear('yes please');
    r.c.hear('yes');
    r.c.hear('yes it is');
    expect(r.toPan).toEqual([]);
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_card']); // once for this card
    expect(r.lines.filter((l) => l === 'voice.cook.tap_card')).toHaveLength(1);
    // A second card: once more, for it.
    cards = ['server:p-1', 'local:l-2'];
    r.c.hear('yep');
    r.c.hear('confirm');
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_card', 'voice.cook.tap_card']);
    expect(r.toPan).toEqual([]);
    // No card open: still never sent. Fix round 3 (m3): it says so, drawn and aloud (voice.cook.tap_answer).
    const none = rig();
    none.c.hear('yes please');
    expect(none.toPan).toEqual([]);
    expect(spokenLines(none.c)).toEqual(['voice.cook.tap_answer']);
    expect(none.lines).toContain('voice.cook.tap_answer');
    // A yes inside a sentence is no confirmation: it goes the Pan's way (the heard check first).
    const q = rig({ cards: () => ['server:p-1'] });
    q.c.hear('yes how long do I keep stirring');
    expect(q.toPan.map((t) => t.text)).toEqual(['yes how long do I keep stirring']);
  });

  test('concern 5: a reply cook mode is handed to speak (a heard-card tap\'s) is spoken from speakPlan only, while on and read-aloud is on', () => {
    const r = rig();
    r.voice.speak(said('Saved.'));
    expect(r.c.said.at(-1)).toEqual({ items: [{ kind: 'reply', replyId: 'r-1', part: 0 }], said: ['Saved.'] });
    const quiet = rig({ readAloud: false });
    quiet.voice.speak(said('Saved.'));
    expect(quiet.c.said).toEqual([]);
    r.voice.stop('user');
    const n = r.c.said.length;
    r.voice.speak(said('Saved.'));
    expect(r.c.said).toHaveLength(n);
  });
});

describe('M7 Step 10 fix round 3', () => {
  test('N1: "yes please" heard over 30 s of radio (too long) is never sent: the yes guard runs first, whatever the length', async () => {
    const r = rig({ cards: () => ['server:p-1'] });
    r.c.hear('yes please', true);
    r.c.hear('no', true);
    expect(r.toPan).toEqual([]);
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_card']);
    // Any other too-long utterance: voice.too_long, and nothing sent.
    r.c.hear('how long do I keep stirring', true);
    await flush();
    expect(r.toPan).toEqual([]);
    expect(spokenLines(r.c).at(-1)).toBe('voice.too_long');
  });

  test('N2: a strict "no" ("no", "nope", "not quite", "cancel") is never sent in hands-free; the same once-per-card cue answers it', () => {
    let cards = ['server:p-1'];
    const r = rig({ cards: () => cards });
    for (const no of ['no', 'nope', 'not quite', 'cancel']) r.c.hear(no);
    r.c.hear('yes');
    expect(r.toPan).toEqual([]);
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_card']); // once for this card, yes or no
    cards = ['server:p-1', 'server:p-2'];
    r.c.hear('no');
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_card', 'voice.cook.tap_card']);
    // A "no" inside a sentence is no answer: it goes the Pan's way.
    const q = rig({ cards: () => ['server:p-1'] });
    q.c.hear('no idea how long to stir this');
    expect(q.toPan.map((t) => t.text)).toEqual(['no idea how long to stir this']);
  });
});

describe('M7 Step 10 fix round 4', () => {
  test('emergency over-long: a too-long transcript goes to the Pan only for its safety scan; a safety reply is drawn and spoken; plain chatter gets the too-long cue', async () => {
    const em = { ...said('Call 999.'), replyId: null };
    const r = rig({ toPan: (_t, _id, tooLong) => Promise.resolve(tooLong === true ? em : null) });
    r.c.hear('… my throat is closing', true);
    await flush();
    expect(r.overLong).toEqual(['… my throat is closing']);
    expect(r.toPan).toEqual([]); // never as a turn
    expect(r.answered).toEqual([{ r: em, tap: false }]);
    expect(r.c.said.at(-1)!.items[0].kind).not.toBe('step');
    expect(spokenLines(r.c)).not.toContain('voice.too_long');
    const chat = rig();
    chat.c.hear('the travel news on the ring road', true);
    await flush();
    expect(chat.overLong).toHaveLength(1);
    expect(spokenLines(chat.c)).toEqual(['voice.too_long']);
  });

  test('tap_answer: once per session; again only after a tap answer, or once HANDS_FREE_IDLE_MS has passed since it was last said', () => {
    vi.useFakeTimers();
    const r = rig();
    for (let i = 0; i < 4; i++) r.c.hear('yes');
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_answer']);
    expect(r.lines.filter((l) => l === 'voice.cook.tap_answer')).toHaveLength(1);
    // After a tap answer (a card stamped or turned down), once more.
    r.voice.tapped();
    r.c.hear('no');
    r.c.hear('no');
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_answer', 'voice.cook.tap_answer']);
    // Ten minutes after it was last said (real speech keeps hands-free awake meanwhile), once more.
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS / 2);
    r.c.hear('how long do I keep stirring');
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS / 2 - 1);
    r.c.hear('yes');
    expect(spokenLines(r.c)).toHaveLength(2);
    r.c.hear('how long do I keep stirring');
    vi.advanceTimersByTime(1);
    r.c.hear('yes');
    expect(spokenLines(r.c)).toEqual(['voice.cook.tap_answer', 'voice.cook.tap_answer', 'voice.cook.tap_answer']);
    expect(r.lines.filter((l) => l === 'voice.cook.tap_answer')).toHaveLength(3);
  });

  test('a swallowed yes or no does not re-arm the idle timer: a radio that only says "yes" can\'t hold the microphone open', () => {
    vi.useFakeTimers();
    const r = rig({ cards: () => ['server:p-1'] });
    vi.advanceTimersByTime(HANDS_FREE_IDLE_MS - 1000);
    r.c.hear('yes please');
    r.c.hear('no');
    vi.advanceTimersByTime(1000);
    expect(r.stops).toEqual(['idle']);
  });
});
