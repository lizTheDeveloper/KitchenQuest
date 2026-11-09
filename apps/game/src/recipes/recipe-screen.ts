import { content, graph } from '../content';
import { registerScreen, RouteNotFound, type AppContext, type Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { h } from '../ui/dom';
import { buildRecipeCard } from './card-model';
import { renderRecipeCard } from './card-view';
import { activeRules, cardInputsKey, localDate, watchLocalDate } from './rules';

function draw(el: HTMLElement, slug: string, ctx: AppContext): void {
  const state = ctx.store.get();
  const card = buildRecipeCard({
    slug, content, graph, rules: activeRules(state, graph), today: localDate(ctx.now()), showCalories: state.settings.showCalories,
  });
  el.ownerDocument.title = `${card.title} · Kitchen Quest`;
  el.replaceChildren(
    renderRecipeCard(card, { headingLevel: 1, onCook: () => ctx.navigate({ name: 'cook', slug }) }),
    h('p', null, h('a', { href: routeHref({ name: 'recipes' }) }, 'Back to the recipe shelf')),
  );
}

function recipeScreen(): Screen {
  let unsubscribe: (() => void) | null = null;
  let stopDate: (() => void) | null = null;
  return {
    title: 'Recipe',
    mount(el, route, ctx) {
      if (route.name !== 'recipe' || !Object.hasOwn(content.recipes, route.slug)) throw new RouteNotFound();
      const { slug } = route;
      let key = cardInputsKey(ctx.store.get());
      draw(el, slug, ctx);
      // `today` is read at draw time, so redraw when the local date rolls over.
      stopDate = watchLocalDate(el.ownerDocument, ctx.now, () => draw(el, slug, ctx));
      unsubscribe = ctx.store.subscribe((s) => {
        const next = cardInputsKey(s);
        if (next !== key) { key = next; draw(el, slug, ctx); }
      });
    },
    unmount() { unsubscribe?.(); unsubscribe = null; stopDate?.(); stopDate = null; },
  };
}

export function registerRecipeScreen(): void { registerScreen('recipe', recipeScreen); }
