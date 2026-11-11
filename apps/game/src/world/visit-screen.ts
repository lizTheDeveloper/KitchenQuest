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

/** The kitchen backdrops are 320 wide; shown at 2x (integer), shrinking with the page. */
const KITCHEN_WIDTH = 640;

export function visitScreen(): Screen {
  let cleanup: (() => void) | null = null;
  return {
    title: 'Visit',
    mount(el, route, ctx) {
      if (route.name !== 'visit' || !Object.hasOwn(content.cooks, route.cookId)) throw new RouteNotFound();
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

      const showBar = () => {
        if (stopBar) return;
        stopBar = renderActionBar(bar, [
          { id: 'recipe', label: `See the recipe: ${cook.dish}`, run: () => openCard(doc.querySelector<HTMLElement>('[data-action="recipe"]')) },
          { id: 'intro', label: 'Hear the intro again', run: () => playIntro() },
          { id: 'map', label: 'Back to the map', run: () => ctx.navigate({ name: 'map' }) },
        ]);
      };

      // The cook's intro, in order. The action bar follows the first time it ends.
      function playIntro() {
        if (dialogueSlot || closeCard) return;
        const slot = h('div', { class: 'visit-dialogue' });
        dialogueSlot = slot;
        overlayRoot.append(slot);
        const first = !stopBar;
        const seeRecipe = bar.querySelector<HTMLButtonElement>('[data-action="recipe"]');
        if (seeRecipe) seeRecipe.disabled = true;
        void showDialogue(slot, {
          speaker: cook.name, portrait: assets[`char.${id}`] ?? null, lines: cook.intro, reducedMotion: isReducedMotion(ctx.store, win),
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
          bar.querySelector<HTMLElement>('[data-action="recipe"]')?.focus();
        });
      }
      playIntro();
    },
    unmount() { cleanup?.(); cleanup = null; },
  };
}

