// M7 Step 8: the voice controller. It alone owns the microphone, the VAD and the socket, for hold-to-talk and for
// hands-free (P10). It refuses to exist in Family Table, for a child, signed out or with voice off (Rulings 8 and 9),
// and closes itself, the microphone and the socket at once the moment any of those becomes true.
//
// C-18: audio and transcripts live in memory only. Frames go from the microphone to the socket and are dropped;
// transcripts go to `onTranscript` listeners and are not kept. Nothing here writes to the store or to storage.
// Ruling 7: in hands-free mode only frames from PRE_ROLL_MS before detected speech to its end leave the device.
import {
  FRAME_MS,
  HANDS_FREE_IDLE_MS,
  MAX_UTTERANCE_MS,
  MIN_SPEECH_MS,
  PRE_ROLL_MS,
  VAD_HANGOVER_MS,
  type SpeakItem,
  type VoiceCloseReason,
  type VoiceState,
} from '@kitchenquest/core/engine';
import type { PlayerState, PlayerStore } from '../state/store';
import { openMic, type Mic } from './capture';
import { sizzle } from './earcon';
import { VoiceSocketClosed } from './socket';
import type { ProviderEvent, Speech, Utterance, VoiceProvider } from './providers';
import { createVad, type Vad } from './vad';

export type VoicePhase = 'off' | 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'resting';
/** Why the controller closed: one of the rules that forbid a microphone, or the caller's own `close()`. */
export type VoiceOffReason = 'family_table' | 'child' | 'signed_out' | 'off';
/** Something the player should hear about: the socket closed (and why), or the microphone was refused. */
export type VoiceProblem = VoiceCloseReason | 'network' | 'microphone';

export interface VoiceController {
  readonly phase: VoicePhase;
  readonly lastUtteranceId: number | null;
  /** The allowance as the API last said it; null before the first hello. */
  readonly state: VoiceState | null;
  readonly handsFree: boolean;
  /** Why it is off; null while it is not. */
  readonly closedReason: VoiceOffReason | null;
  /** press while speaking = barge-in (§7.7): the Pan stops, and a new utterance starts. */
  press(): void;
  release(): void;
  /** The continuous VAD loop (P10). */
  startHandsFree(): void;
  stopHandsFree(): void;
  /** A cook timer's alarm is sounding: the VAD's threshold is raised meanwhile (B9). */
  timerSounding(on: boolean): void;
  /** Speak a plan (speak-plan.ts). An empty plan ends the wait after a transcript. */
  say(plan: { items: SpeakItem[]; said: string[] }): void;
  onTranscript(fn: (text: string, tooLong: boolean, utteranceId: number) => void): () => void;
  onPhase(fn: (p: VoicePhase, state: VoiceState | null) => void): () => void;
  onProblem(fn: (p: VoiceProblem) => void): () => void;
  /** Hands-free turned itself off: `idle` (HANDS_FREE_IDLE_MS without speech), `hidden` (the page), `stopped` (asked). */
  onHandsFreeOff(fn: (why: 'idle' | 'hidden' | 'stopped' | 'closed') => void): () => void;
  close(reason?: VoiceOffReason): void;
}

/** How far the Pan's own voice, or a cook timer's alarm, raises the VAD threshold (Review Focus 3, B9). */
export const RAISED_DB = 12;
const MAX_FRAMES = MAX_UTTERANCE_MS / FRAME_MS;

interface Live { u: Utterance; mode: 'hold' | 'handsFree'; frames: number; ending: boolean; epoch: number }

/** Whichever rule forbids a microphone now (Rulings 8 and 9), or null. */
function forbidden(s: PlayerState, childOn: boolean): VoiceOffReason | null {
  if (s.settings.familyTable) return 'family_table';
  if (childOn) return 'child';
  if (s.account === null) return 'signed_out';
  if (!s.settings.voice.on) return 'off';
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function createVoiceController(deps: {
  win: Window;
  store: PlayerStore;
  provider: VoiceProvider;
  conversationId: () => string | null;
  childOn: () => boolean;
  /** Test seams: the microphone, the earcon and the clock. */
  openMic?: (win: Window) => Promise<Mic>;
  earcon?: (win: Window) => void;
  now?: () => Date;
}): VoiceController {
  const { win, store, provider } = deps;
  const why = forbidden(store.get(), deps.childOn());
  if (why === 'family_table') throw new Error('voice: no microphone in Family Table (Ruling 9)');
  if (why === 'child') throw new Error('voice: no microphone for a child (§19)');
  if (why === 'signed_out') throw new Error('voice: needs a signed in account (Ruling 8)');
  if (why === 'off') throw new Error('voice: voice is off');
  const mic$ = deps.openMic ?? openMic;
  const earcon = deps.earcon ?? sizzle;
  const now = deps.now ?? (() => new Date());

  const transcripts = new Set<(text: string, tooLong: boolean, id: number) => void>();
  const phaseFns = new Set<(p: VoicePhase, s: VoiceState | null) => void>();
  const problems = new Set<(p: VoiceProblem) => void>();
  const handsOff = new Set<(w: 'idle' | 'hidden' | 'stopped' | 'closed') => void>();

  let phase: VoicePhase = 'idle';
  let closed = false;
  let closedReason: VoiceOffReason | null = null;
  let state: VoiceState | null = null;
  let lastUtteranceId: number | null = null;
  let hello: Promise<VoiceState> | null = null;
  /** Bumped when the socket goes away: an answer from before it is never delivered (Review Focus 5). */
  let epoch = 0;
  let mic: Mic | null = null;
  let micOpening: Promise<Mic | null> | null = null;
  let live: Live | null = null;
  let holding = false;
  /** A press's frames while its listen is on its way. */
  let early: Int16Array[] = [];
  let speech: Speech | null = null;
  let handsFree = false;
  let vad: Vad | null = null;
  let vadT = 0;
  const raised = { pan: false, timer: false };
  let idleTimer: number | null = null;
  /** Bumped by every press and release, so a slow hello or microphone answers only the press that asked. */
  let gesture = 0;

  const setPhase = (p: VoicePhase) => {
    if (phase === p) return;
    phase = p;
    for (const fn of [...phaseFns]) fn(p, state);
  };
  const problem = (p: VoiceProblem) => { for (const fn of [...problems]) fn(p); };
  const wantMic = () => !closed && (holding || handsFree);

  const closeMic = () => {
    mic?.close();
    mic = null;
  };
  const closeMicUnlessWanted = () => { if (!wantMic()) closeMic(); };

  /** Checks the rules; closes everything when one forbids a microphone now. True when closed. */
  const guard = (): boolean => {
    if (closed) return true;
    const w = forbidden(store.get(), deps.childOn());
    if (w === null) return false;
    ctl.close(w);
    return true;
  };

  const clearIdle = () => {
    if (idleTimer !== null) win.clearTimeout(idleTimer);
    idleTimer = null;
  };
  const armIdle = () => {
    clearIdle();
    if (handsFree) idleTimer = win.setTimeout(() => { idleTimer = null; stopHandsFree('idle'); }, HANDS_FREE_IDLE_MS);
  };

  const stopSpeech = () => {
    const s = speech;
    speech = null;
    raised.pan = false;
    vad?.setRaised('pan', false);
    s?.stop();
  };

  /** Drops the utterance in flight (its answer is never delivered). Sends `cancel` unless the controller is closed. */
  const dropLive = () => {
    const l = live;
    live = null;
    early = [];
    if (l !== null && !closed) l.u.cancel();
  };

  const ensureHello = (): Promise<VoiceState> => {
    hello ??= provider.hello(deps.conversationId(), localDate(now())).then(
      (s) => {
        state = s;
        return s;
      },
      (e: unknown) => {
        hello = null;
        const reason = e instanceof VoiceSocketClosed ? e.reason : 'network';
        if (!closed) {
          if (reason === 'family_table' || reason === 'child') ctl.close(reason);
          else problem(reason);
        }
        throw e;
      },
    );
    return hello;
  };

  const ensureMic = (): Promise<Mic | null> => {
    if (mic !== null) return Promise.resolve(mic);
    micOpening ??= mic$(win).then(
      (m) => {
        micOpening = null;
        // Closed (Family Table, a child, …) or no longer wanted while the browser asked: stopped the moment it arrives.
        if (!wantMic() || guard()) {
          m.close();
          return null;
        }
        mic = m;
        m.onFrame(onFrame);
        return m;
      },
      () => {
        micOpening = null;
        if (!closed) problem('microphone');
        return null;
      },
    );
    return micOpening;
  };

  const startListen = (mode: 'hold' | 'handsFree'): Live => {
    const u = provider.listen(mode);
    lastUtteranceId = u.id;
    const l: Live = { u, mode, frames: 0, ending: false, epoch };
    live = l;
    return l;
  };

  const push = (l: Live, pcm: Int16Array) => {
    if (l.ending || live !== l) return;
    l.u.push(pcm);
    if (++l.frames >= MAX_FRAMES) finish(l); // MAX_UTTERANCE_MS: ends here, as the API would
  };

  /** The utterance ends: the sizzle at once, then its transcript, delivered only if nothing replaced it meanwhile. */
  const finish = (l: Live) => {
    if (l.ending) return;
    l.ending = true;
    earcon(win);
    setPhase('transcribing');
    if (l.mode === 'hold') holding = false;
    closeMicUnlessWanted();
    void l.u.end().then((r) => {
      if (live !== l) return; // cancelled, replaced or closed
      live = null;
      if (closed || l.epoch !== epoch || phase === 'resting') return; // the socket went, or the allowance refused it
      setPhase('waiting');
      for (const fn of [...transcripts]) fn(r.text, r.tooLong, l.u.id);
    });
  };

  function onFrame(pcm: Int16Array, db: number) {
    if (guard()) return; // the child flag lives outside the store: every frame checks it
    const t = vadT;
    vadT += FRAME_MS;
    if (holding) {
      if (live !== null && live.mode === 'hold') push(live, pcm);
      else if (early.length < MAX_FRAMES) early.push(pcm);
      return;
    }
    if (!handsFree || vad === null) return;
    const r = vad.push(pcm, db, t);
    if (r.start) {
      armIdle();
      if (phase === 'transcribing' || phase === 'resting') return;
      if (speech !== null) stopSpeech(); // barge-in: BARGE_IN_MIN_MS over the raised threshold (Ruling 7)
      const l = startListen('handsFree');
      setPhase('listening');
      for (const f of r.start) push(l, f);
      return;
    }
    const l = live;
    if (l === null || l.mode !== 'handsFree' || l.ending) return;
    if (r.speech) push(l, r.speech);
    if (r.end) finish(l);
  }

  const onProvider = (e: ProviderEvent) => {
    if (closed) return;
    if (e.kind === 'state') {
      state = e.state;
      if (e.state.kind === 'available') {
        if (phase === 'resting') setPhase('idle');
        return;
      }
      // Resting: the utterance in flight was answered; nothing new is heard until it lifts (Ruling 5).
      holding = false;
      dropLive();
      stopHandsFree('stopped');
      closeMic();
      setPhase('resting');
      return;
    }
    // The socket went (Review Focus 5): nothing is retried; the next press opens a new one.
    hello = null;
    epoch++;
    if (e.reason === 'family_table' || e.reason === 'child') return ctl.close(e.reason);
    holding = false;
    live = null;
    early = [];
    speech = null;
    raised.pan = false;
    vad?.setRaised('pan', false);
    stopHandsFree('stopped');
    closeMic();
    setPhase('idle');
    problem(e.reason);
  };
  const unProvider = provider.onEvent(onProvider);
  const unStore = store.subscribe(() => { guard(); });
  const doc = (win as Partial<Window>).document;
  const onVisibility = () => { if (doc?.visibilityState === 'hidden') stopHandsFree('hidden'); };
  doc?.addEventListener('visibilitychange', onVisibility);

  function stopHandsFree(w: 'idle' | 'hidden' | 'stopped' | 'closed') {
    if (!handsFree) return;
    handsFree = false;
    vad = null;
    clearIdle();
    if (live?.mode === 'handsFree' && !live.ending) dropLive();
    closeMicUnlessWanted();
    if (phase === 'listening' && !holding) setPhase('idle');
    for (const fn of [...handsOff]) fn(w);
  }

  const ctl: VoiceController = {
    get phase() { return phase; },
    get lastUtteranceId() { return lastUtteranceId; },
    get state() { return state; },
    get handsFree() { return handsFree; },
    get closedReason() { return closedReason; },

    press() {
      // Resting: no microphone (Ruling 5). The caller shows the state line; a new controller asks again.
      if (guard() || holding || phase === 'resting') return;
      const g = ++gesture;
      if (speech !== null) stopSpeech(); // barge-in
      if (live !== null) dropLive(); // a newer press replaces an answer still on its way
      holding = true;
      early = [];
      setPhase('listening');
      void (async () => {
        let s: VoiceState;
        try { s = await ensureHello(); } catch { if (g === gesture && !closed) { holding = false; setPhase('idle'); } return; }
        if (closed || g !== gesture) return;
        if (s.kind !== 'available') { holding = false; setPhase('resting'); return; }
        if (holding && (await ensureMic()) === null && g === gesture && !closed) { holding = false; setPhase('idle'); return; }
        if (closed || g !== gesture || !holding) return;
        const l = startListen('hold');
        const waiting = early;
        early = [];
        for (const f of waiting) push(l, f);
      })();
    },

    release() {
      if (closed || !holding) return;
      ++gesture;
      const l = live;
      if (l !== null && l.mode === 'hold') return finish(l);
      // Released before the listen went (hello or the microphone still on its way): nothing was heard.
      holding = false;
      early = [];
      closeMicUnlessWanted();
      if (phase === 'listening') setPhase('idle');
    },

    startHandsFree() {
      if (guard() || handsFree) return;
      handsFree = true;
      vad = createVad({ hangoverMs: VAD_HANGOVER_MS, minSpeechMs: MIN_SPEECH_MS, preRollMs: PRE_ROLL_MS, raisedDb: RAISED_DB });
      if (raised.timer) vad.setRaised('timer', true);
      if (raised.pan) vad.setRaised('pan', true);
      armIdle();
      void ensureHello().then(
        (s) => {
          if (closed || !handsFree) return;
          if (s.kind !== 'available') { stopHandsFree('stopped'); setPhase('resting'); return; }
          void ensureMic();
        },
        () => { stopHandsFree('stopped'); },
      );
    },

    stopHandsFree() { stopHandsFree('stopped'); },

    timerSounding(on) {
      raised.timer = on;
      vad?.setRaised('timer', on);
    },

    say(plan) {
      if (closed) return;
      if (plan.items.length === 0 && plan.said.length === 0) {
        if (phase === 'waiting') setPhase('idle');
        return;
      }
      if (holding || (live !== null && !live.ending)) return; // the player is talking: the screen has it
      stopSpeech();
      const g = gesture;
      void ensureHello().then((s) => {
        if (closed || g !== gesture || holding || s.kind !== 'available') return;
        const mine = provider.speak(plan.items, plan.said);
        speech = mine;
        raised.pan = true;
        vad?.setRaised('pan', true);
        setPhase('speaking');
        void mine.done.then(() => {
          if (speech !== mine) return;
          speech = null;
          raised.pan = false;
          vad?.setRaised('pan', false);
          if (phase === 'speaking') setPhase('idle');
        });
      }, () => undefined);
    },

    onTranscript(fn) { transcripts.add(fn); return () => { transcripts.delete(fn); }; },
    onPhase(fn) { phaseFns.add(fn); return () => { phaseFns.delete(fn); }; },
    onProblem(fn) { problems.add(fn); return () => { problems.delete(fn); }; },
    onHandsFreeOff(fn) { handsOff.add(fn); return () => { handsOff.delete(fn); }; },

    close(reason = 'off') {
      if (closed) return;
      // At once, in this order: no more frames (the microphone), then the socket. Nothing more is sent: no cancel.
      closed = true;
      closedReason = reason;
      holding = false;
      closeMic();
      live = null;
      early = [];
      speech = null;
      stopHandsFree('closed');
      provider.close();
      unProvider();
      unStore();
      doc?.removeEventListener('visibilitychange', onVisibility);
      clearIdle();
      setPhase('off');
      transcripts.clear();
      phaseFns.clear();
      problems.clear();
      handsOff.clear();
    },
  };
  return ctl;
}
