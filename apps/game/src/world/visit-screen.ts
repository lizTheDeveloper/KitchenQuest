import { SCREEN_TITLES } from '../shell/titles';
import assets from 'virtual:kq-assets';
import { content, graph } from '../content';
import { buildRecipeCard } from '../recipes/card-model';
import { renderRecipeCard } from '../recipes/card-view';
import { activeRules, cardInputsKey, localDate, watchLocalDate } from '../recipes/rules';
import { kitchenBackdropKey } from '../scenes/phaser-host';
import { RouteNotFound, type Screen } from '../shell/app';
import { isReducedMotion } from '../shell/motion';
import { renderActionBar } from '../ui/action-bar';
import { showDialogue } from '../ui/dialogue-box';
import { contentText, h } from '../ui/dom';
import { openModal } from '../ui/modal';
import { mountBackdrop } from './backdrop';
import { currentStep, dishStatus, questStatus, type PantryItem } from '@kitchenquest/core/engine';
import { getMentor, getMentorServices } from '../mentor';
import { progressService } from '../progress';
import { stepContextOf } from '../progress/catalogue';
import type { ProgressService } from '../progress/service';
import { runQuest } from '../quests/quest-runner';
import { trustLine } from './trust-lines';


/** The kitchen backdrops are 320 wide; shown at 2x (integer), shrinking with the page. */
const KITCHEN_WIDTH = 640;

export function visitScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let gone = false; // unmounted while progress was still loading: mount nothing
  return {
    title: SCREEN_TITLES.visit,
    async mount(el, route, ctx) {
      if (route.name !== 'visit' || !Object.hasOwn(content.cooks, route.cookId)) throw new RouteNotFound();
      // Progress decides intro vs return line and runs the quest. If it can't load, the visit is M3's: intro, then the card.
      let svc: ProgressService | null = null;
      try { svc = await progressService(); } catch (err) { console.error(err); }
      if (gone) return;
      const id = route.cookId;
      const cook = content.cooks[id];
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const overlayRoot = doc.getElementById('overlay-root') ?? doc.body;
      doc.title = `${cook.name}'s kitchen · Kitchen Quest`;
      let alive = true;
      const leaving = new AbortController(); // settles an intro still on screen when the player leaves
      let dialogueSlot: HTMLElement | null = null;
      let closeCard: (() => void) | null = null;
      let stopBar: (() => void) | null = null;

      const backdropSlot = h('div', { class: 'visit-backdrop' });
      const bar = h('div', { class: 'visit-actions' });
      el.replaceChildren(
        h('h1', null, contentText('span', cook.name), "'s kitchen"),
        contentText('p', cook.place, { class: 'visit-place' }),
        // voice.md §0.3: recipes are taught, never unlocked or got.
        h('p', { class: 'visit-teach' }, contentText('span', cook.name), ' will teach you ', contentText('span', cook.dish), '.'),
        backdropSlot,
        bar,
      );

      const backdrop = kitchenBackdropKey(assets, id);
      const stopBackdrop = mountBackdrop(backdropSlot, {
        className: 'visit-backdrop', src: assets[backdrop], width: KITCHEN_WIDTH, scene: 'CookKitchen',
        data: { backdrop, cook: `char.${id}` },
      });
      // Set before anything else can throw: #stage now lives in this screen and must go home on unmount.
      cleanup = () => {
        alive = false;
        leaving.abort();
        stopBar?.();
        closeCard?.();
        dialogueSlot?.remove();
        stopBackdrop();
      };

      const openCard = (opener: HTMLElement | null) => {
        if (closeCard || dialogueSlot) return; // never over the cook's intro
        const drawCard = () => {
          const state = ctx.store.get();
          const card = buildRecipeCard({
            slug: cook.recipe, content, graph, rules: activeRules(state, graph), today: localDate(ctx.now()), showCalories: state.settings.showCalories,
          });
          return renderRecipeCard(card, {
            headingLevel: 2,
            onCook: () => { closeCard?.(); ctx.navigate({ name: 'cook', slug: cook.recipe }); },
          });
        };
        const view = drawCard();
        const body = h('div', { class: 'visit-card-body' }, view);
        const title = view.querySelector('h2')!;
        // While open, the card follows its inputs (rules from another tab, sign-in, the local date), like the
        // recipe screen: a stale ✅ or an enabled Cook button must never outlive the rule that changed it.
        const redraw = () => {
          const hadFocus = body.contains(doc.activeElement);
          const fresh = drawCard();
          const freshTitle = fresh.querySelector('h2')!;
          freshTitle.id = title.id;
          freshTitle.tabIndex = -1;
          body.replaceChildren(fresh);
          if (hadFocus) freshTitle.focus();
        };
        let key = cardInputsKey(ctx.store.get());
        const unsubscribe = ctx.store.subscribe((s) => {
          const k = cardInputsKey(s);
          if (k !== key) { key = k; redraw(); }
        });
        const stopDate = watchLocalDate(doc, ctx.now, redraw);
        closeCard = openModal(doc, {
          className: 'visit-card', title, body, opener,
          onClose: () => { closeCard = null; unsubscribe(); stopDate(); },
        });
      };

      /** The cook's quest runs unless it is done, waiting on another (C4), or Family Table mode keeps nothing (§19). */
      const questRuns = () => {
        if (!svc || ctx.store.get().settings.familyTable) return false;
        const st = questStatus(cook.quest, svc.view());
        return st === 'open' || st === 'in_progress';
      };
      const showBar = () => {
        stopBar?.();
        stopBar = renderActionBar(bar, [
          { id: 'recipe', label: `See the recipe: ${cook.dish}`, run: () => openCard(doc.querySelector<HTMLElement>('[data-action="recipe"]')) },
          ...(questRuns() ? [{ id: 'quest', label: 'Carry on with the quest', run: () => { void playQuest(); } }] : []),
          { id: 'intro', label: 'Hear the intro again', run: () => playIntro() },
          { id: 'map', label: 'Back to the map', run: () => ctx.navigate({ name: 'map' }) },
        ]);
      };

      // Signed in, the pantry is the account's (read once per visit); signed out, the device's.
      let accountPantry: PantryItem[] = [];
      const pantry = (): PantryItem[] => (ctx.store.get().account === null ? ctx.store.get().localPantry : accountPantry);
      const loadPantry = async () => {
        if (ctx.store.get().account === null) return;
        try {
          const r = await getMentorServices().client.getPantry();
          if (r.ok) accountPantry = r.data.items;
        } catch { /* the errand falls back to "I've got it" */ }
      };
      const rulesNow = () => { const r = activeRules(ctx.store.get(), graph); return r.status === 'ready' ? r.rules : null; };

      /** intro → quest runner → card → cook (Step 9). Paused at a cook step the player can cook, the card opens. */
      async function playQuest() {
        if (!svc || dialogueSlot || closeCard || !questRuns()) return;
        const service = svc;
        const slot = h('div', { class: 'visit-dialogue visit-quest' });
        dialogueSlot = slot;
        overlayRoot.append(slot);
        bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = true; });
        await loadPantry();
        const result = await runQuest(slot, cook.quest, {
          progress: () => service.view(),
          record: (e) => service.record(e),
          pantry, rules: rulesNow, graph, subs: [...content.substitutions], today: () => localDate(ctx.now()), signal: leaving.signal,
          cook: { name: cook.name, portrait: assets[`char.${id}`] ?? null },
          pan: { portrait: assets['char.pan'] ?? null, line: (trigger, vars) => getMentor().say(trigger, vars).text },
          reducedMotion: isReducedMotion(ctx.store, win),
        });
        slot.remove();
        dialogueSlot = null;
        if (!alive) return;
        showBar();
        const view = service.view();
        const at = currentStep(cook.quest, view);
        const rules = rulesNow();
        if (result === 'paused' && at?.step.type === 'cook' && rules !== null &&
          dishStatus(at.step.recipe, stepContextOf(rules, pantry(), localDate(ctx.now()))) !== 'blocked') {
          openCard(bar.querySelector<HTMLElement>('[data-action="recipe"]'));
          return;
        }
        bar.querySelector<HTMLElement>(result === 'paused' && questRuns() ? '[data-action="quest"]' : '[data-action="recipe"]')?.focus();
      }

      // The cook's intro, in order (or, on a return visit, one trust line). The action bar follows the first time it ends.
      function playIntro(lines: string[] = cook.intro, thenQuest = false) {
        if (dialogueSlot || closeCard) return;
        const slot = h('div', { class: 'visit-dialogue' });
        dialogueSlot = slot;
        overlayRoot.append(slot);
        const first = !stopBar;
        const seeRecipe = bar.querySelector<HTMLButtonElement>('[data-action="recipe"]');
        if (seeRecipe) seeRecipe.disabled = true;
        void showDialogue(slot, {
          speaker: cook.name, portrait: assets[`char.${id}`] ?? null, lines, reducedMotion: isReducedMotion(ctx.store, win),
          signal: leaving.signal,
        }).then(() => {
          slot.remove();
          dialogueSlot = null;
          if (seeRecipe) seeRecipe.disabled = false;
          if (!alive) return;
          if (!first) {
            // A replay ends on the button that started it, even from a canvas hotspot (focus was on the body).
            bar.querySelector<HTMLElement>('[data-action="intro"]')?.focus();
            return;
          }
          showBar();
          if (thenQuest && questRuns()) { void playQuest(); return; }
          bar.querySelector<HTMLElement>('[data-action="recipe"]')?.focus();
        });
      }
      // A later visit (trust 1 or more) opens with a trust line, then the card; level 0 never shows one.
      const returning = svc ? trustLine(cook.trust_lines, svc.view().trust[id] ?? 0) : null;
      if (returning !== null) playIntro([returning]);
      else if (svc && questStatus(cook.quest, svc.view()) === 'in_progress' && questRuns()) { showBar(); void playQuest(); }
      else playIntro(cook.intro, true);
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}

