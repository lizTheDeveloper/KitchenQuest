import { recordTechnique, timerSeconds, type ParsedRecipe, type RecipeIngredient, type StepItem } from '@kitchenquest/core/engine';
import { content, graph, techniqueName } from '../content';
import { getMentor } from '../mentor';
import { buildRecipeCard, type RecipeCard } from '../recipes/card-model';
import { renderSafetyStrip } from '../recipes/card-view';
import { activeRules, cardInputsKey, localDate, watchLocalDate } from '../recipes/rules';
import { registerScreen, RouteNotFound, type Screen } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { routeHref } from '../shell/router';
import { announce } from '../ui/announce';
import { showBureauForm } from '../ui/bureau-form';
import { contentText, h } from '../ui/dom';
import { cookedEvents } from './finish';
import { formatClock, formatDuration, remainingMs, startTimer, tick, type RunningTimer } from './timers';
import { createWakeLock, type WakeState } from './wake-lock';

const NOT_COOKABLE_TEXT = "This dish isn't cookable with your rules.";
const SACRED_TEXT = 'Shared as a story only.';
const WAKE_NOTE = "This browser can't keep the screen awake. Tap the screen now and then.";

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

const refusalText = (card: RecipeCard): string => (card.notCookableReason === 'sacred' ? SACRED_TEXT : NOT_COOKABLE_TEXT);

function refusal(card: RecipeCard): HTMLElement {
  return h('section', { class: 'cook-refusal' },
    contentText('h1', card.title, { tabindex: -1 }),
    h('p', { class: 'not-cookable' }, refusalText(card)),
    h('p', null, h('a', { href: routeHref({ name: 'recipe', slug: card.slug }) }, 'Back to the recipe card')));
}

function cookScreen(): Screen {
  let cleanup: (() => void) | null = null;
  return {
    title: 'Cook',
    mount(el, route, ctx) {
      if (route.name !== 'cook' || !Object.hasOwn(content.recipes, route.slug)) throw new RouteNotFound();
      const { slug } = route;
      const recipe: ParsedRecipe = content.recipes[slug];
      const cook = content.cooks[recipe.meta.cook];
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const total = recipe.steps.length;

      const buildCard = () => {
        const state = ctx.store.get();
        return buildRecipeCard({
          slug, content, graph, rules: activeRules(state, graph), today: localDate(ctx.now()), showCalories: state.settings.showCalories,
        });
      };
      // The same card model as the recipe card, and the only safety check (§2.1). Runs on every mount, so a
      // deep link or a resume after reload is refused just like the button.
      let card = buildCard();
      doc.title = `${card.title} · Kitchen Quest`;
      if (!card.cookable) { el.replaceChildren(refusal(card)); return; }

      const mentor = getMentor();
      const say = (id: string, vars: Record<string, string> = {}) => { mentor.say(id, vars); };
      const announcer = doc.getElementById('announcer');

      const saved = ctx.store.get().cookProgress;
      let step = saved && saved.slug === slug && Number.isInteger(saved.step) && saved.step >= 0 && saved.step < total ? saved.step : 0;
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
      const progress = h('p', { class: 'cook-progress' });
      // The dish's safety status stays in view while cooking (❓ and the allergy disclaimer included).
      let strip = renderSafetyStrip(card);
      el.replaceChildren(
        h('header', { class: 'cook-head' },
          contentText('h1', card.title),
          card.draft ? h('span', { class: 'draft-badge' }, 'Draft recipe') : null,
          strip,
          h('div', { class: 'cook-head-row' }, progress, wakeBtn),
          wakeNote),
        stepBox, tray,
        h('div', { class: 'cook-controls button-row' }, prev, next),
        h('div', { class: 'button-row' }, leave));

      const swapFor = (ing: RecipeIngredient): string | null =>
        card.findings.find((f) => f.ingredient === ing.name && f.swapLabel !== null)?.swapLabel ?? null;

      const itemNode = (item: StepItem, stepNo: number): Node => {
        switch (item.type) {
          case 'text': return doc.createTextNode(item.value);
          case 'cookware': return h('span', { class: 'cookware', 'data-content': '' }, item.name);
          case 'ingredient': {
            const ing = recipe.ingredients[item.index];
            const amt = amount(ing), swap = swapFor(ing);
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
              type: 'button', class: 'btn btn-secondary timer-start',
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
        ctx.store.update((s) => ({ ...s, cookProgress: { slug, step } }));
        renderStep();
        if (forward && ++forwardMoves % 3 === 0) say('cook.step_quip');
      };

      const finish = async () => {
        if (finished) return;
        finished = true;
        clearInterval(interval);
        const events = cookedEvents(slug, recipe, localDate(ctx.now()));
        ctx.store.update((s) => ({ ...s, toolkit: events.reduce(recordTechnique, s.toolkit), cookProgress: null }));
        await wake.disable();
        say('cook.done', { dish: cook.dish || card.title, cook: cook.name });
        const form = content.bureau.forms.certificate;
        const names = card.skills.map((s) => techniqueName(s.id)).join(', ');
        await showBureauForm(doc.getElementById('overlay-root') ?? doc.body, {
          form: { ...form, fields: form.fields.map((f) => (f.hint ? { ...f, hint: f.hint.replace('{place}', cook.place) } : f)) },
          values: { dish: card.title, taught_by: cook.name, rewards: `Techniques tried: ${names}` },
          stamps: content.bureau.stamps,
          reducedMotion: isReducedMotion(ctx.store, win),
          signal: leaving.signal,
        });
        if (leaving.signal.aborted) return; // left during the certificate: the new screen stays
        ctx.navigate({ name: 'kitchen' });
      };

      next.addEventListener('click', () => { if (step === total - 1) void finish(); else go(step + 1); });
      prev.addEventListener('click', () => go(step - 1));
      leave.addEventListener('click', () => ctx.navigate({ name: 'recipe', slug }));
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
        const before = card;
        card = buildCard();
        if (!card.cookable) {
          teardown();
          const view = refusal(card);
          el.replaceChildren(view);
          view.querySelector<HTMLElement>('h1')!.focus();
          announce(announcer, refusalText(card));
          return;
        }
        // Still cookable, but the status or findings (swaps shown in the steps) may have changed: redraw both.
        if (before.status !== card.status || before.severe !== card.severe || before.rulesError !== card.rulesError
          || JSON.stringify(before.findings) !== JSON.stringify(card.findings)) {
          const fresh = renderSafetyStrip(card);
          strip.replaceWith(fresh);
          strip = fresh;
          renderStep();
        }
      };
      let key = cardInputsKey(ctx.store.get());
      const unsubscribe = ctx.store.subscribe((s) => {
        const k = cardInputsKey(s);
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
      cleanup = teardown;

      renderStep();
      renderTray();
      say('cook.start', { dish: cook.dish || card.title });
    },
    unmount() { cleanup?.(); cleanup = null; },
  };
}

export function registerCookScreen(): void { registerScreen('cook', cookScreen); }
