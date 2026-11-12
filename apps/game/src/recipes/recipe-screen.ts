import type { ToolkitState } from '@kitchenquest/core/engine';
import { SCREEN_TITLES } from '../shell/titles';
import { content, graph, techniqueName } from '../content';
import { progressService } from '../progress';
import { writtenLine } from '../week/plan-view';
import { currentToolkit } from '../week/memory';
import { drillFirstEl, drillFirstFor } from './drill-first';
import { RouteNotFound, type AppContext, type Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { h } from '../ui/dom';
import { buildRecipeCard } from './card-model';
import { renderRecipeCard } from './card-view';
import { activeRules, cardInputsKey, localDate, watchLocalDate } from './rules';

/**
 * M6 Ruling 16: the drill-first hint for a dish, or null: none in Family Table, for a sacred dish, while the toolkit is
 * still loading, or when every prereq the cooks' drills teach is at Seen. Advisory only.
 */
export function drillFirstHint(slug: string, toolkit: ToolkitState | null, familyTable: boolean): HTMLElement | null {
  const recipe = content.recipes[slug];
  if (familyTable || toolkit === null || recipe === undefined) return null;
  const hint = drillFirstFor(recipe, toolkit, content.techniques.techniques, Object.values(content.cooks).map((c) => c.quest));
  if (hint === null || !Object.hasOwn(content.cooks, hint.cook)) return null;
  const cook = content.cooks[hint.cook].name;
  return drillFirstEl(writtenLine('cook.drill_first', { technique: techniqueName(hint.technique), cook }), {
    // The `go` chip `{ to: 'visit', cook }`, in nav.offer's words for that place (core navPlace: "{cook}'s kitchen").
    label: writtenLine('nav.offer', { place: `${cook}'s kitchen` }),
    href: routeHref({ name: 'visit', cookId: hint.cook }),
  });
}

function draw(el: HTMLElement, slug: string, ctx: AppContext, toolkit: ToolkitState | null): void {
  const state = ctx.store.get();
  const card = buildRecipeCard({
    slug, content, graph, rules: activeRules(state, graph), today: localDate(ctx.now()), showCalories: state.settings.showCalories,
  });
  el.ownerDocument.title = `${card.title} · Kitchen Quest`;
  el.replaceChildren(
    renderRecipeCard(card, { headingLevel: 1, onCook: () => ctx.navigate({ name: 'cook', slug }), drillFirst: drillFirstHint(slug, toolkit, state.settings.familyTable) }),
    h('p', null, h('a', { href: routeHref({ name: 'recipes' }) }, 'Back to the recipe shelf')),
  );
}

export function recipeScreen(): Screen {
  let unsubscribe: (() => void) | null = null;
  let stopDate: (() => void) | null = null;
  return {
    title: SCREEN_TITLES.recipe,
    mount(el, route, ctx) {
      if (route.name !== 'recipe' || !Object.hasOwn(content.recipes, route.slug)) throw new RouteNotFound();
      const { slug } = route;
      const keyOf = (s: Parameters<typeof cardInputsKey>[0]) => `${cardInputsKey(s)}|${String(s.settings.familyTable)}`;
      let key = keyOf(ctx.store.get());
      let toolkit = currentToolkit();
      let live = true;
      const redraw = () => { if (live) draw(el, slug, ctx, toolkit); };
      redraw();
      // The toolkit comes with progress (the drill-first hint waits for it; the card never does).
      void progressService().then((svc) => { toolkit = svc.view().toolkit; redraw(); }, () => undefined);
      // `today` is read at draw time, so redraw when the local date rolls over.
      const stopWatch = watchLocalDate(el.ownerDocument, ctx.now, redraw);
      stopDate = () => { live = false; stopWatch(); };
      unsubscribe = ctx.store.subscribe((s) => {
        const next = keyOf(s);
        if (next !== key) { key = next; redraw(); }
      });
    },
    unmount() { unsubscribe?.(); unsubscribe = null; stopDate?.(); stopDate = null; },
  };
}

