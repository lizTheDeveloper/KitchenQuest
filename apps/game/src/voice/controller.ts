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
import { MicStartTimeout, openMic, type Mic } from './capture';
import { sizzle } from './earcon';
import { VoiceSocketClosed } from './socket';
import type { ProviderEvent, Speech, Utterance, VoiceProvider } from './providers';
import { handsFreeBuild } from './providers';
import { createVad, type Vad, type VadOptions } from './vad';

export type VoicePhase = 'off' | 'idle' | 'listening' | 'transcribing' | 'waiting' | 'speaking' | 'resting';
/** Why the controller closed: one of the rules that forbid a microphone, or the caller's own `close()`. */
export type VoiceOffReason = 'family_table' | 'child' | 'signed_out' | 'off';
/** Something the player should hear about: the socket closed (and why), or the microphone was refused. */
export type VoiceProblem = VoiceCloseReason | 'network' | 'microphone';
export type HandsFreeOff = 'idle' | 'hidden' | 'noise' | 'stopped' | 'closed';

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
  /**
   * Fix round 3 (I-A): the browser granted the microphone after the player had let go (on a first press they let go to
   * answer its prompt). Nothing was heard and the microphone is closed again; the caller says it is ready.
   */
  onMicReady(fn: () => void): () => void;
  /** Fix round 2 (Step 9, I-2): the API answered a hello (`ready`): voice is open for this account now. */
  onReady(fn: (state: VoiceState) => void): () => void;
  /**
   * Hands-free turned itself off: `idle` (HANDS_FREE_IDLE_MS without a transcript), `hidden` (the page), `noise`
   * (utterances ran to the cap back to back: a steady sound, fix round 1 I1; Step 10 says `voice.hands_free_off`),
   * `stopped` (asked, or the socket went), `closed`.
   */
  onHandsFreeOff(fn: (why: HandsFreeOff) => void): () => void;
  close(reason?: VoiceOffReason): void;
}

/** How far the Pan's own voice, or a cook timer's alarm, raises the VAD threshold (Review Focus 3, B9). */
export const RAISED_DB = 12;
const MAX_FRAMES = MAX_UTTERANCE_MS / FRAME_MS;
/** Fix round 1 (I1): this many hands-free utterances in a row ending at the cap is noise: hands-free turns off. */
const CAPPED_IN_A_ROW = 2;
/** Fix round 1 (M2): the socket closed for one of these: nothing is reopened until the caller re-checks (a new controller). */
const TERMINAL: readonly VoiceProblem[] = ['consent_required', 'signed_out', 'bad_origin', 'unavailable'];

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
  openMic?: (win: Window, opts?: { onStream?: (stop: () => void) => void }) => Promise<Mic>;
  earcon?: (win: Window) => void;
  now?: () => Date;
  createVad?: (o: VadOptions) => Vad;
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
  const readyFns = new Set<(s: VoiceState) => void>();
  const micReadyFns = new Set<() => void>();
  const handsOff = new Set<(w: HandsFreeOff) => void>();

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
  /** Fix round 1 (M3): hands-free speech heard while the last transcript is out; it is sent once that arrives. */
  let deferred: { frames: Int16Array[]; ended: boolean } | null = null;
  /** Fix round 1 (I1): hands-free utterances in a row that ran to the cap. */
  let cappedRun = 0;
  /** Fix round 1 (M2): a terminal close, after which nothing reopens. */
  let terminal: VoiceProblem | null = null;
  /** Bumped by every press and release, so a slow hello or microphone answers only the press that asked. */
  let gesture = 0;

  const setPhase = (p: VoicePhase) => {
    if (phase === p) return;
    phase = p;
    for (const fn of [...phaseFns]) fn(p, state);
  };
  const problem = (p: VoiceProblem) => {
    if (TERMINAL.includes(p)) terminal = p;
    for (const fn of [...problems]) fn(p);
  };
  /** M2: true (and the caller told why) when a terminal close forbids reopening. */
  const refused = (): boolean => {
    if (terminal === null) return false;
    problem(terminal);
    return true;
  };
  const wantMic = () => !closed && (holding || handsFree);

  /** R1: the tracks of a microphone still opening (its context starting), stoppable before its handle arrives. */
  let pendingStop: (() => void) | null = null;
  let pendingStopped = false;
  const closeMic = () => {
    mic?.close();
    mic = null;
    if (pendingStop !== null) {
      pendingStop();
      pendingStop = null;
      pendingStopped = true;
    }
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
    deferred = null;
    if (l !== null && !closed) l.u.cancel();
  };

  const ensureHello = (): Promise<VoiceState> => {
    hello ??= provider.hello(deps.conversationId(), localDate(now())).then(
      (s) => {
        state = s;
        if (!closed) for (const fn of [...readyFns]) fn(s);
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
    if (micOpening === null) pendingStopped = false;
    micOpening ??= mic$(win, {
      onStream: (stop) => {
        // R1: live tracks, before the context has started: stop them now if nothing wants them, else keep the stop.
        // Step 9 (G3): a rule that forbids a microphone now (a device-only child flag has no store change and no frame
        // yet) stops them at once and closes the controller.
        if (!wantMic() || closed || forbidden(store.get(), deps.childOn()) !== null) {
          stop();
          pendingStopped = true;
          // I-A: granted, but the press had already ended: the permission result is never silent.
          if (!guard() && !wantMic()) for (const fn of [...micReadyFns]) fn();
        } else pendingStop = stop;
      },
    }).then(
      (m): Mic | null | Promise<Mic | null> => {
        micOpening = null;
        pendingStop = null;
        const stopped = pendingStopped;
        // Closed (Family Table, a child, …) or no longer wanted while the browser asked: stopped the moment it arrives.
        if (stopped || !wantMic() || guard()) {
          pendingStopped = false;
          m.close();
          // Step 9 (G1): a press or a hands-free start since its tracks were stopped wants a microphone: a fresh one.
          return stopped && wantMic() ? ensureMic() : null;
        }
        mic = m;
        m.onFrame(onFrame);
        return m;
      },
      (e: unknown): Mic | null | Promise<Mic | null> => {
        micOpening = null;
        pendingStop = null;
        const stopped = pendingStopped;
        pendingStopped = false;
        if (closed) return null;
        // G1: stopped, then wanted again before it failed: try a fresh one.
        if (stopped && wantMic()) return ensureMic();
        // Step 9 (G2), narrowed by fix round 1 (I-3): only a start that timed out after the player let go is stale. A
        // permission refusal is always reported: on a first press the player lets go to answer the browser's prompt.
        if (!wantMic() && e instanceof MicStartTimeout) return null;
        // G1: hands-free is never left on with no microphone.
        if (handsFree) stopHandsFree('stopped');
        problem('microphone');
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
      // I1: only a real transcript is speech; noise ends empty and never keeps hands-free awake.
      if (l.mode === 'handsFree' && r.text !== '') armIdle();
      for (const fn of [...transcripts]) fn(r.text, r.tooLong, l.u.id);
      runDeferred();
    });
  };

  /** M3: speech heard while the last transcript was out goes now, as its own utterance. */
  function runDeferred() {
    const d = deferred;
    deferred = null;
    if (d === null || closed || !handsFree || live !== null) return;
    if (speech !== null) stopSpeech();
    const l = startListen('handsFree');
    setPhase('listening');
    for (const f of d.frames) push(l, f);
    if (d.ended) finish(l);
  }

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
      if (phase === 'resting') return;
      // M3: the last transcript is still out: kept (in memory, bounded) until it arrives.
      if (live !== null) {
        // Fix round 2 (F3): a second start while the transcript is still out is added to the held speech, never over it.
        if (deferred === null) deferred = { frames: [...r.start], ended: false };
        else {
          deferred.frames.push(...r.start.slice(0, Math.max(0, MAX_FRAMES - deferred.frames.length)));
          deferred.ended = false;
        }
        return;
      }
      if (speech !== null) stopSpeech(); // barge-in: BARGE_IN_MIN_MS over the raised threshold (Ruling 7)
      const l = startListen('handsFree');
      setPhase('listening');
      for (const f of r.start) push(l, f);
      return;
    }
    const l = live;
    if (l !== null && l.mode === 'handsFree' && !l.ending) {
      if (r.speech) push(l, r.speech);
      if (r.end) finish(l);
    } else if (deferred !== null && !deferred.ended) {
      if (r.speech && deferred.frames.length < MAX_FRAMES) deferred.frames.push(r.speech);
      if (r.end) deferred.ended = true;
    }
    if (r.end) {
      // I1: utterances that run to the cap back to back are a steady sound, not a player.
      cappedRun = r.capped ? cappedRun + 1 : 0;
      if (cappedRun >= CAPPED_IN_A_ROW) stopHandsFree('noise');
    }
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
  // Ruling 7, and fix round 1 (M1): a hidden page stops hands-free and releases a held press (a lost pointerup).
  const onVisibility = () => {
    if (doc?.visibilityState !== 'hidden') return;
    if (holding) ctl.release();
    stopHandsFree('hidden');
  };
  const onPageHide = () => {
    if (holding) ctl.release();
    stopHandsFree('hidden');
  };
  /** A test window may have no events of its own. */
  const winEvents = win as Partial<Pick<Window, 'addEventListener' | 'removeEventListener'>>;
  doc?.addEventListener('visibilitychange', onVisibility);
  winEvents.addEventListener?.('pagehide', onPageHide);

  function stopHandsFree(w: HandsFreeOff) {
    if (!handsFree) return;
    handsFree = false;
    vad = null;
    deferred = null;
    cappedRun = 0;
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
      if (guard() || holding || phase === 'resting' || refused()) return;
      const g = ++gesture;
      if (speech !== null) stopSpeech(); // barge-in
      if (live !== null) dropLive(); // a newer press replaces an answer still on its way
      holding = true;
      early = [];
      setPhase('listening');
      // Read through a call: an await may have closed it, or a release or a newer press moved on, meanwhile.
      const stale = () => closed || g !== gesture;
      const held = () => holding;
      void (async () => {
        let s: VoiceState;
        try { s = await ensureHello(); } catch { if (!stale()) { holding = false; setPhase('idle'); } return; }
        if (stale()) return;
        if (s.kind !== 'available') { holding = false; setPhase('resting'); return; }
        if (held() && (await ensureMic()) === null && !stale()) { holding = false; setPhase('idle'); return; }
        if (stale() || !held()) return;
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
      // C9 (fix round 1, M7): binding here too, not only in the UI.
      if (guard() || handsFree || !handsFreeBuild() || refused()) return;
      handsFree = true;
      // I1: the cap counts the pre-roll, so an utterance never sends more than MAX_UTTERANCE_MS of frames.
      vad = (deps.createVad ?? createVad)({
        hangoverMs: VAD_HANGOVER_MS, minSpeechMs: MIN_SPEECH_MS, preRollMs: PRE_ROLL_MS, raisedDb: RAISED_DB, maxSpeechMs: MAX_UTTERANCE_MS - PRE_ROLL_MS,
      });
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
      if (closed || terminal !== null) return;
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
    onReady(fn) { readyFns.add(fn); return () => { readyFns.delete(fn); }; },
    onMicReady(fn) { micReadyFns.add(fn); return () => { micReadyFns.delete(fn); }; },
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
      winEvents.removeEventListener?.('pagehide', onPageHide);
      clearIdle();
      setPhase('off');
      transcripts.clear();
      phaseFns.clear();
      problems.clear();
      readyFns.clear();
      micReadyFns.clear();
      handsOff.clear();
    },
  };
  return ctl;
}
