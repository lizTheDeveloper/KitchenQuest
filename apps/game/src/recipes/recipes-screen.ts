import { SCREEN_TITLES } from '../shell/titles';
import { content, graph } from '../content';
import { type AppContext, type Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { buildRecipeCard } from './card-model';
import { NO_RULES_TEXT } from './card-view';
import { activeRules, cardInputsKey, localDate, watchLocalDate } from './rules';

const SHELF_ERROR_TEXT = "Couldn't check these dishes against your rules. Treat them as unchecked.";

/** Canon recipes, by country then title. */
function shelfSlugs(): string[] {
  return Object.keys(content.recipes).sort((a, b) => {
    const ma = content.recipes[a].meta, mb = content.recipes[b].meta;
    return ma.country.localeCompare(mb.country) || ma.title.localeCompare(mb.title);
  });
}

function draw(el: HTMLElement, ctx: AppContext): void {
  const state = ctx.store.get();
  const rules = activeRules(state, graph);
  const today = localDate(ctx.now());
  const items = shelfSlugs().map((slug) => {
    const card = buildRecipeCard({ slug, content, graph, rules, today, showCalories: state.settings.showCalories });
    return h('li', { class: 'shelf-item', 'data-slug': slug, 'data-status': card.status },
      h('a', { href: routeHref({ name: 'recipe', slug }) },
        contentText('span', card.title, { class: 'shelf-title' }), ' ',
        contentText('span', `${card.region}, ${card.country}`, { class: 'shelf-place' }), ' ',
        statusChip(card.status)));
  });
  const note = rules.status === 'error'
    ? h('p', { class: 'rules-error', role: 'note' }, h('strong', null, SHELF_ERROR_TEXT))
    : rules.rules.length === 0 ? h('p', { class: 'rules-checked' }, NO_RULES_TEXT) : null;
  el.replaceChildren(h('h1', null, 'Recipe shelf'), ...(note ? [note] : []), h('ul', { class: 'shelf' }, ...items));
}

export function recipesScreen(): Screen {
  let unsubscribe: (() => void) | null = null;
  let stopDate: (() => void) | null = null;
  return {
    title: SCREEN_TITLES.recipes,
    mount(el, _route, ctx) {
      let key = cardInputsKey(ctx.store.get());
      draw(el, ctx);
      stopDate = watchLocalDate(el.ownerDocument, ctx.now, () => draw(el, ctx));
      unsubscribe = ctx.store.subscribe((s) => {
        const next = cardInputsKey(s);
        if (next !== key) { key = next; draw(el, ctx); }
      });
    },
    unmount() { unsubscribe?.(); unsubscribe = null; stopDate?.(); stopDate = null; },
  };
}

