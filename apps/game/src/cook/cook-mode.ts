import { timerSeconds, type ParsedRecipe, type RecipeIngredient, type StepItem } from '@kitchenquest/core/engine';
import { content } from '../content';
import { getMentor } from '../mentor';
import type { AppContext } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { announce } from '../ui/announce';
import { showBureauForm } from '../ui/bureau-form';
import type { BureauForm } from '../content/types';
import { contentText, h } from '../ui/dom';
import { localDate, watchLocalDate } from '../recipes/rules';
import type { PlayerState } from '../state/store';
import type { VoiceController } from '../voice';
import type { CookVoice, CookVoiceHooks } from './cook-voice';
import { claimVoice } from '../mentor/voice-owner';
import type { PanReply } from '../mentor/reply';
import { createAlarm, formatClock, formatDuration, remainingMs, startTimer, tick, type RunningTimer } from './timers';
import { createWakeLock, type WakeState } from './wake-lock';

/**
 * Cook mode's step runner (M3), for any source: a canon recipe (cook-screen.ts) or a filled Pantry Frame
 * (frame-cook.ts, M5 Step 10). Steps, timers, the wake lock, keyboard arrows and the certificate are M3's; what the
 * source decides is its dish, its safety strip, its swap labels, what finishing records and whether a change of the
 * player's rules or date still lets it be cooked (a dish that no longer is, is refused at once).
 */
export interface CookModeSource {
  title: string;
  recipe: ParsedRecipe;
  draft: boolean;
  strip(): HTMLElement;
  /** Hands the source a way to redraw the strip itself (the toolkit arrives after first draw, M6 final). */
  onStripStale?(redraw: () => void): void;
  swapFor(ing: RecipeIngredient): string | null;
  /** The cook-mode resume point's key (a canon slug), or null: frames don't resume. */
  progressKey: string | null;
  start: { trigger: string; vars: Record<string, string> };
  done: { trigger: string; vars: Record<string, string> };
  certificate: { form: BureauForm; values: Record<string, string> };
  /** The progress events of finishing (in the background; the certificate shows at once). */
  record(): Promise<void>;
  leave(): void;
  /** After a finish: where to go (the kitchen). */
  after(): void;
  /** What the dish depends on in the player state (re-checked when it changes). */
  inputsKey(s: PlayerState): string;
  /**
   * M7 Step 10 (Ruling 11): hands-free reads a step aloud by the canon slug, and the API reads it only when the dish
   * checks ✅ with no swap and no margin note. null: never read (a Pantry Frame, a dish cooked with notes).
   */
  speakStep: { slug: string } | null;
  /** Checked again on a change: the refusal to show, or what changed (a redrawn strip, swaps, an announcement). */
  recheck(): { refused: HTMLElement; text: string } | { strip: boolean; swaps: boolean; announce: string | null };
}

function amount(i: RecipeIngredient): string {
  if (i.quantity === null) return '';
  const q = String(Math.round(i.quantity * 100) / 100);
  return i.unit ? `${q} ${i.unit}` : q;
}

/**
 * The cook timer's alarm (exported for the voice VAD test, M7 Step 8 fix round 1: B9 is pinned on this very sound).
 * M7 Step 10: `ended` is told when it stops, and false is returned when nothing played (timers.ts `createAlarm`).
 */
export function beep(win: Window, ended?: () => void): boolean {
  try {
    const Ctx = (win as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return false;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.3);
    osc.onended = () => { void ac.close(); ended?.(); };
    return true;
  } catch { return false; /* sound is a nicety */ }
}

const WAKE_NOTE = "This browser can't keep the screen awake. Tap the screen now and then.";
/** M7 Step 10: hands-free cook mode (Ruling 7). The button's name stays; its state is aria-pressed and the hint. */
const HANDS_FREE_LABEL = '🎙 Hands-free';
const HANDS_FREE_OFF_HINT = 'Hands-free is off. Turn it on to cook by voice: say "next step", "repeat", "start the timer" or "stop listening".';
const HANDS_FREE_ON_HINT = 'Hands-free is on. Say "next step", "go back", "repeat", "start the timer" or "stop listening". The screen stays awake meanwhile, and every button still works.';
const LISTENING_TEXT = 'Listening';
/** Fix round 1 (I5): a reply that needed no tap was spoken; the panel stays shut until the player opens it. */
const ANSWERED_TEXT = 'The Pan answered. ';
const ANSWERED_OPEN = 'Open the Pan';
/**
 * Fix round 1 (I2, I3): a timer that finished this recently is still "sounding": it has a Stop button, and a spoken
 * stop may clear it. A running timer is stopped only by its own button, never by voice.
 */
export const TIMER_SOUNDING_MS = 15_000;

/** Runs cook mode in `el` for `src`. Returns the teardown. */
export function runCookMode(el: HTMLElement, ctx: AppContext, src: CookModeSource): () => void {
  const { recipe } = src;
  const doc = el.ownerDocument;
  const win = doc.defaultView!;
  const total = recipe.steps.length;
  doc.title = `${src.title} · Kitchen Quest`;
  const mentor = getMentor();
  const say = (id: string, vars: Record<string, string> = {}) => { mentor.say(id, vars); };
  const announcer = doc.getElementById('announcer');

  const saved = ctx.store.get().cookProgress;
  let step = src.progressKey !== null && saved && saved.slug === src.progressKey && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < total ? saved.step : 0;
  let timers: RunningTimer[] = [];
  let forwardMoves = 0;
  let finished = false;
  let stopped = false;
  const leaving = new AbortController(); // declines the certificate if the player leaves (the back button)

  // Wake lock
  const wakeBtn = h('button', { type: 'button', class: 'btn btn-secondary wake-toggle', 'aria-pressed': 'false' }, '☀ Keep screen awake');
  const wakeNote = h('p', { class: 'wake-note', role: 'note', hidden: true }, WAKE_NOTE);
  // Fix round 1 (M5): the toggle shows the player's own choice; hands-free may hold the lock on meanwhile.
  const showWake = (s: WakeState) => {
    wakeBtn.setAttribute('aria-pressed', String(s === 'on' && wake.wanted));
    wakeNote.hidden = !(s === 'unsupported' || s === 'denied');
  };
  const wake = createWakeLock(win.navigator, doc, showWake);
  void wake.enable().then(showWake);
  wakeBtn.addEventListener('click', () => {
    if (wake.wanted && wake.state === 'on') void wake.disable().then(() => showWake(wake.state));
    else void wake.enable().then(showWake);
  });

  // Layout
  const stepBox = h('div', { class: 'cook-step', 'aria-live': 'polite' });
  const trayList = h('ul', { class: 'timer-list' });
  const tray = h('div', { class: 'timer-tray', role: 'group', 'aria-labelledby': 'timer-tray-title', hidden: true },
    h('h2', { id: 'timer-tray-title' }, 'Running timers'), trayList);
  // M7 Step 10: shown only in a hands-free build, voice and hands-free on in Settings, signed in, standard mode and no
  // child (Rulings 7–9). The pill shows exactly while the microphone is open, and is announced once (role=status).
  const hfBtn = h('button', { type: 'button', class: 'btn btn-secondary hands-free-toggle', 'aria-pressed': 'false', 'aria-describedby': 'hands-free-hint', hidden: true }, HANDS_FREE_LABEL);
  const hfHint = h('p', { id: 'hands-free-hint', class: 'field-hint hands-free-hint', hidden: true }, HANDS_FREE_OFF_HINT);
  const listening = h('p', { class: 'listening-region', role: 'status' });
  // Fix round 1 (I5): "The Pan answered" after a spoken reply that needed no tap, with a button to read it.
  const answered = h('p', { class: 'pan-answered', role: 'status' });
  // Fix round 1 (I4): Done with timers still running names them first; the next tap finishes and stops them.
  const finishWarning = h('p', { class: 'finish-warning', role: 'alert', hidden: true });
  const prev = h('button', { type: 'button', class: 'btn btn-secondary' }, '◀ Previous');
  const next = h('button', { type: 'button', class: 'btn btn-primary' }, 'Next step ▶');
  const leave = h('button', { type: 'button', class: 'btn btn-secondary' }, 'Leave cook mode');
  // tabindex -1: where focus goes when a redraw removes the control that had it.
  const progress = h('p', { class: 'cook-progress', tabindex: -1 });
  // The dish's safety status stays in view while cooking (❓ and the allergy disclaimer included).
  let strip = src.strip();
  el.replaceChildren(
    h('header', { class: 'cook-head' },
      contentText('h1', src.title),
      src.draft ? h('span', { class: 'draft-badge' }, 'Draft recipe') : null,
      strip,
      h('div', { class: 'cook-head-row' }, progress, wakeBtn, hfBtn),
      wakeNote, hfHint, listening, answered),
    stepBox, tray,
    finishWarning,
    h('div', { class: 'cook-controls button-row' }, prev, next),
    h('div', { class: 'button-row' }, leave));

  const itemNode = (item: StepItem, stepNo: number): Node => {
    switch (item.type) {
      case 'text': return doc.createTextNode(item.value);
      case 'cookware': return h('span', { class: 'cookware', 'data-content': '' }, item.name);
      case 'ingredient': {
        const ing = recipe.ingredients[item.index];
        const amt = amount(ing), swap = src.swapFor(ing);
        return h('span', { class: 'ingredient' },
          contentText('strong', ing.displayName ?? ing.name), amt ? ` (${amt})` : null, swap ? ` (${swap})` : null);
      }
      case 'timer': {
        const t = recipe.timers[item.index];
        const seconds = timerSeconds(t);
        const id = `${stepNo}-${item.index}`;
        const visible = `Start ${formatClock(seconds * 1000)} timer`;
        // The accessible name must contain the visible text (WCAG 2.5.3); the words say what "20:00" means.
        const btn = h('button', {
          type: 'button', class: 'btn btn-secondary timer-start', 'data-timer-start': id,
          'aria-label': `${visible}: ${formatDuration(seconds)}, for step ${stepNo}`,
        }, visible);
        btn.addEventListener('click', () => startTimerNow(id, t.name ?? `step ${stepNo}`, stepNo, seconds));
        return btn;
      }
    }
  };

  const renderStep = () => {
    const s = recipe.steps[step];
    progress.textContent = `Step ${step + 1} of ${total}`;
    stepBox.replaceChildren(
      ...(s.section ? [contentText('h2', s.section, { class: 'cook-section' })] : []),
      h('p', { class: 'cook-text' }, ...s.items.map((i) => itemNode(i, step + 1))));
    prev.disabled = step === 0;
    next.textContent = step === total - 1 ? 'Done ▶' : 'Next step ▶';
  };

  /** Redraw the step in place for a change in the dish's findings, keeping focus where it was. */
  const redrawStep = () => {
    const active = doc.activeElement;
    const hadFocus = active instanceof HTMLElement && stepBox.contains(active);
    const timerId = hadFocus ? active.dataset.timerStart ?? null : null;
    renderStep();
    if (!hadFocus) return;
    const same = timerId === null ? null : [...stepBox.querySelectorAll<HTMLElement>('[data-timer-start]')].find((b) => b.dataset.timerStart === timerId);
    (same ?? progress).focus();
  };

  // Timers
  /** When each timer finished, by this page's clock (a sleeping phone finishes it late: it sounds then). */
  const doneAt = new Map<string, number>();
  const sounding = (t: RunningTimer, now: number) => t.done && now - (doneAt.get(t.id) ?? -Infinity) <= TIMER_SOUNDING_MS;
  /** Stops (or clears) one timer: by its Stop button, or by voice when it is the one that just went off (I3). */
  const stopTimer = (id: string) => {
    const t = timers.find((x) => x.id === id);
    if (t === undefined) return;
    const hadFocus = tray.contains(doc.activeElement);
    timers = timers.filter((x) => x !== t);
    doneAt.delete(id);
    announce(announcer, `Timer stopped: ${formatDuration(t.durationMs / 1000)} for step ${t.step}`);
    renderTray();
    if (hadFocus) progress.focus();
  };
  const renderTray = () => {
    const now = ctx.now().getTime();
    tray.hidden = timers.length === 0;
    const items = timers.map((t) => {
      let li = trayList.querySelector<HTMLElement>(`[data-timer="${t.id}"]`);
      if (!li) {
        // I2: a Stop button for each running or sounding timer, named for the timer (WCAG 2.5.3: it contains "Stop").
        const stop = h('button', { type: 'button', class: 'btn btn-secondary timer-stop', 'aria-label': `Stop the ${formatDuration(t.durationMs / 1000)} timer for step ${t.step}` }, 'Stop');
        stop.addEventListener('click', () => { stopTimer(t.id); });
        li = h('li', { 'data-timer': t.id, class: 'timer-item' }, h('span', { class: 'timer-text' }), ' ', stop);
      }
      li.dataset.done = String(t.done);
      const text = `Step ${t.step} · ${t.done ? 'done' : formatClock(remainingMs(t, now))}`;
      const span = li.querySelector('.timer-text')!;
      if (span.textContent !== text) span.textContent = text;
      li.querySelector<HTMLButtonElement>('.timer-stop')!.hidden = t.done && !sounding(t, now);
      return li;
    });
    trayList.replaceChildren(...items);
    const running = timers.filter((t) => !t.done).length;
    leave.textContent = running === 0 ? 'Leave cook mode' : `Leave cook mode (stops ${running} ${running === 1 ? 'timer' : 'timers'})`;
  };
  const startTimerNow = (id: string, label: string, stepNo: number, seconds: number) => {
    if (timers.some((t) => t.id === id && !t.done)) return;
    doneAt.delete(id);
    trayList.querySelector(`[data-timer="${id}"]`)?.remove(); // a restart is a new entry (its Stop names it afresh)
    timers = [...timers.filter((t) => t.id !== id), startTimer({ id, label, step: stepNo, seconds }, ctx.now().getTime())];
    say('cook.timer_start', { time: formatDuration(seconds) });
    renderTray();
  };
  const tickNow = () => {
    if (finished || stopped) return;
    const r = tick(timers, ctx.now().getTime());
    timers = r.timers;
    // Timers follow the wall clock (Date-based), so after a sleep several can finish in one tick: one message.
    if (r.finished.length > 0) {
      // Cleared, then set a moment later, so an identical message is announced again.
      announce(announcer, r.finished.map((t) => `Timer finished: ${formatDuration(t.durationMs / 1000)} for step ${t.step}`).join('. '));
    }
    for (const t of r.finished) {
      doneAt.set(t.id, ctx.now().getTime());
      say('cook.timer_done', { step: `step ${t.step}` });
      alarm.sound();
      try { win.navigator.vibrate?.(200); } catch { /* not supported */ }
    }
    renderTray();
  };
  // B9 (carry 1): hands-free's VAD threshold is raised before the beep starts, and lowered when it ends.
  const alarm = createAlarm((ended) => beep(win, ended), null);
  const interval = setInterval(tickNow, 250);
  doc.addEventListener('visibilitychange', tickNow);

  // Moving between steps
  const go = (to: number) => {
    if (to < 0 || to >= total || to === step) return;
    const forward = to > step;
    step = to;
    finishWarning.hidden = true;
    if (src.progressKey !== null) { const slug = src.progressKey; ctx.store.update((s) => ({ ...s, cookProgress: { slug, step } })); }
    renderStep();
    if (forward && ++forwardMoves % 3 === 0) say('cook.step_quip');
  };

  const finish = async () => {
    if (finished) return;
    finished = true;
    hf?.voice.stop('left');
    clearInterval(interval);
    if (src.progressKey !== null) ctx.store.update((s) => ({ ...s, cookProgress: null }));
    // In the background (M7): the certificate shows at once, and the grants' lines follow when they're known.
    void src.record();
    await wake.disable();
    say(src.done.trigger, src.done.vars);
    await showBureauForm(doc.getElementById('overlay-root') ?? doc.body, {
      form: src.certificate.form,
      values: src.certificate.values,
      stamps: content.bureau.stamps,
      reducedMotion: isReducedMotion(ctx.store, win),
      signal: leaving.signal,
    });
    if (leaving.signal.aborted) return; // left during the certificate: the new screen stays
    src.after();
  };

  /**
   * I4: Done (a tap, or the arrow key) on the last step. With timers still running it first names them, and the next
   * Done finishes, which stops them: never silently.
   */
  let warnedFor: string | null = null;
  const requestFinish = () => {
    const running = timers.filter((t) => !t.done);
    const key = running.map((t) => t.id).join(',');
    if (running.length > 0 && (finishWarning.hidden || warnedFor !== key)) {
      warnedFor = key;
      finishWarning.textContent = `Still running: ${running.map((t) => `${formatDuration(t.durationMs / 1000)} for step ${t.step}`).join('; ')}. Tap Done again to finish, which stops ${running.length === 1 ? 'it' : 'them'}, or keep cooking.`;
      finishWarning.hidden = false;
      return;
    }
    void finish();
  };
  next.addEventListener('click', () => { if (step === total - 1) requestFinish(); else go(step + 1); });
  prev.addEventListener('click', () => go(step - 1));
  leave.addEventListener('click', () => src.leave());
  const onKey = (ev: KeyboardEvent) => {
    if (finished || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    ev.preventDefault();
    if (ev.key === 'ArrowLeft') go(step - 1);
    else if (step === total - 1) requestFinish();
    else go(step + 1);
  };
  doc.addEventListener('keydown', onKey);

  // The dish is checked again whenever its inputs change: the player's rules (another tab) or the local date
  // (a rule's phase can start at midnight). Either way a dish that is no longer cookable is refused at once.
  const recheck = () => {
    if (finished || stopped) return;
    const r = src.recheck();
    if ('refused' in r) {
      teardown();
      el.replaceChildren(r.refused);
      r.refused.querySelector<HTMLElement>('h1')?.focus();
      announce(announcer, r.text);
      return;
    }
    if (r.strip) {
      const fresh = src.strip();
      strip.replaceWith(fresh);
      strip = fresh;
    }
    if (r.swaps) redrawStep();
    if (r.announce !== null) announce(announcer, r.announce);
  };
  src.onStripStale?.(() => {
    if (finished || stopped) return;
    const fresh = src.strip();
    strip.replaceWith(fresh);
    strip = fresh;
  });
  let key = src.inputsKey(ctx.store.get());
  const unsubscribe = ctx.store.subscribe((s) => {
    const k = src.inputsKey(s);
    if (k === key) return;
    key = k;
    recheck();
  });
  const stopDate = watchLocalDate(doc, ctx.now, recheck);

  // Hands-free (M7 Step 10). The voice client and cook-voice.ts load only when it is turned on (B8).
  const hfBuild = import.meta.env.VITE_HANDS_FREE === 'on';
  let hf: { voice: CookVoice; ctl: VoiceController } | null = null;
  let hfLoading = false;
  /** Bumped when a start in progress is called off (the toggle again, leaving): its late load does nothing. */
  let hfGen = 0;
  /** Rulings 7–9: which rule forbids the microphone now, or null; 'setting' when only the hands-free setting is off. */
  const hfBlock = (): 'family_table' | 'child' | 'signed_out' | 'off' | 'setting' | null => {
    const s = ctx.store.get();
    if (s.settings.familyTable) return 'family_table';
    if (s.account === null) return 'signed_out';
    if (!s.settings.voice.on) return 'off';
    if (mentor.cookVoice()?.childOn() !== false) return 'child';
    return s.settings.voice.handsFree ? null : 'setting';
  };
  const hfAllowed = () => hfBuild && !stopped && !finished && hfBlock() === null;
  const showPill = (open: boolean) => {
    if (open && listening.firstChild === null) listening.append(h('span', { class: 'listening-pill' }, LISTENING_TEXT));
    else if (!open) listening.replaceChildren();
  };
  const drawHf = () => {
    const live = hf !== null || hfLoading;
    hfBtn.hidden = hfHint.hidden = !live && !hfAllowed();
    hfBtn.setAttribute('aria-pressed', String(live));
    hfHint.textContent = live ? HANDS_FREE_ON_HINT : HANDS_FREE_OFF_HINT;
  };
  const voiceHooks: CookVoiceHooks = {
    // I4: never finishes; finishing is a tap (cook-voice answers a last-step "next" with voice.cook.last_step).
    next: () => { if (!finished && step < total - 1) go(step + 1); },
    back: () => { if (!finished) go(step - 1); },
    // The step's first timer that isn't running (as its button would).
    timerStart: () => {
      for (const item of recipe.steps[step].items) {
        if (item.type !== 'timer') continue;
        const id = `${step + 1}-${item.index}`;
        if (timers.some((t) => t.id === id && !t.done)) continue;
        const t = recipe.timers[item.index];
        startTimerNow(id, t.name ?? `step ${step + 1}`, step + 1, timerSeconds(t));
        return true;
      }
      return false;
    },
    // I3: only the one timer sounding or just finished; a running timer is never stopped by voice.
    timerStop: () => {
      const now = ctx.now().getTime();
      const candidates = timers.filter((t) => sounding(t, now));
      if (candidates.length !== 1) return 'which';
      stopTimer(candidates[0].id);
      return 'stopped';
    },
    currentStep: () => step,
    stepCount: () => total,
    speakStep: src.speakStep,
  };
  /** I5: the docked panel layout (CSS) while hands-free is on: the step and the safety strip stay in view. */
  const dock = (on: boolean) => {
    if (on) doc.documentElement.dataset.handsFree = 'on';
    else delete doc.documentElement.dataset.handsFree;
  };
  const showAnswered = () => {
    const open = h('button', { type: 'button', class: 'btn btn-secondary pan-answered-open' }, ANSWERED_OPEN);
    open.addEventListener('click', () => { answered.replaceChildren(); mentor.open(); });
    answered.replaceChildren(ANSWERED_TEXT, open);
  };
  const onAnswered = (_r: PanReply, needsTap: boolean) => {
    showAnswered();
    // Only a card or a heard card to tap opens the panel by itself, and never with focus (the arrows keep working).
    if (needsTap && !mentor.isOpen()) mentor.open({ focus: false });
  };
  const startHf = async () => {
    if (hf !== null || hfLoading || !hfAllowed()) return;
    hfLoading = true;
    const gen = ++hfGen;
    const calledOff = () => gen !== hfGen || !hfAllowed();
    drawHf();
    let ctl: VoiceController | null = null;
    let release: (() => void) | null = null;
    try {
      const [lib, cv] = await Promise.all([import('../voice'), import('./cook-voice')]);
      if (calledOff()) return; // turned off, left, or a rule changed while it loaded
      const port = mentor.cookVoice()!;
      const provider = lib.providerKind() === 'browser' ? await lib.devBrowserProvider(win) : lib.serviceProvider(win, ctx.store);
      if (calledOff()) { provider.close(); return; }
      // I1: cook mode owns voice from here: the panel's talk control closes its controller (and microphone) first.
      release = claimVoice('cook');
      const c = lib.createVoiceController({ win, store: ctx.store, provider, conversationId: () => port.conversationId(), childOn: () => port.childOn() });
      ctl = c;
      const unMic = c.onMic(showPill);
      // §19: the moment a child speaks, the microphone closes (the controller also checks every frame).
      const unChild = port.onChild(() => { if (port.childOn()) c.close('child'); });
      if (alarm.sounding) c.timerSounding(true);
      const released = release;
      const voice = cv.startCookVoice({
        controller: c, hooks: voiceHooks, localDate: () => localDate(ctx.now()), doc,
        // I5: the panel is not opened for a reply: it is spoken, and `answered` shows that it came.
        toPan: (text, id) => port.spoken(text, id),
        say: (t, v) => mentor.say(t, v),
        show: (r) => { mentor.show(r); },
        answered: onAnswered,
        readAloud: () => ctx.store.get().settings.voice.readAloud,
        onStop: () => {
          unMic();
          unChild();
          alarm.setHook(null);
          c.close();
          released();
          dock(false);
          showPill(false);
          if (hf?.ctl === c) hf = null;
          void wake.hold(false).then(showWake);
          drawHf();
        },
      });
      if (!voice.on) return;
      hf = { voice, ctl: c };
      dock(true);
      alarm.setHook((on) => { voice.timerSounding(on); });
      void wake.hold(true).then(showWake);
    } catch (err) {
      console.error(err);
      // M4: nothing is left open: the controller made, and the claim on voice.
      ctl?.close();
      release?.();
      dock(false);
      showPill(false);
      say('voice.unavailable');
    } finally {
      if (gen === hfGen) hfLoading = false;
      drawHf();
    }
  };
  hfBtn.addEventListener('click', () => {
    if (hf !== null) hf.voice.stop('user');
    else if (hfLoading) { hfGen++; hfLoading = false; drawHf(); }
    else void startHf();
  });
  const unHf = ctx.store.subscribe(() => {
    if (!hfBuild) return;
    const block = hfBlock();
    if (hf !== null && block !== null) {
      // A rule that forbids the microphone closes it without a word (Rulings 8 and 9); the setting is the player's off.
      if (block === 'setting') hf.voice.stop('user');
      else hf.ctl.close(block);
    }
    drawHf();
  });
  drawHf();

  function teardown() {
    stopped = true;
    hfGen++;
    hfLoading = false;
    hf?.voice.stop('left');
    unHf();
    leaving.abort();
    clearInterval(interval);
    doc.removeEventListener('visibilitychange', tickNow);
    doc.removeEventListener('keydown', onKey);
    unsubscribe();
    stopDate();
    void wake.disable();
  }

  renderStep();
  renderTray();
  say(src.start.trigger, src.start.vars);
  return teardown;
}
