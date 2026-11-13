// M7 Step 10: hands-free cook mode (spec §7.7, Ruling 7). A lazy module: cook mode loads it, with the voice client,
// only when the player turns hands-free on, so first paint never carries it (B8).
//
// The controller (Step 8) owns the microphone, the VAD and the socket (P10). This module only routes what it hears:
// - a closed cook command (core `cookCommand`: the whole utterance is one) drives the step runner;
// - next / back / repeat read the step on screen aloud as a `step` speak item, for a canon dish only. The API reads it
//   only when the dish checks ✅ with no swap and no margin note, else it says `voice.step_on_screen` (Ruling 11);
//   a Pantry Frame, or a dish cooked with notes, is never read (`speakStep: null`);
// - anything else goes to the Pan (`toPan`: Step 9's `transcriptTurn`, the heard check first, Ruling 4). Its reply is
//   drawn there and spoken only as `speakPlan` items (Ruling 15; R9: the model's text is never spoken).
// A spoken command never confirms a card: only the Pan's own turn sees a "yes", and severe and heard cards stay
// tap-only (Rulings 10 and 12). Barge-in (the controller) stops audio only: a turn already sent is still drawn.
//
// Hands-free turns itself off after HANDS_FREE_IDLE_MS with no transcript (only a non-empty one re-arms it), when the
// page is hidden, on leaving cook mode, for steady noise (the controller's 'noise'), and whenever the controller closes
// (Family Table, a child, signed out, voice off: Rulings 8 and 9).
import { cookCommand, HANDS_FREE_IDLE_MS, type SpeakItem } from '@kitchenquest/core/engine';
import { restingUntil } from '../mentor/resting';
import type { PanReply } from '../mentor/reply';
import type { HandsFreeOff, VoiceController, VoiceProblem } from '../voice';
import { speakPlan } from '../voice/speak-plan';

export interface CookVoiceHooks {
  next(): void;
  back(): void;
  timerStart(): void;
  timerStop(): void;
  /** 0-based, as SpeakItem.step (P12). */
  currentStep(): number;
  /** null: Pantry Frames and dishes cooked with notes are never read (Ruling 11). */
  speakStep: { slug: string } | null;
}

/** Why cook voice stopped: the caller's four, or the controller's (noise, a close, a problem), or it never started. */
type CookVoiceStop = 'user' | 'idle' | 'left' | 'hidden' | 'noise' | 'closed' | 'stopped' | 'refused';

export interface CookVoice {
  readonly on: boolean;
  stop(reason: 'user' | 'idle' | 'left' | 'hidden'): void;
  /** A cook timer's alarm is sounding (timers.ts `createAlarm`, B9): the controller raises its VAD threshold. */
  timerSounding(on: boolean): void;
}

export interface CookVoiceDeps {
  controller: VoiceController;
  hooks: CookVoiceHooks;
  localDate: () => string;
  doc: Document;
  /** The Pan's spoken turn: the player's bubble and the reply drawn in the panel (heard check first). The reply, or null. */
  toPan(text: string, utteranceId: number): Promise<PanReply | null>;
  /** A scripted Pan line in the panel (`getMentor().say`). */
  line(trigger: string, vars?: Record<string, string>): void;
  /** settings.voice.readAloud: the Pan's replies are spoken (a step asked for by voice is read either way). */
  readAloud(): boolean;
  /** Told once, when it stops (the caller closes the controller, drops the wake lock hold and redraws). */
  onStop?(why: CookVoiceStop): void;
}

const END_WAIT = { items: [] as SpeakItem[], said: [] as string[] };
const problemLine = (p: VoiceProblem): string =>
  (p === 'microphone' ? 'voice.mic_blocked' : p === 'consent_required' ? 'voice.consent_needed' : 'voice.unavailable');

export function startCookVoice(deps: CookVoiceDeps): CookVoice {
  const { controller: c, hooks, doc } = deps;
  let on = true;
  let idle: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every transcript: only the newest turn's reply is spoken (Ruling 10: the older one is drawn, not said). */
  let turn = 0;
  /** A problem reported with a 'stopped': its line replaces the plain off line. */
  let told: string | null = null;
  const unsubs: (() => void)[] = [];

  const end = (why: CookVoiceStop, line: string | null, vars?: Record<string, string>) => {
    if (!on) return;
    on = false;
    if (idle !== null) clearTimeout(idle);
    idle = null;
    for (const u of unsubs.splice(0)) u();
    doc.removeEventListener('visibilitychange', onVisibility);
    if (c.handsFree) c.stopHandsFree();
    if (line !== null) deps.line(line, vars);
    deps.onStop?.(why);
  };
  const armIdle = () => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; end('idle', 'voice.hands_free_idle'); }, HANDS_FREE_IDLE_MS);
  };
  const onVisibility = () => { if (doc.visibilityState === 'hidden') end('hidden', 'voice.hands_free_off'); };

  /** Read the step now on screen (a canon dish only), else just end the controller's wait. */
  const readStep = (moved: boolean) => {
    const s = hooks.speakStep;
    if (!moved || s === null) { c.say(END_WAIT); return; }
    c.say({ items: [{ kind: 'step', slug: s.slug, step: hooks.currentStep(), localDate: deps.localDate() }], said: [] });
  };
  const moving = (go: () => void) => {
    const before = hooks.currentStep();
    go();
    if (on) readStep(hooks.currentStep() !== before);
  };

  const heard = (text: string, tooLong: boolean, utteranceId: number) => {
    if (!on) return;
    const mine = ++turn;
    // Carry 3 (Step 8 I1): only real words are speech; noise that ended empty never keeps hands-free awake.
    if (text.trim() !== '') armIdle();
    const command = tooLong ? null : cookCommand(text);
    switch (command) {
      case 'next': return moving(() => { hooks.next(); });
      case 'back': return moving(() => { hooks.back(); });
      case 'repeat': return readStep(true);
      case 'timer_start': hooks.timerStart(); return c.say(END_WAIT);
      case 'timer_stop': hooks.timerStop(); return c.say(END_WAIT);
      case 'stop_listening': return end('user', 'voice.hands_free_off');
      case 'ingredients': // not a step command here: the Pan answers it (cook mode lists no ingredients)
      case null: break; // everything else: the Pan's (the heard check first)
    }
    void deps.toPan(text, utteranceId).then((r) => {
      if (!on || mine !== turn) return; // stopped, or the player spoke again meanwhile: drawn, never said over it
      if (r === null || !deps.readAloud()) { c.say(END_WAIT); return; }
      c.say(speakPlan(r.items, r.cards, { replyId: r.replyId ?? null }));
    }, () => { if (on && mine === turn) c.say(END_WAIT); });
  };

  const handsOff = (w: HandsFreeOff) => {
    if (!on) return;
    if (w === 'idle') return end('idle', 'voice.hands_free_idle');
    if (w === 'hidden') return end('hidden', 'voice.hands_free_off');
    if (w === 'noise') return end('noise', 'voice.hands_free_off'); // carry 2
    if (w === 'closed') return end('closed', null); // Family Table, a child, signed out: nothing said in their hearing
    // 'stopped' (a dropped socket, a refused microphone, a rest): its reason is reported right after, in this task.
    queueMicrotask(() => {
      if (told !== null) return end('stopped', told);
      if (c.phase === 'resting') {
        const s = c.state;
        return s !== null && s.kind === 'resting' ? end('stopped', 'voice.resting', { until: restingUntil(s.until) }) : end('stopped', 'voice.resting_today');
      }
      end('stopped', 'voice.hands_free_off');
    });
  };

  unsubs.push(
    c.onTranscript(heard),
    c.onHandsFreeOff(handsOff),
    c.onProblem((p) => { if (p !== 'family_table' && p !== 'child') told ??= problemLine(p); }),
  );
  doc.addEventListener('visibilitychange', onVisibility);
  c.startHandsFree();
  if (!c.handsFree) end('refused', null);
  else {
    armIdle();
    deps.line('voice.hands_free_on');
  }

  return {
    get on() { return on; },
    stop(reason) {
      end(reason, reason === 'idle' ? 'voice.hands_free_idle' : 'voice.hands_free_off');
    },
    timerSounding(sounding) { if (on) c.timerSounding(sounding); },
  };
}
