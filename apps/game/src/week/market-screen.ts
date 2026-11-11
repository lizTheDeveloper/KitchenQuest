import { dishName, marketList, STALL_IDS, type ListItem, type MarketRunView, type PantryItem, type Plan, type StallId } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content } from '../content';
import { progressService } from '../progress';
import { newEventId } from '../progress/log';
import { localDate } from '../recipes/rules';
import type { Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { canonRecipes, planContextFor, rememberWeek, rulesOf } from './context';
import { writtenLine } from './plan-view';
import { footnote, rulesLink, showFailure, statusLine } from './screen-kit';
import { createWeekSource, type WeekSource } from './source';

/**
 * Form 12-M, the market list (`#/market`, M5 Step 10, Ruling 16): the plan's ingredients minus the pantry, one
 * section per stall headed by its name (`stallNames`, C11). Each row is a checkbox with the dishes it is for; a swap
 * is labelled "swapped" and a row the rules engine can't verify carries ❓ (never shown as ok). Ticking puts the item
 * in the pantry, dated today; unticking takes that same row out. "That's the shop done" finishes the run and records
 * `market_run` (its XP and stamp come once an ISO week, Ruling 23). No timer and no count of what's left. In Family
 * Table mode the list is computed on the device and shown, and nothing is written (C31): no box, no finish.
 */

const DONE_LABEL = "That's the shop done";
const NO_PLAN = 'Nothing is planned for this week yet, so the list is empty.';

const titleOf = (slug: string): string => dishName(slug, canonRecipes());

/** "for Parippu Curry" / "for Frijoles de Olla, swapped": the dishes a row is for, a swap labelled. */
export function forText(row: ListItem): string {
  const swapped = new Set(row.swappedFor ?? []);
  return `for ${row.forDishes.map((slug) => (swapped.has(slug) ? `${titleOf(slug)}, swapped` : titleOf(slug))).join('; ')}`;
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
      const week = source ?? createWeekSource({ store: ctx.store, client: api });
      const familyTable = ctx.store.get().settings.familyTable;
      const form = content.bureau.forms.market_list;
      const status = statusLine();
      const body = h('div', { class: 'market-body' });
      el.replaceChildren(
        h('h1', { tabindex: -1 }, SCREEN_TITLES.market),
        h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`),
        status.el, body,
        h('p', null, h('a', { href: routeHref({ name: 'plan' }) }, "This week's plan")),
        // The list carries names only (M6 adds amounts), so the footnote about prices and amounts isn't shown.
        ...(form.footnotes ?? []).filter((f) => !/price/i.test(f)).map(footnote));

      const got = await week.current(today);
      if (!alive) return;
      if (!got.ok) { showFailure(got, status, writtenLine); if (got.kind === 'rules') body.append(rulesLink()); return; }
      const plan: Plan | null = got.value.plan;
      rememberWeek(plan);
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

      let busy = false;
      const draw = () => {
        const items = run?.items ?? preview ?? [];
        const done = run?.doneAt != null;
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
        if (focused !== null) body.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)?.focus();
      };

      const rowEl = (row: ListItem, done: boolean): HTMLElement => {
        const id = `market-${row.key.replace(/[^a-z0-9_-]/gi, '_')}`;
        const label = h('label', { for: id }, contentText('span', row.name, { class: 'market-item' }), ' ', h('span', { class: 'market-for' }, forText(row)));
        const badge = row.unverified ? statusChip('unverified') : row.swappedFor ? statusChip('swap') : null;
        if (run === null) {
          // Family Table: the row and its chips, with no box to tick.
          return h('li', { class: 'market-row', 'data-key': row.key }, contentText('span', row.name, { class: 'market-item' }), ' ', h('span', { class: 'market-for' }, forText(row)), badge ? ' ' : null, badge);
        }
        const box = h('input', { type: 'checkbox', id, class: 'market-tick', 'data-key': row.key, checked: row.ticked });
        box.checked = row.ticked;
        box.disabled = done;
        box.addEventListener('change', () => { void tick(row, box.checked); });
        return h('li', { class: 'market-row', 'data-key': row.key }, box, label, badge ? ' ' : null, badge);
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
    },
    unmount() { alive = false; },
  };
}
