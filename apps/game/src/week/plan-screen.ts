import {
  alternativesOn, blockedDishLine, checkPlan, planFlags, weeklySlot, type Plan, type PlanItem, type Rule, type SlotOffer, type ToolkitState,
} from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import { content, graph } from '../content';
import { progressService } from '../progress';
import { localDate } from '../recipes/rules';
import type { Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { contentText, h } from '../ui/dom';
import { addDays, canonRecipes, emptyPlan, planContextFor, rulesOf, slotInputFor } from './context';
import { rememberWeek } from './memory';
import { blockedLinesFor, blockedSlugs } from './blocked';
import { practiceDay, renderPlanView, slotDay, weekdayName, writtenLine, type PlanRow, type SlotOfferView } from './plan-view';
import { askHealthConsent, footnote, rulesLink, showFailure, statusLine } from './screen-kit';
import { moveOffer } from './move';
import { createWeekSource, type WeekSource } from './source';

/**
 * Form 7-W, the plan screen (`#/plan`, M5 Step 10): the week planned by hand, the path that always works (AI off or
 * capped, Ruling 27). Day rows with each dish's rules chip and findings (plan-view.ts), "Add a dish" per day (a ⛔
 * dish is refused with `plan.blocked_dish`, never added), Remove, the hard-week box, and at most one One More
 * Technique a week (never in a hard week; "Not this week" records the week). "Plan it ✔" saves: a tap is the yes.
 * In Family Table mode the plan, its checks and its lines are shown and nothing is written (C31): no control asks to.
 */

const servingsOf = (slug: string): number => {
  const s = canonRecipes().get(slug)?.meta.servings ?? 1;
  return Number.isFinite(s) ? Math.min(10, Math.max(0.5, s)) : 1;
};
const sameItem = (a: PlanItem, b: PlanItem) => a.day === b.day && a.kind === b.kind && a.slug === b.slug;

/** "Yes, add it": the dish on its day (when it isn't planned yet) and a practice lesson the day before (never a day gone, M9). */
export function acceptSlot(plan: Plan, offer: SlotOffer, day: number, today: string): Plan {
  const items = [...plan.items];
  const dish: PlanItem = { day, kind: 'dish', slug: offer.recipe, servings: servingsOf(offer.recipe) };
  if (!items.some((i) => sameItem(i, dish))) items.push(dish);
  const lesson: PlanItem = { day: practiceDay(plan, day, today), kind: 'lesson', slug: offer.recipe };
  if (!items.some((i) => sameItem(i, lesson))) items.push(lesson);
  return { ...plan, items, slot: 'accepted' };
}

/** The week's slot offer, or null: none in a hard week, once declined or accepted, or with the rules unreadable. */
export function offerFor(plan: Plan, rules: Rule[] | null, toolkit: ToolkitState | null, today: string): SlotOffer | null {
  if (rules === null || toolkit === null || plan.hard || plan.slot === 'declined' || plan.slot === 'accepted') return null;
  // 'offered': the week's one offer, shown again until it is answered (never a second, different one).
  return weeklySlot(slotInputFor({ ...plan, slot: 'unanswered' }, rules, toolkit, today, plan.items.map((i) => i.slug)));
}

export function planScreen(api: ApiClient, source?: WeekSource): Screen {
  let alive = true;
  return {
    title: SCREEN_TITLES.plan,
    async mount(el, _route, ctx) {
      const today = localDate(ctx.now());
      const week = source ?? createWeekSource({ store: ctx.store, client: api });
      const familyTable = ctx.store.get().settings.familyTable;
      const status = statusLine('plan-status');
      const body = h('div', { class: 'plan-body' });
      const form = content.bureau.forms.plan;
      el.replaceChildren(
        h('h1', { tabindex: -1 }, SCREEN_TITLES.plan),
        h('p', { class: 'bureau-number' }, `PANTRY BUREAU · FORM ${form.number}`),
        status.el, body,
        h('p', null, h('a', { href: routeHref({ name: 'market' }) }, 'The market list')),
        ...(form.footnotes ?? []).map(footnote));

      const got = await week.current(today);
      if (!alive) return;
      if (!got.ok) {
        showFailure(got, status, writtenLine);
        if (got.kind === 'rules') body.append(rulesLink());
        return;
      }
      const { weekStart } = got.value;
      // Ruling 2: a week planned on this device before signing in moves to the account only on a tap.
      const offer = moveOffer({
        store: ctx.store, client: api, weekStart: got.value.weekStart, today,
        onMoved: () => { ctx.navigate({ name: 'plan' }); },
        onConsent: (retry) => { askHealthConsent(retry); },
      });
      if (offer) status.el.after(offer);
      let saved: Plan | null = got.value.plan;
      let draft: Plan = saved ?? emptyPlan(weekStart);
      rememberWeek(weekStart, saved, ctx.store.get().account?.email ?? null);
      let toolkit: ToolkitState | null = null;
      void progressService().then((svc) => { toolkit = svc.view().toolkit; if (alive) draw(); }, () => undefined);

      const save = async (next: Plan, said: string | null): Promise<boolean> => {
        const r = await week.save(next, today);
        if (!alive) return false;
        if (!r.ok) {
          // Ruling 5: a dish ⛔ since it was planned is named, with what blocks it; "try again" would never work.
          const rules = rulesOf(ctx.store.get());
          const lines = r.kind === 'invalid' && blockedSlugs(r.problems).length > 0 && rules !== null ? blockedLinesFor(next, rules) : [];
          if (lines.length > 0) status.show(lines.map((l) => writtenLine(l.trigger, l.vars)).join(' '));
          else showFailure(r, status, writtenLine);
          return false;
        }
        saved = next;
        draft = next;
        rememberWeek(weekStart, next, ctx.store.get().account?.email ?? null);
        status.show(said ?? writtenLine('plan.saved', {}));
        draw();
        return true;
      };

      /** Where focus goes after the next redraw (M6): a control that went with it hands focus here. */
      let focusNext: string | null = null;
      const draw = () => {
        const rules = rulesOf(ctx.store.get());
        const pc = rules === null ? null : planContextFor(weekStart, rules);
        // Can't verify is never safe: with the rules unreadable every item is ❓, and nothing can be added or saved.
        const rows: PlanRow[] = pc === null
          ? draft.items.map((item) => ({ item, status: 'unverified', findings: [] }))
          : checkPlan(draft, pc).map((c) => ({ item: c.item, status: c.status, findings: c.findings }));
        const offer = offerFor(draft, rules, toolkit, today);
        const day = offer === null ? null : slotDay(draft, offer, today);
        const offerView: SlotOfferView | null = offer === null || day === null ? null : {
          offer, day: weekdayName(weekStart, day),
          ...(familyTable ? {} : {
            onAnswer: (yes: boolean) => {
              const next = yes ? acceptSlot(draft, offer, day, today) : { ...draft, slot: 'declined' as const };
              focusNext = 'plan-status';
              void save(next, yes ? writtenLine('one_more.accepted', { day: weekdayName(weekStart, practiceDay(draft, day, today)) }) : writtenLine('one_more.declined', {}));
            },
          }),
        };
        const view = renderPlanView({
          weekStart, rows, line: writtenLine, allDays: true, flag: pc === null ? null : planFlags(draft, pc), offer: offerView,
          alternatives: (item) => (rules === null ? [] : alternativesOn(item.slug, addDays(weekStart, item.day), { rules, graph: pc!.graph, subs: pc!.subs, recipes: canonRecipes() })),
          ...(familyTable ? {} : {
            onCook: (item: PlanItem) => ctx.navigate({ name: 'cook', slug: item.slug }),
            // M6: the pressed Remove goes with its row; focus goes to that day's heading, never to the page.
            onRemove: (item: PlanItem) => { draft = { ...draft, items: draft.items.filter((i) => !sameItem(i, item)) }; focusNext = `plan-day-${item.day}`; draw(); },
            dayExtra: (d: number) => (pc === null ? null : addControl(d)),
          }),
        });
        const children: HTMLElement[] = [view];
        if (rules === null) children.unshift(h('p', { class: 'rules-error', role: 'note' }, "Your rules couldn't be read just now, so every dish shows ❓."), rulesLink());
        const hardLabel = form.fields.find((f) => f.key === 'hard_week')?.label ?? 'A hard week';
        if (familyTable) {
          children.push(h('p', { class: 'plan-hard' }, contentText('span', hardLabel), `: ${draft.hard ? 'Yes' : 'No'}`));
        } else {
          const hard = h('input', { type: 'checkbox', id: 'plan-hard', checked: draft.hard });
          hard.checked = draft.hard;
          hard.addEventListener('change', () => { draft = { ...draft, hard: hard.checked }; if (hard.checked) status.show(writtenLine('plan.hard_week', {})); draw(); document.getElementById('plan-hard')?.focus(); });
          const planIt = contentText('button', form.buttons.confirm, { type: 'button', class: 'btn btn-primary plan-save' });
          planIt.disabled = rules === null;
          planIt.addEventListener('click', () => {
            // An unanswered offer the player has seen is marked offered: the week's one suggestion.
            const next = offerView !== null && draft.slot === 'unanswered' ? { ...draft, slot: 'offered' as const } : draft;
            void save(next, null);
          });
          children.push(h('div', { class: 'field' }, hard, contentText('label', hardLabel, { for: 'plan-hard' })), h('div', { class: 'button-row' }, planIt));
        }
        const focusedId = focusNext ?? document.activeElement?.id;
        focusNext = null;
        body.replaceChildren(...children);
        if (focusedId) document.getElementById(focusedId)?.focus();
      };

      /** "Add a dish" for one day: every non-sacred canon dish; a ⛔ one is refused with its line, never added. */
      const addControl = (d: number): HTMLElement => {
        const id = `plan-add-${d}`;
        const pick = h('select', { id, class: 'plan-add-select' },
          ...[...canonRecipes()].filter(([, r]) => !r.meta.sacred).map(([slug, r]) => h('option', { value: slug }, r.meta.title)));
        const add = h('button', { type: 'button', class: 'btn btn-secondary plan-add', id: `plan-add-btn-${d}` }, 'Add');
        add.addEventListener('click', () => {
          const rules = rulesOf(ctx.store.get());
          if (rules === null) return;
          const item: PlanItem = { day: d, kind: 'dish', slug: pick.value, servings: servingsOf(pick.value) };
          const [c] = checkPlan({ ...draft, items: [item] }, planContextFor(weekStart, rules));
          if (c.status === 'blocked') {
            status.show(writtenLine('plan.blocked_dish', blockedDishLine(item.slug, c.findings, canonRecipes(), graph).vars));
            return;
          }
          if (!draft.items.some((i) => sameItem(i, item))) draft = { ...draft, items: [...draft.items, item] };
          draw();
        });
        return h('div', { class: 'plan-add-row' }, h('label', { for: id }, `Add a dish on ${weekdayName(weekStart, d)}`), pick, add);
      };
      draw();
    },
    unmount() { alive = false; },
  };
}
