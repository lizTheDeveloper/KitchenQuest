// The market hub, `#/stalls` (M6 Step 9, Ruling 15, §3.4): the `bg_market` backdrop with the four keepers as canvas
// hotspots (MarketScene), over an HTML list of the stalls that carries everything without the canvas. Each stall is
// one button with its keeper's name and the games in its round today. Practice runs any day; nothing here touches the
// shopping list, and the list never waits on it.
import { seasonalQuestions, stallBank, STALL_IDS, type MarketCtx, type StallFile } from '@kitchenquest/core/engine';
import assets from 'virtual:kq-assets';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import type { MarketContent } from '../content/types';
import { activeRules, cardInputsKey, localDate } from '../recipes/rules';
import { onAction } from '../scenes/bridge';
import type { Screen } from '../shell/app';
import { parseRoute, routeHref, type KeeperStall } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { contentText, h } from '../ui/dom';
import { mountBackdrop } from '../world/backdrop';
import { loadMarket } from './content';
import { keeperName, marketCtxFor, profileFor, seasonFor, takeHubNote, type MarketProfile } from './stall-context';
import { gameLabel, stallForm } from './stall-screen';

/** scene.market is 320×180; shown at 2x (integer), shrinking with the page. */
const MARKET_WIDTH = 640;
const KEEPERS = STALL_IDS.filter((s): s is KeeperStall => s !== 'general');

/** The minigame names in a stall's bank today (Form 14-S's names, each rules-checked), in bank order, without repeats. */
export function gamesIn(questions: readonly { game: string }[], ctx: MarketCtx): string[] {
  const out: string[] = [];
  for (const q of questions) {
    const n = gameLabel(q.game, ctx);
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
      const status = h('p', { class: 'week-note', role: 'status', 'data-content': '' });
      const said = takeHubNote();
      if (said !== null) status.textContent = said;
      const backdropSlot = h('div', { class: 'market-backdrop' });
      const list = h('ul', { class: 'stalls-list', 'aria-label': 'The stalls' });
      el.replaceChildren(
        h('h1', null, SCREEN_TITLES.stalls),
        status,
        backdropSlot,
        list,
        h('p', { class: 'stall-links' }, h('a', { href: routeHref({ name: 'market' }) }, 'The market list'), ' · ', h('a', { href: routeHref({ name: 'kitchen' }) }, 'Back to the kitchen')),
        ...(stallForm()?.footnotes ?? []).filter((f) => !/example prices/i.test(f)).slice(0, 1).map((f) => contentText('p', f, { class: 'bureau-footnote' })),
      );
      const stopBackdrop = mountBackdrop(backdropSlot, { className: 'market-backdrop', src: assets['scene.market'], width: MARKET_WIDTH, scene: 'Market' });
      // Canvas → HTML: a keeper's hotspot is the same action as their button (bridge).
      const stopActions = onAction((action) => {
        if (!action.startsWith('stall:')) return;
        const r = parseRoute(`#/stall/${action.slice('stall:'.length)}`);
        if (r.name === 'stall') ctx.navigate(r);
      });
      let stopRules: (() => void) | null = null;
      cleanup = () => { stopActions(); stopBackdrop(); stopRules?.(); };

      const market = await load().catch((err: unknown) => { console.error(err); return null; });
      if (gone) return;
      let profile: MarketProfile = { country: null, region: null };
      let profileOf: string | null | undefined;
      let token = 0;

      /**
       * One button per stall: its keeper's name (the Protein Counter's own, M2) and the games in its bank, all as the
       * rules are now. Drawn once the stalls have loaded, so the butcher's name is never shown first to a player whose
       * rules make it the Protein Counter; without the stalls (offline), or while the rules can't be read, the names only.
       */
      const draw = async () => {
        const my = ++token;
        const account = store.get().account?.email ?? null;
        if (profileOf !== account) { profile = await profileFor(store.get(), deps.client); profileOf = account; }
        if (my !== token || gone) return;
        const today = localDate(ctx.now());
        const rules = activeRules(store.get(), graph);
        const mctx = market === null ? null : marketCtxFor(rules.status === 'ready' ? rules.rules : null, profile, today, graph, [...content.substitutions]);
        const season = market === null || mctx === null ? null : seasonFor(profile, market.seasonality, today);
        const focused = (el.ownerDocument.activeElement as HTMLElement | null)?.dataset.stall ?? null;
        list.replaceChildren(...KEEPERS.map((id) => {
          const stall = market?.stalls[id];
          const name = stall === undefined ? content.stallNames[id] : keeperName(stall, mctx);
          const sub = h('span', { class: 'stall-button-games' });
          if (stall !== undefined && mctx !== null && season !== null) {
            const file: StallFile = stall;
            const seasonal = file.seasonal === undefined ? [] : seasonalQuestions(file, season.regionId, season.month, market!.seasonality);
            const games = gamesIn(stallBank(file, mctx, seasonal).questions, mctx);
            // Form 14-S's names are content; the plain empty line is the screen's own.
            if (games.length > 0) { sub.setAttribute('data-content', ''); sub.textContent = games.join(' · '); } else sub.textContent = 'Nothing for you here today';
          }
          const b = h('button', { type: 'button', class: 'btn btn-secondary stall-button', 'data-stall': id }, contentText('span', name, { class: 'stall-button-name' }), sub);
          b.addEventListener('click', () => { ctx.navigate({ name: 'stall', id }); });
          return h('li', null, b);
        }));
        if (focused !== null) list.querySelector<HTMLElement>(`[data-stall="${CSS.escape(focused)}"]`)?.focus();
      };
      // I2: the hub re-filters live, as the stall does: a rules, account or date change redraws its names and games.
      const inputs = () => JSON.stringify([cardInputsKey(store.get()), localDate(ctx.now())]);
      let seen = inputs();
      stopRules = store.subscribe(() => {
        const next = inputs();
        if (next === seen) return;
        seen = next;
        void draw();
      });
      await draw();
    },
    unmount() { gone = true; cleanup?.(); cleanup = null; },
  };
}
