import { timerSeconds, type ParsedRecipe, type RecipeIngredient, type StepItem } from '@kitchenquest/core/engine';
import { content } from '../content';
import { getMentor } from '../mentor';
import type { AppContext } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { announce } from '../ui/announce';
import { showBureauForm } from '../ui/bureau-form';
import type { BureauForm } from '../content/types';
import { contentText, h } from '../ui/dom';
import { watchLocalDate } from '../recipes/rules';
import type { PlayerState } from '../state/store';
import { formatClock, formatDuration, remainingMs, startTimer, tick, type RunningTimer } from './timers';
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
  /** Checked again on a change: the refusal to show, or what changed (a redrawn strip, swaps, an announcement). */
  recheck(): { refused: HTMLElement; text: string } | { strip: boolean; swaps: boolean; announce: string | null };
}

function amount(i: RecipeIngredient): string {
  if (i.quantity === null) return '';
  const q = String(Math.round(i.quantity * 100) / 100);
  return i.unit ? `${q} ${i.unit}` : q;
}

function beep(win: Window): void {
  try {
    const Ctx = (win as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const osc = ac.createOscillator();
    osc.frequency.value = 880;
    osc.connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.3);
    osc.onended = () => { void ac.close(); };
  } catch { /* sound is a nicety */ }
}

const WAKE_NOTE = "This browser can't keep the screen awake. Tap the screen now and then.";

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
  const showWake = (s: WakeState) => {
    wakeBtn.setAttribute('aria-pressed', String(s === 'on'));
    wakeNote.hidden = !(s === 'unsupported' || s === 'denied');
  };
  const wake = createWakeLock(win.navigator, doc, showWake);
  void wake.enable().then(showWake);
  wakeBtn.addEventListener('click', () => {
    if (wake.state === 'on') void wake.disable().then(() => showWake(wake.state));
    else void wake.enable().then(showWake);
  });

  // Layout
  const stepBox = h('div', { class: 'cook-step', 'aria-live': 'polite' });
  const trayList = h('ul', { class: 'timer-list' });
  const tray = h('div', { class: 'timer-tray', role: 'group', 'aria-labelledby': 'timer-tray-title', hidden: true },
    h('h2', { id: 'timer-tray-title' }, 'Running timers'), trayList);
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
      h('div', { class: 'cook-head-row' }, progress, wakeBtn),
      wakeNote),
    stepBox, tray,
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
  const renderTray = () => {
    const now = ctx.now().getTime();
    tray.hidden = timers.length === 0;
    const items = timers.map((t) => {
      let li = trayList.querySelector<HTMLElement>(`[data-timer="${t.id}"]`);
      if (!li) li = h('li', { 'data-timer': t.id, class: 'timer-item' });
      li.dataset.done = String(t.done);
      const text = `Step ${t.step} · ${t.done ? 'done' : formatClock(remainingMs(t, now))}`;
      if (li.textContent !== text) li.textContent = text;
      return li;
    });
    trayList.replaceChildren(...items);
    const running = timers.filter((t) => !t.done).length;
    leave.textContent = running === 0 ? 'Leave cook mode' : `Leave cook mode (stops ${running} ${running === 1 ? 'timer' : 'timers'})`;
  };
  const startTimerNow = (id: string, label: string, stepNo: number, seconds: number) => {
    if (timers.some((t) => t.id === id && !t.done)) return;
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
      say('cook.timer_done', { step: `step ${t.step}` });
      beep(win);
      try { win.navigator.vibrate?.(200); } catch { /* not supported */ }
    }
    renderTray();
  };
  const interval = setInterval(tickNow, 250);
  doc.addEventListener('visibilitychange', tickNow);

  // Moving between steps
  const go = (to: number) => {
    if (to < 0 || to >= total || to === step) return;
    const forward = to > step;
    step = to;
    if (src.progressKey !== null) { const slug = src.progressKey; ctx.store.update((s) => ({ ...s, cookProgress: { slug, step } })); }
    renderStep();
    if (forward && ++forwardMoves % 3 === 0) say('cook.step_quip');
  };

  const finish = async () => {
    if (finished) return;
    finished = true;
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

  next.addEventListener('click', () => { if (step === total - 1) void finish(); else go(step + 1); });
  prev.addEventListener('click', () => go(step - 1));
  leave.addEventListener('click', () => src.leave());
  const onKey = (ev: KeyboardEvent) => {
    if (finished || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    ev.preventDefault();
    if (ev.key === 'ArrowLeft') go(step - 1);
    else if (step === total - 1) void finish();
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

  function teardown() {
    stopped = true;
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
