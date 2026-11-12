import {
  dishName, fillLine, formatAmounts, keeperLines, listWords, marketList, questionStatus, STALL_IDS, stockSwaps,
  type ListItem, type MarketCtx, type MarketRunView, type PantryItem, type Plan, type StallId,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { StockAction } from '../api/types';
import { content, graph } from '../content';
import type { MarketContent } from '../content/types';
import { loadMarket } from '../market/content';
import { marketCtxFor, profileFor, seasonFor, type MarketProfile } from '../market/stall-context';
import { progressService } from '../progress';
import { newEventId } from '../progress/log';
import { localDate } from '../recipes/rules';
import type { Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { canonRecipes, planContextFor, rulesOf } from './context';
import { rememberRun, rememberWeek, takeStockAsk } from './memory';
import { seasonNoteEl, seasonNoteFor, type SeasonView } from './season-note';
import { stockControl } from './stock-view';
import { writtenLine } from './plan-view';
import { askHealthConsent, footnote, rulesLink, showFailure, statusLine } from './screen-kit';
import { moveOffer } from './move';
import { createWeekSource, type WeekSource } from './source';

/**
 * Form 12-M, the market list (`#/market`, M5 Step 10, Ruling 16): the plan's ingredients minus the pantry, one
 * section per stall headed by its name (`stallNames`, C11). Each row is a checkbox with the dishes it is for; a swap
 * is labelled "swapped" and a row the rules engine can't verify carries ❓ (never shown as ok). Ticking puts the item
 * in the pantry, dated today; unticking takes that same row out. "That's the shop done" finishes the run and records
 * `market_run` (its XP and stamp come once an ISO week, Ruling 23). No timer and no count of what's left. In Family
 * Table mode the list is computed on the device and shown, and nothing is written (C31): no box, no finish.
 *
 * M6 Step 10: each row shows its amounts (core `formatAmounts`, Ruling 12: a fuzzy amount as written, none → nothing,
 * never "0"), The Season's Table note once the market content resolves (core `seasonNote`, ✅ items only, never on ❓;
 * the list never waits on it), and an "Out of stock?" control (stock-view.ts) whose swaps are core `stockSwaps` only.
 * Family Table shows the amounts and the notes, and no stock control.
 */

const DONE_LABEL = "That's the shop done";
const NO_PLAN = 'Nothing is planned for this week yet, so the list is empty.';

const titleOf = (slug: string): string => dishName(slug, canonRecipes());

/**
 * "for Parippu Curry" / "for Frijoles de Olla, swapped": the dishes a row is for, a swap labelled. A stall swap's row
 * (M6 Ruling 11) says "stall swap for Parippu Curry".
 */
export function forText(row: ListItem): string {
  if (row.stockSwap !== undefined) return `stall swap for ${row.forDishes.map(titleOf).join('; ')}`;
  const swapped = new Set(row.swappedFor ?? []);
  return `for ${row.forDishes.map((slug) => (swapped.has(slug) ? `${titleOf(slug)}, swapped` : titleOf(slug))).join('; ')}`;
}

/** A row's amounts as one line ("450 g", "2 tbsp + 1 cup", "a handful"), or null when it has none (never "0"). */
export function amountText(row: ListItem): string | null {
  const text = formatAmounts(row.amounts ?? []);
  return text === '' ? null : text;
}

/**
 * A stall keeper's written line for a stock trigger, filled, and shown only when it names nothing ⛔ or ❓ for the
 * player now (core `keeperLines`, then the filled text through `questionStatus`, the check a question gets). The
 * General Counter has no keeper: null.
 */
export function stockKeeperLine(market: MarketContent | null, stall: StallId, trigger: 'out_of_stock' | 'out_of_stock_none', vars: Record<string, string>, ctx: MarketCtx | null): string | null {
  if (market === null || ctx === null || stall === 'general') return null;
  for (const l of keeperLines(market.stalls[stall], trigger, ctx)) {
    const filled = fillLine(l, vars);
    if (filled !== null && questionStatus({ id: '', game: '', prompt: filled, options: [], explain: '' }, ctx) === 'ok') return filled;
  }
  return null;
}

/** The list's sections in stall order (STALL_IDS), each with its rows; empty stalls are left out. */
export function byStall(items: readonly ListItem[]): { stall: StallId; name: string; rows: ListItem[] }[] {
  return STALL_IDS.map((stall) => ({ stall, name: content.stallNames[stall], rows: items.filter((i) => i.stall === stall) })).filter((s) => s.rows.length > 0);
}

export function marketScreen(api: ApiClient, source?: WeekSource): Screen {
  let alive = true;
  return {
    title: SCREEN_TITLES.market,
    async mount(el, _route, ctx) {
      const today = localDate(ctx.now());
      // N4: the account the screen's reads and writes are for, taken before any await.
      const who = ctx.store.get().account?.email ?? null;
      const remember = (weekStart: string, p: Plan | null) => { if ((ctx.store.get().account?.email ?? null) === who) rememberWeek(weekStart, p, who); };
      const week = source ?? createWeekSource({ store: ctx.store, client: api, today: () => localDate(ctx.now()) });
      const familyTable = ctx.store.get().settings.familyTable;
      const form = content.bureau.forms.market_list;
      const status = statusLine();
      const body = h('div', { class: 'market-body' });
      el.replaceChildren(
        h('h1', { tabindex: -1 }, SCREEN_TITLES.market),
        h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`),
        status.el, body,
        h('p', null, h('a', { href: routeHref({ name: 'plan' }) }, "This week's plan"), ' · ',
          // M6 Step 9: the stalls' practice rounds, any day. A plain link: the list never waits on them.
          h('a', { href: routeHref({ name: 'stalls' }) }, 'Visit the stalls')),
        // The list shows amounts but no prices (Ruling 5), so a footnote about prices is never shown.
        ...(form.footnotes ?? []).filter((f) => !/price/i.test(f)).map(footnote));

      const got = await week.current(today);
      if (!alive) return;
      if (!got.ok) { showFailure(got, status, writtenLine); if (got.kind === 'rules') body.append(rulesLink()); return; }
      const plan: Plan | null = got.value.plan;
      // Ruling 2: a week planned on this device before signing in moves to the account only on a tap.
      const offer = moveOffer({
        store: ctx.store, client: api, weekStart: got.value.weekStart, today,
        onMoved: () => { ctx.navigate({ name: 'market' }); },
        onConsent: (retry) => { askHealthConsent(retry); },
      });
      if (offer) status.el.after(offer);
      remember(got.value.weekStart, plan);
      if (plan === null || !plan.items.some((i) => i.kind === 'dish')) { body.append(h('p', null, NO_PLAN)); return; }

      let run: MarketRunView | null = null;
      let preview: ListItem[] | null = null;
      if (familyTable) {
        // Read only: the list as core computes it now from the plan, the pantry and the rules. No run is opened.
        const rules = rulesOf(ctx.store.get());
        let pantry: PantryItem[] = ctx.store.get().localPantry;
        if (ctx.store.get().account !== null) { const p = await api.getPantry(); pantry = p.ok ? p.data.items : []; }
        if (!alive) return;
        if (rules === null) { body.append(rulesLink()); return; }
        preview = marketList(plan, planContextFor(plan.weekStart, rules), pantry, content.stallOf);
      } else {
        const opened = await week.openRun(plan.weekStart, today);
        if (!alive) return;
        if (!opened.ok) { showFailure(opened, status, writtenLine); if (opened.kind === 'rules') body.append(rulesLink()); return; }
        run = opened.value;
      }

      // The market content (season table, keeper lines) and the profile arrive later; the list never waits on them.
      let market: MarketContent | null = null;
      let profile: MarketProfile | null = null;
      const openStock = new Set<string>();
      let focusStock: string | null = null;
      const ctxNow = (): MarketCtx | null => marketCtxFor(rulesOf(ctx.store.get()), profile ?? { country: null, region: null }, today, graph, [...content.substitutions]);
      const seasonNow = (): SeasonView | null => {
        if (market === null || profile === null) return null;
        try { return { regionId: seasonFor(profile, market.seasonality, today).regionId, table: market.seasonality }; } catch { return null; }
      };
      if (run !== null) rememberRun(run, who);

      let busy = false;
      const draw = () => {
        const items = run?.items ?? preview ?? [];
        const done = run !== null && run.doneAt !== null;
        const focused = (document.activeElement as HTMLElement | null)?.dataset.key ?? null;
        const sections = byStall(items).map(({ stall, name, rows }) => {
          const headingId = `stall-${stall}`;
          return h('section', { class: 'market-stall', 'aria-labelledby': headingId, 'data-stall': stall },
            contentText('h2', name, { id: headingId }),
            h('ul', { class: 'market-rows' }, ...rows.map((row) => rowEl(row, done))));
        });
        const children: HTMLElement[] = sections.length > 0 ? sections : [h('p', null, 'Everything on the plan is already in your pantry.')];
        if (run !== null && !done) {
          const finish = h('button', { type: 'button', class: 'btn btn-primary market-done' }, DONE_LABEL);
          finish.addEventListener('click', () => { void finishRun(); });
          children.push(h('div', { class: 'button-row' }, finish));
        }
        body.replaceChildren(...children);
        if (focusStock !== null) {
          const box = body.querySelector<HTMLElement>(`.stock-control[data-stock-key="${CSS.escape(focusStock)}"]`);
          (box?.querySelector<HTMLElement>('button') ?? body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusStock)}"]`))?.focus();
          focusStock = null;
        } else if (focused !== null) body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
      };

      const rowEl = (row: ListItem, done: boolean): HTMLElement => {
        const id = `market-${row.key.replace(/[^a-z0-9_-]/gi, '_')}`;
        const amount = amountText(row);
        const words = (): (Node | string)[] => [
          contentText('span', row.name, { class: 'market-item' }),
          ...(amount === null ? [] : [' ', contentText('span', amount, { class: 'market-amount' })]),
          ' ', h('span', { class: 'market-for' }, forText(row)),
          ...(row.outOfStock === true ? [' ', h('span', { class: 'market-out' }, '(out of stock)')] : []),
        ];
        const badge = row.unverified ? statusChip('unverified') : row.swappedFor ? statusChip('swap') : null;
        // The Season's Table (Ruling 10): plain text under the row, ✅ items only, once the market content is here.
        const c = ctxNow();
        const season = seasonNow();
        const note = season === null || c === null ? null : seasonNoteFor(row, season, c);
        const extra: HTMLElement[] = note === null ? [] : [seasonNoteEl(note)];
        if (run === null) {
          // Family Table: the row, its amounts, chips and season note, with no box to tick and no stock control.
          return h('li', { class: 'market-row', 'data-key': row.key }, ...words(), badge ? ' ' : null, badge, ...extra);
        }
        const box = h('input', { type: 'checkbox', id, class: 'market-tick', 'data-key': row.key, checked: row.ticked });
        box.checked = row.ticked;
        // An out-of-stock row is never ticked (its Undo puts it back), and a stall swap's row is undone, never unticked.
        box.disabled = done || row.outOfStock === true || row.stockSwap !== undefined;
        box.addEventListener('change', () => { void tick(row, box.checked); });
        if (!done) {
          const current = run;
          const control = stockControl(row, {
            swaps: c === null || plan === null ? [] : stockSwaps(row, plan, planContextFor(plan.weekStart, c.rules)),
            act: (a) => stock(row, a),
            familyTable,
            swapRow: current.items.find((i) => i.stockSwap?.from === row.key) ?? null,
            keeperLine: (trigger, vars) => stockKeeperLine(market, row.stall, trigger, vars, c),
            dishName: titleOf,
            open: openStock.has(row.key),
            onOpen: (open) => { if (open) openStock.add(row.key); else openStock.delete(row.key); },
          });
          if (control !== null) extra.push(control);
        }
        return h('li', { class: 'market-row', 'data-key': row.key }, box, h('label', { for: id }, ...words()), badge ? ' ' : null, badge, ...extra);
      };

      /** An out-of-stock mark, a stall swap or its undo (Ruling 11), on the device or through the API. */
      const stock = async (row: ListItem, a: StockAction): Promise<{ ok: boolean }> => {
        if (busy || run === null) return { ok: false };
        busy = true;
        let ok = false;
        try {
          const r = await week.stock(run, a, today);
          if (!alive) return { ok: false };
          if (!r.ok) showFailure(r, status, writtenLine);
          else {
            ok = true;
            run = r.value;
            rememberRun(run, who);
            openStock.delete(row.key);
            const swap = run.items.find((i) => i.stockSwap?.from === row.key);
            status.show(a.action === 'take' && swap !== undefined
              ? writtenLine('market.stock_swapped', { item: row.name, swap: swap.name, dish: listWords(row.forDishes.map(titleOf)) })
              : '');
          }
        } finally { busy = false; }
        focusStock = row.key;
        draw();
        return { ok };
      };

      const tick = async (row: ListItem, ticked: boolean) => {
        if (busy || run === null) { draw(); return; }
        busy = true;
        try {
          const r = await week.tick(run, row.key, ticked, today);
          if (!alive) return;
          if (!r.ok) { showFailure(r, status, writtenLine); }
          else {
            run = r.value;
            rememberRun(run, who);
            status.show(ticked ? writtenLine('market.ticked_pantry', { items: row.name }) : '');
          }
        } finally { busy = false; }
        draw();
      };

      const finishRun = async () => {
        if (busy || run === null) return;
        busy = true;
        try {
          const r = await week.finish(run, today, ctx.now());
          if (!alive) return;
          if (!r.ok) { showFailure(r, status, writtenLine); return; }
          run = r.value.run;
          rememberRun(run, who);
          status.show(writtenLine('market.run_done', {}));
          // Once per run: its XP and stamp come once an ISO week, whatever is sent (Ruling 23).
          if (r.value.finished) {
            void progressService()
              .then((svc) => svc.record([{ id: newEventId(), kind: 'market_run', at: today, weekStart: run!.weekStart }]))
              .catch((err: unknown) => { console.error(err); });
          }
        } finally { busy = false; }
        draw();
        body.closest('.screen-body')?.querySelector<HTMLElement>('h1')?.focus();
      };
      draw();
      // The check-off card's "Out of stock?" (C31): open that row's control and bring it into view, once.
      const asked = takeStockAsk();
      if (asked !== null && run !== null && run.items.some((i) => i.key === asked)) {
        openStock.add(asked);
        focusStock = asked;
        draw();
        body.querySelector<HTMLElement>(`.stock-control[data-stock-key="${CSS.escape(asked)}"]`)?.scrollIntoView?.({ block: 'center' });
      }
      // Season notes and keeper lines follow once the market content and the profile have loaded (never blocking).
      void Promise.all([loadMarket(), profileFor(ctx.store.get(), api)]).then(([m, p]) => {
        if (!alive || (ctx.store.get().account?.email ?? null) !== who) return;
        market = m;
        profile = p;
        draw();
      }, (err: unknown) => { console.error(err); });
    },
    unmount() { alive = false; },
  };
}
