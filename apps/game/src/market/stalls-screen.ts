// The market hub, `#/stalls` (M6 Step 9, Ruling 15, §3.4): the `bg_market` backdrop with the four keepers as canvas
// hotspots (MarketScene), over an HTML list of the stalls that carries everything without the canvas. Each stall is
// one button with its keeper's name and the games in its round today. Practice runs any day; nothing here touches the
// shopping list, and the list never waits on it.
import { seasonalQuestions, stallBank, STALL_IDS, type StallFile } from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { MarketContent } from '../content/types';
import { activeRules, localDate } from '../recipes/rules';
import { onAction } from '../scenes/bridge';
import type { Screen } from '../shell/app';
import { parseRoute, routeHref, type KeeperStall } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { contentText, h } from '../ui/dom';
import { mountBackdrop } from '../world/backdrop';
import { loadMarket } from './content';
import { keeperName, marketCtxFor, profileFor, seasonFor, takeHubNote } from './stall-context';

/** scene.market is 320×180; shown at 2x (integer), shrinking with the page. */
const MARKET_WIDTH = 640;
const KEEPERS = STALL_IDS.filter((s): s is KeeperStall => s !== 'general');

/** The minigame names in a stall's round today (Form 14-S's names), in bank order, without repeats. */
export function gamesIn(questions: readonly { game: string }[]): string[] {
  const names = content.bureau.forms.stall_round?.game ?? {};
  const out: string[] = [];
  for (const q of questions) {
    const n = Object.hasOwn(names, q.game) ? names[q.game] : null;
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

export function stallsScreen(deps: { client: Pick<ApiClient, 'getProfile'>; load?: () => Promise<MarketContent> }): Screen {
  const load = deps.load ?? loadMarket;
  let cleanup: (() => void) | null = null;
  let gone = false;
  return {
    title: SCREEN_TITLES.stalls,
    async mount(el, _route, ctx) {
      const store = ctx.store;
      const today = localDate(ctx.now());
      const status = h('p', { class: 'week-note', role: 'status', 'data-content': '' });
      const said = takeHubNote();
      if (said !== null) status.textContent = said;
      const backdropSlot = h('div', { class: 'market-backdrop' });
      // One button per stall, named from first-paint content at once; the games join once the stalls have loaded.
      const games = new Map<KeeperStall, HTMLElement>();
      const names = new Map<KeeperStall, HTMLElement>();
      const buttons = KEEPERS.map((id) => {
        const name = contentText('span', content.stallNames[id], { class: 'stall-button-name' });
        const sub = h('span', { class: 'stall-button-games' });
        names.set(id, name);
        games.set(id, sub);
        const b = h('button', { type: 'button', class: 'btn btn-secondary stall-button', 'data-stall': id }, name, sub);
        b.addEventListener('click', () => { ctx.navigate({ name: 'stall', id }); });
        return h('li', null, b);
      });
      el.replaceChildren(
        h('h1', null, SCREEN_TITLES.stalls),
        status,
        backdropSlot,
        h('ul', { class: 'stalls-list', 'aria-label': 'The stalls' }, ...buttons),
        h('p', { class: 'stall-links' }, h('a', { href: routeHref({ name: 'market' }) }, 'The market list'), ' · ', h('a', { href: routeHref({ name: 'kitchen' }) }, 'Back to the kitchen')),
        ...(content.bureau.forms.stall_round?.footnotes ?? []).filter((f) => !/example prices/i.test(f)).slice(0, 1).map((f) => contentText('p', f, { class: 'bureau-footnote' })),
      );
      const stopBackdrop = mountBackdrop(backdropSlot, { className: 'market-backdrop', src: assets['scene.market'], width: MARKET_WIDTH, scene: 'Market' });
      // Canvas → HTML: a keeper's hotspot is the same action as their button (bridge).
      const stopActions = onAction((action) => {
        if (!action.startsWith('stall:')) return;
        const r = parseRoute(`#/stall/${action.slice('stall:'.length)}`);
        if (r.name === 'stall') ctx.navigate(r);
      });
      cleanup = () => { stopActions(); stopBackdrop(); };

      const [market, profile] = await Promise.all([load().catch((err: unknown) => { console.error(err); return null; }), profileFor(store.get(), deps.client)]);
      if (gone || market === null) return;
      const rules = activeRules(store.get(), graph);
      const mctx = marketCtxFor(rules.status === 'ready' ? rules.rules : null, profile, today, graph, [...content.substitutions]);
      if (mctx === null) return; // the stall itself says why it waits; the names stay
      const { regionId, month } = seasonFor(profile, market.seasonality, today);
      for (const id of KEEPERS) {
        const stall = market.stalls[id];
        const file = stall as StallFile;
        names.get(id)!.textContent = keeperName(stall, mctx);
        const seasonal = file.seasonal === undefined ? [] : seasonalQuestions(file, regionId, month, market.seasonality);
        const list = gamesIn(stallBank(file, mctx, seasonal).questions);
        games.get(id)!.textContent = list.length > 0 ? list.join(' · ') : 'Nothing for you here today';
      }
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}
