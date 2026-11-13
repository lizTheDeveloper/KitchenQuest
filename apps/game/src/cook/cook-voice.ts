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
// Fix round 1 (controller rulings):
// - I3: "stop the timer" / "stop the alarm" never stops a running timer. Cook mode stops only the one timer that is
//   sounding or just finished; none, or more than one, is `voice.cook.timer_which` and nothing stops.
// - I4: a spoken "next" never finishes the dish. On the last step it says `voice.cook.last_step`; loose chatter that
//   cookCommand reads as "next" ("what now", "carry on") is no command there at all (game-side narrowing: core's
//   commands.ts is hashed and stays as it is).
// - I5: the Pan's reply is spoken, and cook mode is told whether it needs a tap (`answered`): only then does the panel
//   open, and never taking focus.
// - M1: every command is answered aloud: a frame's step is `voice.step_on_screen`, a timer command its cue.
//
// Fix rounds 2 and 3 (controller rulings): in hands-free a spoken yes or no answers nothing, so a radio or another
// person in the room can never confirm or turn down a card; an over-long utterance is never sent at all (N1). A strict yes (core `classifyTurn`, as the API reads it) is never sent; with a card
// waiting the Pan says `voice.cook.tap_card`, once per card. Device-only: the turn's wire input (core
// mentor/protocol.ts, hashed) has no hands-free field, so the API cannot tell a hands-free transcript apart.
//
// Hands-free turns itself off after HANDS_FREE_IDLE_MS with no transcript (only a non-empty one re-arms it), when the
// page is hidden, on leaving cook mode, for steady noise (the controller's 'noise'), and whenever the controller closes
// (Family Table, a child, signed out, voice off: Rulings 8 and 9).
import { classifyTurn, cookCommand, HANDS_FREE_IDLE_MS, stripPageEvents, type SpeakItem } from '@kitchenquest/core/engine';
import type { Said } from '../mentor/dialogue';
import { restingUntil } from '../mentor/resting';
import type { PanItem, PanReply } from '../mentor/reply';
import { cookCue } from './cook-voice-copy';
import type { HandsFreeOff, VoiceController, VoiceProblem } from '../voice';
import { speakPlan } from '../voice/speak-plan';

export interface CookVoiceHooks {
  /** One step on; never finishes the dish (I4: finishing is a tap). */
  next(): void;
  back(): void;
  /** This step's first timer that isn't running; false when there is none. */
  timerStart(): boolean;
  /** I3: the one timer sounding or just finished, stopped; 'which' when none or several (nothing stops). */
  timerStop(): 'stopped' | 'which';
  /** 0-based, as SpeakItem.step (P12). */
  currentStep(): number;
  stepCount(): number;
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
  /** Fix round 2 (concern 5): speak a reply drawn in the panel outside a spoken turn (a heard card's tap). */
  speak(r: PanReply): void;
}

export interface CookVoiceDeps {
  controller: VoiceController;
  hooks: CookVoiceHooks;
  localDate: () => string;
  doc: Document;
  /** The Pan's spoken turn: the player's bubble and the reply drawn in the panel (heard check first). The reply, or null. */
  toPan(text: string, utteranceId: number): Promise<PanReply | null>;
  /** A scripted first-paint Pan line, drawn in the panel (`getMentor().say`): the line as said. */
  say(trigger: string, vars?: Record<string, string>): Said;
  /** A reply drawn in the panel (`getMentor().show`): the lazy cues. */
  show(r: PanReply): void;
  /** I5: the Pan answered (drawn in the panel, closed or not); `needsTap`: it holds a card or a heard card to tap. */
  answered(r: PanReply, needsTap: boolean): void;
  /** Fix round 2: the keys of the cards open in the panel (each waits for its tap). */
  openCards(): readonly string[];
  /** settings.voice.readAloud: the Pan's replies are spoken (a step asked for by voice is read either way). */
  readAloud(): boolean;
  /** Told once, when it stops (the caller closes the controller, drops the wake lock hold and redraws). */
  onStop?(why: CookVoiceStop): void;
}

const END_WAIT = { items: [] as SpeakItem[], said: [] as string[] };
/** What a reply can hold that only a tap answers (I5). */
const TAP_ITEMS: ReadonlySet<PanItem['kind']> = new Set(['heard', 'choices', 'quick', 'consent']);
const needsTap = (r: PanReply): boolean => r.cards.length > 0 || r.items.some((i) => TAP_ITEMS.has(i.kind));
/**
 * I4 (game-side narrowing): on the last step only a deliberate "next" ("next", "next step", "ok next please") counts;
 * chatter that cookCommand also reads as next ("what now", "what's next", "carry on", "and then") does not.
 */
/**
 * Fix rounds 2 and 3: a strict yes or no, read as the API reads a turn's text (stripped of page-event lookalikes
 * first). In hands-free neither is ever sent: a card waits for its tap.
 */
const isAnswer = (text: string): boolean => {
  const intent = classifyTurn(stripPageEvents(text).text.trim());
  return intent === 'yes' || intent === 'no';
};
const deliberateNext = (text: string): boolean => {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  return words.includes('next') && !words.some((w) => w.startsWith('what'));
};
const problemLine = (p: VoiceProblem): string =>
  (p === 'microphone' ? 'voice.mic_blocked' : p === 'consent_required' ? 'voice.consent_needed' : 'voice.unavailable');

export function startCookVoice(deps: CookVoiceDeps): CookVoice {
  const { controller: c, hooks, doc } = deps;
  let on = true;
  let idle: ReturnType<typeof setTimeout> | null = null;
  /** Bumped by every transcript: only the newest turn's reply is spoken (Ruling 10: the older one is drawn, not said). */
  let turn = 0;
  /** A problem reported with a 'stopped' (in the same task): its line replaces the plain off line. M3: never later. */
  let told: string | null = null;
  const line = (trigger: string, vars?: Record<string, string>) => { deps.say(trigger, vars); };
  /** Say a var-free line aloud by index (Ruling 15), drawn too. */
  const speakSaid = (said: Said) => { c.say({ items: [{ kind: 'line', trigger: said.trigger, index: said.index }], said: [said.text] }); };
  const cue = (trigger: string) => {
    const said = cookCue(trigger);
    deps.show({ items: [{ kind: 'said', said }], cards: [], intents: [], actions: [], notice: null });
    speakSaid(said);
  };
  const unsubs: (() => void)[] = [];

  const end = (why: CookVoiceStop, lineId: string | null, vars?: Record<string, string>) => {
    if (!on) return;
    on = false;
    if (idle !== null) clearTimeout(idle);
    idle = null;
    for (const u of unsubs.splice(0)) u();
    doc.removeEventListener('visibilitychange', onVisibility);
    if (c.handsFree) c.stopHandsFree();
    if (lineId !== null) line(lineId, vars);
    deps.onStop?.(why);
  };
  const armIdle = () => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => { idle = null; end('idle', 'voice.hands_free_idle'); }, HANDS_FREE_IDLE_MS);
  };
  const onVisibility = () => { if (doc.visibilityState === 'hidden') end('hidden', 'voice.hands_free_off'); };

  /** Read the step now on screen: a canon dish by slug (the API decides, Ruling 11), else `voice.step_on_screen` (M1). */
  const readStep = () => {
    const s = hooks.speakStep;
    if (s === null) { speakSaid(deps.say('voice.step_on_screen')); return; }
    c.say({ items: [{ kind: 'step', slug: s.slug, step: hooks.currentStep(), localDate: deps.localDate() }], said: [] });
  };
  const moving = (go: () => void) => {
    go();
    if (on) readStep();
  };
  const lastStep = () => hooks.currentStep() >= hooks.stepCount() - 1;
  /** The cards already told "tap it" (once per card). */
  const cued = new Set<string>();
  const speakReply = (r: PanReply) => {
    if (!deps.readAloud()) { c.say(END_WAIT); return; }
    c.say(speakPlan(r.items, r.cards, { replyId: r.replyId ?? null }));
  };

  const heard = (text: string, tooLong: boolean, utteranceId: number) => {
    if (!on) return;
    const mine = ++turn;
    // Carry 3 (Step 8 I1): only real words are speech; noise that ended empty never keeps hands-free awake.
    if (text.trim() !== '') armIdle();
    // Fix rounds 2 and 3 (N1, N2): a spoken yes or no is never sent, whatever its length (a radio holding the VAD open
    // for MAX_UTTERANCE_MS can still come back as "yes please"); a waiting card hears "tap it" once.
    if (isAnswer(text)) {
      const fresh = deps.openCards().filter((k) => !cued.has(k));
      if (fresh.length > 0) {
        for (const k of fresh) cued.add(k);
        cue('voice.cook.tap_card');
      } else if (deps.openCards().length === 0) cue('voice.cook.tap_answer'); // m3: never dropped without a word
      else c.say(END_WAIT);
      return;
    }
    // N1: an over-long utterance is never sent to the Pan (nor read as a command): tap or type it instead.
    if (tooLong) { speakSaid(deps.say('voice.too_long')); return; }
    let command = cookCommand(text);
    // I4: on the last step, chatter is no command (it goes to the Pan); a deliberate "next" is answered, never obeyed.
    if (command === 'next' && lastStep()) {
      if (deliberateNext(text)) return cue('voice.cook.last_step');
      command = null;
    }
    switch (command) {
      case 'next': return moving(() => { hooks.next(); });
      case 'back': return moving(() => { hooks.back(); });
      case 'repeat': return readStep();
      case 'timer_start': return cue(hooks.timerStart() ? 'voice.cook.timer_started' : 'voice.cook.no_timer');
      case 'timer_stop': return cue(hooks.timerStop() === 'stopped' ? 'voice.cook.timer_stopped' : 'voice.cook.timer_which');
      case 'stop_listening': return end('user', 'voice.hands_free_off');
      case 'ingredients': // not a step command here: the Pan answers it (cook mode lists no ingredients)
      case null: break; // everything else: the Pan's (the heard check first)
    }
    void deps.toPan(text, utteranceId).then((r) => {
      if (!on || mine !== turn) return; // stopped, or the player spoke again meanwhile: drawn, never said over it
      if (r === null) { c.say(END_WAIT); return; }
      deps.answered(r, needsTap(r));
      speakReply(r);
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
    c.onProblem((p) => {
      if (p === 'family_table' || p === 'child') return;
      // M3: only for a 'stopped' in this same task (its microtask runs first); then it is forgotten.
      told ??= problemLine(p);
      queueMicrotask(() => { told = null; });
    }),
  );
  doc.addEventListener('visibilitychange', onVisibility);
  c.startHandsFree();
  if (!c.handsFree) end('refused', null);
  else {
    armIdle();
    line('voice.hands_free_on');
  }

  return {
    get on() { return on; },
    stop(reason) {
      // M6: leaving says nothing (cook.done or the refusal follows); the others say why it went quiet.
      end(reason, reason === 'left' ? null : reason === 'idle' ? 'voice.hands_free_idle' : 'voice.hands_free_off');
    },
    timerSounding(sounding) { if (on) c.timerSounding(sounding); },
    speak(r) { if (on && deps.readAloud()) speakReply(r); },
  };
}
