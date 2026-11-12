import { SCREEN_TITLES } from '../shell/titles';
import { applyNotes, type ParsedRecipe, type RecipeIngredient } from '@kitchenquest/core/engine';
import { content, graph, techniqueName } from '../content';
import { buildRecipeCard, type RecipeCard } from '../recipes/card-model';
import { renderSafetyStrip } from '../recipes/card-view';
import { activeRules, cardInputsKey, localDate } from '../recipes/rules';
import { RouteNotFound, type Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { statusLabel } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { progressService } from '../progress';
import { catalogueOf, questsOf } from '../progress/catalogue';
import { newEventId } from '../progress/log';
import { cookStepEvents } from '../quests/quest-runner';
import { plannedOn } from '../week/memory';
import { stockSwapsNow } from '../week/market-swaps';
import { runCookMode } from './cook-mode';
import { afterCookThenKitchen, cookedEvent } from './finish';
import { takeNotes } from './with-notes';

const NOT_COOKABLE_TEXT = "This dish isn't cookable with your rules.";
const SACRED_TEXT = 'Shared as a story only.';

const refusalText = (card: RecipeCard): string => (card.notCookableReason === 'sacred' ? SACRED_TEXT : NOT_COOKABLE_TEXT);

function refusal(card: RecipeCard): HTMLElement {
  return h('section', { class: 'cook-refusal' },
    contentText('h1', card.title, { tabindex: -1 }),
    h('p', { class: 'not-cookable' }, refusalText(card)),
    h('p', null, h('a', { href: routeHref({ name: 'recipe', slug: card.slug }) }, 'Back to the recipe card')));
}

/** The strip with this week's stall-swap labels under it (M6 Ruling 11): "swapped at the market: Y for X". */
export function withStockLabels(strip: HTMLElement, card: RecipeCard): HTMLElement {
  if (card.stockSwapLabels.length > 0) strip.append(h('ul', { class: 'stock-labels' }, ...card.stockSwapLabels.map((t) => contentText('li', t, { class: 'stock-label' }))));
  return strip;
}

/**
 * Cook mode (M3) for a canon recipe (`#/cook/<slug>`) or, from M5 Step 10, a Pantry Frame (`#/frame/<id>`: the slot
 * picker in frame-cook.ts, then the same step runner).
 */
export function cookScreen(): Screen {
  let cleanup: (() => void) | null = null;
  let gone = false;
  return {
    title: SCREEN_TITLES.cook,
    async mount(el, route, ctx) {
      if (route.name === 'frame') {
        const frame = content.frames.find((f) => f.id === route.id);
        if (frame === undefined) throw new RouteNotFound();
        const { frameCook } = await import('./frame-cook');
        if (gone) return;
        cleanup = frameCook(el, frame, { ctx });
        return;
      }
      if (route.name !== 'cook' || !Object.hasOwn(content.recipes, route.slug)) throw new RouteNotFound();
      const { slug } = route;
      // "Cook with my notes" (Step 11): the notes the book handed over, applied to a copy; the canon is never changed.
      const notes = takeNotes(slug, ctx.store.get().account?.email ?? null);
      const recipe: ParsedRecipe = notes === null ? content.recipes[slug] : applyNotes(content.recipes[slug], notes);
      const cook = content.cooks[recipe.meta.cook];

      const buildCard = () => {
        const state = ctx.store.get();
        const today = localDate(ctx.now());
        // M6 Step 10 (Ruling 11): this week's stall swaps for the dish, checked with the rules as they are now.
        const stockSwaps = stockSwapsNow(state, slug, today);
        return buildRecipeCard({
          slug, content, graph, rules: activeRules(state, graph), today, showCalories: state.settings.showCalories,
          ...(notes === null ? {} : { notes }), ...(stockSwaps.length > 0 ? { stockSwaps } : {}),
        });
      };
      // The same card model as the recipe card, and the only safety check (§2.1). Runs on every mount, so a
      // deep link or a resume after reload is refused just like the button.
      let card = buildCard();
      el.ownerDocument.title = `${card.title} · Kitchen Quest`;
      if (!card.cookable) { el.replaceChildren(refusal(card)); return; }

      /** What the steps show from the findings: the swap labels per ingredient. */
      const swapsKey = (c: RecipeCard) => JSON.stringify(c.findings.filter((f) => f.swapLabel !== null).map((f) => [f.ingredient, f.swapLabel]));
      const form = content.bureau.forms.certificate;

      /**
       * The progress log (Ruling 7): a `cooked` event, then any quest cook step it completes. Their grants become the
       * Pan's lines (progress/announce.ts). `planned`: the dish is on the week's plan for today (Step 10). A sacred dish
       * never gets here: cook mode refuses it (M3), and core grants nothing for one anyway (spec §10).
       */
      const recordCook = async () => {
        try {
          const svc = await progressService();
          const today = localDate(ctx.now());
          const rulesCtx = svc.rulesContext(today);
          await svc.record([cookedEvent(slug, today, plannedOn(slug, today, ctx.store.get().account?.email ?? null), newEventId(), catalogueOf(), rulesCtx)]);
          if (rulesCtx === undefined) return;
          const steps = cookStepEvents(questsOf(), svc.view(), today, { ...rulesCtx, today, cat: catalogueOf() });
          if (steps.length > 0) await svc.record(steps);
        } catch (err) {
          console.error(err); // progress is a nicety here: the cook itself is done, and the certificate still shows
        }
      };

      cleanup = runCookMode(el, ctx, {
        title: notes === null ? card.title : `${card.title}, with your notes`,
        recipe,
        draft: card.draft,
        strip: () => withStockLabels(renderSafetyStrip(card), card),
        swapFor: (ing: RecipeIngredient) => card.findings.find((f) => f.ingredient === ing.name && f.swapLabel !== null)?.swapLabel ?? null,
        progressKey: slug,
        start: { trigger: 'cook.start', vars: { dish: cook.dish || card.title } },
        done: { trigger: 'cook.done', vars: { dish: cook.dish || card.title, cook: cook.name } },
        certificate: {
          form: { ...form, fields: form.fields.map((f) => (f.hint ? { ...f, hint: f.hint.replace('{place}', cook.place) } : f)) },
          values: { dish: card.title, taught_by: cook.name, rewards: `Techniques tried: ${card.skills.map((s) => techniqueName(s.id)).join(', ')}` },
        },
        record: recordCook,
        leave: () => ctx.navigate({ name: 'recipe', slug }),
        // Step 11: the three after-cook questions, each skippable, then the kitchen (Family Table: straight there).
        after: () => { void afterCookThenKitchen(el, ctx, { slug, frame: null, recipe, at: localDate(ctx.now()) }); },
        inputsKey: cardInputsKey,
        recheck: () => {
          const before = card;
          card = buildCard();
          if (!card.cookable) return { refused: refusal(card), text: refusalText(card) };
          // Still cookable, but the status or findings may have changed: redraw the strip, and the step only when
          // the swaps it shows changed.
          return {
            strip: before.status !== card.status || before.severe !== card.severe || before.rulesError !== card.rulesError
              || JSON.stringify(before.findings) !== JSON.stringify(card.findings) || JSON.stringify(before.stockSwapLabels) !== JSON.stringify(card.stockSwapLabels),
            swaps: swapsKey(before) !== swapsKey(card),
            announce: before.status !== card.status ? `Safety check now: ${statusLabel(card.status)}.` : null,
          };
        },
      });
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}
