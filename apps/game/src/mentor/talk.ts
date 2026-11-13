// M7 Step 9: talking to the Pan. The panel's talk control, a lazy module: first paint carries only the panel's empty
// row for it (B8), and the voice client (../voice) loads from here.
//
// - Shown only signed in (Ruling 8), in standard mode, and while no child spoke in the conversation (§19); the panel
//   has no row for it in Family Table (Ruling 9). With voice off it says so and opens Settings → Voice.
// - Hold to talk: pointer, or Space / Enter held on the button. Release → the sizzle → the transcript, shown as the
//   player's bubble marked spoken → `transcriptTurn` (the device heard gate first, Ruling 4).
// - A slow reply speaks `fillerFor(text)` once after FILLER_AFTER_MS (§7.6b.8). The reply is drawn, then spoken as
//   `speakPlan` items only (Ruling 15) while read-aloud is on; with it off `say([])` ends the wait.
// - Pressing while the Pan speaks stops the audio (barge-in); the reply stays drawn (Ruling 10).
// - A problem is said plainly, once, and the text box takes over (Review Focus 5). Nothing is ever resent.
// - After a terminal close the controller is made afresh on the next press: after a backoff for `unavailable` (the
//   API also sends it for transient errors, F2), after re-reading the consents for `consent_required` (n3). A rest is
//   re-asked by a fresh controller on the next press, so a rest that lifted is noticed (Step 8 concern 3).
// - The child flag closes the controller, and the microphone even while it is still starting, the moment it is set (G3).
import { FILLER_AFTER_MS, fillerFor, type VoiceState } from '@kitchenquest/core/engine';
import { refreshAccount } from '../api/account';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { routeHref } from '../shell/router';
import type { PlayerStore } from '../state/store';
import { h } from '../ui/dom';
import type { VoiceController, VoicePhase, VoiceProblem } from '../voice';
import type { MentorBackend } from './backend';
import type { ChildFlag } from './child-flag';
import type { Dialogue } from './dialogue';
import type { ConsentAnswer, PanReply, TurnContext } from './reply';
import { restingUntil } from './resting';
import { transcriptTurn } from './voice-turn';

export type VoiceLib = typeof import('../voice');

export interface TalkHooks {
  store: PlayerStore;
  client: ApiClient;
  dialogue: Dialogue;
  backend: MentorBackend;
  child?: ChildFlag;
  /** The AI conversation's server id, for the socket's hello. */
  conversationId?: () => string | null;
  /** The player's bubble, marked spoken. */
  spoken(text: string): void;
  /** One Pan turn, drawn. The reply drawn, or null when it was dropped (the conversation was cleared meanwhile). */
  turn(get: (ctx: TurnContext) => Promise<PanReply>): Promise<PanReply | null>;
  /** A reply that is no turn (a line), drawn. */
  show(r: PanReply): void;
  focusText(): void;
  /** The voice consent card (Form 3-C/VOICE) in the conversation. */
  consent(onAnswer: (a: ConsentAnswer) => void): void;
  /** The panel's own spoken-turn replies (a heard card's tap) are spoken through this. */
  setSpeaker(fn: ((r: PanReply) => void) | null): void;
  /** Test seams: the voice library and the window it runs in. */
  voice?: { load?: () => Promise<VoiceLib>; win?: Window };
}

export const TALK_LABEL = 'Hold to talk';
export const TALK_OFF_LABEL = 'Talk out loud';
const HINT_ON = 'Hold the button, or hold Space or Enter on it, and speak. Let go to send.';
const HINT_OFF = 'Voice is off. This opens Settings, where you can turn it on.';
const PHASE_TEXT: Readonly<Record<VoicePhase, string>> = {
  off: TALK_LABEL, idle: TALK_LABEL, listening: 'Listening… let go to send', transcribing: 'Got it…', waiting: 'Got it…',
  speaking: 'Speaking… hold to interrupt', resting: 'Voice is resting',
};
/** F2: how long after an `unavailable` close before a press opens a fresh socket; doubled each time, to the cap. */
export const UNAVAILABLE_BACKOFF_MS = 5_000;
const UNAVAILABLE_BACKOFF_MAX_MS = 60_000;
/** Closes after which nothing reopens until a fresh controller (controller.ts M2). */
const TERMINAL: ReadonlySet<VoiceProblem> = new Set(['consent_required', 'signed_out', 'bad_origin', 'unavailable']);


export function mountTalk(row: HTMLElement, hooks: TalkHooks): { stop(): void } {
  const { store, client, dialogue, child } = hooks;
  const win = hooks.voice?.win ?? row.ownerDocument.defaultView!;
  const btn = h('button', { id: 'pan-talk', type: 'button', class: 'btn btn-secondary pan-talk', 'aria-pressed': 'false', 'aria-describedby': 'pan-talk-hint' }, TALK_LABEL);
  const hint = h('p', { id: 'pan-talk-hint', class: 'field-hint pan-talk-hint' });
  // What the control is doing, for a screen reader too (visible state; the button's own text changes with it).
  const state = h('p', { class: 'pan-talk-state', role: 'status' });
  row.replaceChildren(btn, hint, state);

  const lines = (...triggers: [string, Record<string, string>?][]): PanReply =>
    ({ items: triggers.map(([t, v]) => ({ kind: 'said', said: dialogue.say(t, v) })), cards: [], intents: [], actions: [], notice: null });

  let stopped = false;
  let lib: VoiceLib | null = null;
  let loading: Promise<VoiceLib> | null = null;
  let ctl: VoiceController | null = null;
  /** The current controller can't be used again (a terminal close, a rest): the next press makes a fresh one. */
  let stale = false;
  let backoffUntil = 0;
  let backoffMs = UNAVAILABLE_BACKOFF_MS;
  /** The button is held down now (pointer or key). */
  let held = false;
  /** One plain line per press, however many ways the same failure reports itself (Review Focus 5). */
  let told = false;

  const voiceOn = () => store.get().settings.voice.on;
  const allowed = () => {
    const s = store.get();
    return !stopped && s.account !== null && !s.settings.familyTable && child?.on !== true;
  };

  const draw = (phase: VoicePhase = ctl?.phase ?? 'idle') => {
    row.hidden = !allowed();
    if (!voiceOn()) {
      btn.textContent = TALK_OFF_LABEL;
      btn.setAttribute('aria-pressed', 'false');
      hint.textContent = HINT_OFF;
      btn.dataset.phase = 'off';
      return;
    }
    btn.textContent = PHASE_TEXT[phase];
    btn.setAttribute('aria-pressed', String(phase === 'listening'));
    btn.dataset.phase = phase;
    hint.textContent = HINT_ON;
  };

  const load = (): Promise<VoiceLib> => {
    loading ??= (hooks.voice?.load ?? (() => import('../voice')))().then((m) => (lib = m), (e: unknown) => { loading = null; throw e; });
    return loading;
  };

  const drop = (reason: 'off' | 'child' | 'family_table' | 'signed_out' = 'off') => {
    const c = ctl;
    ctl = null;
    stale = false;
    c?.close(reason);
    hooks.setSpeaker(null);
  };

  const say = (r: PanReply) => { hooks.show(r); speak(r); };
  /** Speak a drawn reply, or end the wait with nothing when read-aloud is off (Step 8 concern 4). */
  function speak(r: PanReply | null) {
    const c = ctl;
    if (c === null || lib === null || c.closedReason !== null) return;
    if (r === null || !store.get().settings.voice.readAloud) { c.say({ items: [], said: [] }); return; }
    c.say(lib.speakPlan(r.items, r.cards, { replyId: r.replyId ?? null }));
  }

  const tell = (r: PanReply, focus = true) => {
    if (told) return;
    told = true;
    hooks.show(r);
    if (focus) hooks.focusText();
  };

  /** n3: the consents are read again first; the card only when voice really isn't granted now. */
  const askConsent = () => {
    void client.consents().then((r) => {
      if (stopped || !allowed()) return;
      const granted = r.ok && !r.data.needsReconsent.includes('voice') && r.data.consents.some((x) => x.purpose === 'voice' && x.withdrawnAt === null && x.current);
      if (granted) return; // it was something else: the next press opens a fresh socket
      hooks.show(lines(['voice.consent_needed']));
      hooks.consent(() => undefined);
    });
  };

  const onProblem = (c: VoiceController, p: VoiceProblem) => {
    if (c !== ctl) return;
    if (TERMINAL.has(p)) stale = true;
    if (p === 'unavailable') {
      backoffUntil = Date.now() + backoffMs;
      backoffMs = Math.min(backoffMs * 2, UNAVAILABLE_BACKOFF_MAX_MS);
    }
    if (p === 'consent_required') { if (!told) { told = true; askConsent(); } return; }
    if (p === 'signed_out') { void refreshAccount(client, store); return; }
    if (p === 'family_table' || p === 'child') return; // the controller closed itself
    tell(lines(['voice.unavailable']));
  };

  const onPhase = (c: VoiceController, phase: VoicePhase, s: VoiceState | null) => {
    if (c !== ctl) return;
    draw(phase);
    if (phase === 'listening') state.textContent = 'Listening.';
    else if (phase === 'transcribing') state.textContent = 'Stopped listening.';
    else if (phase === 'off') state.textContent = '';
    if (phase === 'resting') {
      // Ruling 5: a state, never a number. A fresh controller on the next press asks again (the rest may lift).
      stale = true;
      if (s !== null && s.kind === 'resting') tell(lines(['voice.resting', { until: restingUntil(s.until) }]), true);
      else tell(lines(['voice.resting_today']), true);
    }
  };

  async function spokenTurn(c: VoiceController, text: string, tooLong: boolean, id: number): Promise<void> {
    if (c !== ctl) return;
    if (tooLong) { say(lines(['voice.too_long'])); return; }
    const words = text.trim() !== '';
    if (words) hooks.spoken(text);
    let answered = false;
    // §7.6b.8: a scripted filler while a slow turn runs (spoken only, var-free); the reply replaces it.
    const filler = words && store.get().settings.voice.readAloud
      ? win.setTimeout(() => {
        if (answered || c !== ctl) return;
        const trigger = fillerFor(text, graph, content.ruleTerms);
        const s = dialogue.say(trigger);
        c.say({ items: [{ kind: 'line', trigger, index: s.index }], said: [s.text] });
      }, FILLER_AFTER_MS)
      : null;
    let r: PanReply | null;
    try {
      r = await hooks.turn((ctx) => transcriptTurn(text, id, ctx, { backend: hooks.backend, graph, ruleTerms: content.ruleTerms, dialogue, ...(child ? { child } : {}) }));
    } finally {
      answered = true;
      if (filler !== null) win.clearTimeout(filler);
    }
    if (c === ctl) speak(r);
  }

  /** The controller, made afresh when there is none, it is stale, or it closed itself. */
  async function controller(): Promise<VoiceController | null> {
    if (ctl !== null && !stale && ctl.closedReason === null) return ctl;
    if (stale && Date.now() < backoffUntil) {
      tell(lines(['voice.unavailable']));
      return null;
    }
    const m = await load();
    if (!allowed() || !voiceOn()) return null;
    if (ctl !== null && !stale && ctl.closedReason === null) return ctl; // made meanwhile
    drop();
    const provider = m.providerKind() === 'browser' ? await m.devBrowserProvider(win) : m.serviceProvider(win, store);
    if (!allowed() || !voiceOn()) { provider.close(); return null; }
    const c = m.createVoiceController({ win, store, provider, conversationId: hooks.conversationId ?? (() => null), childOn: () => child?.on === true });
    ctl = c;
    c.onPhase((p, s) => { onPhase(c, p, s); });
    c.onProblem((p) => { onProblem(c, p); });
    c.onTranscript((text, tooLong, id) => { void spokenTurn(c, text, tooLong, id); });
    hooks.setSpeaker((r) => { if (c === ctl) speak(r); });
    return c;
  }

  const press = () => {
    if (held || !allowed()) return;
    if (!voiceOn()) return;
    held = true;
    told = false;
    const now = ctl;
    // Fast path: a live controller hears the press in this same event (barge-in stops the Pan at once).
    if (now !== null && !stale && now.closedReason === null) { now.press(); return; }
    void controller().then((c) => { if (c !== null && held) c.press(); }, (err: unknown) => {
      console.error(err);
      tell(lines(['voice.unavailable']));
    });
  };
  const release = () => {
    if (!held) return;
    held = false;
    ctl?.release();
  };

  btn.addEventListener('pointerdown', (ev) => {
    if (!voiceOn() || ev.button !== 0) return;
    ev.preventDefault();
    try { btn.setPointerCapture(ev.pointerId); } catch { /* not every browser */ }
    btn.focus();
    press();
  });
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  // Step 8 M1: a lost capture is a lost pointerup.
  btn.addEventListener('lostpointercapture', release);
  btn.addEventListener('blur', release);
  btn.addEventListener('contextmenu', (ev) => { if (voiceOn()) ev.preventDefault(); });
  btn.addEventListener('keydown', (ev) => {
    if (!voiceOn() || (ev.key !== ' ' && ev.key !== 'Enter')) return;
    ev.preventDefault();
    if (!ev.repeat) press();
  });
  btn.addEventListener('keyup', (ev) => {
    if (!voiceOn() || (ev.key !== ' ' && ev.key !== 'Enter')) return;
    ev.preventDefault();
    release();
  });
  // Voice off: the control opens Settings → Voice (a tap, or Enter / Space: a click).
  btn.addEventListener('click', () => { if (!voiceOn()) win.location.hash = routeHref({ name: 'settings' }); });

  const sync = () => {
    if (!allowed() || !voiceOn()) {
      held = false;
      if (ctl !== null) drop(child?.on === true ? 'child' : 'off');
    } else if (lib === null) void load().catch((err: unknown) => { console.error(err); });
    draw();
  };
  const unStore = store.subscribe(sync);
  // G3: the moment the child flag is set, the controller and any microphone still starting close.
  const unChild = child?.onChange(sync);
  sync();

  return {
    stop() {
      stopped = true;
      unStore();
      unChild?.();
      drop();
      row.replaceChildren();
    },
  };
}
