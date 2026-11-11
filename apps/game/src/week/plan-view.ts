import {
  blockedDishLine, dishName, fillLine, WEEKDAY_NAMES, type CheckStatus, type CookAlternative, type Finding, type Plan, type PlanFlag, type PlanItem, type SlotOffer,
} from '@kitchenquest/core/engine';
import { content, graph, techniqueName } from '../content';
import { routeHref } from '../shell/router';
import { statusChip } from '../ui/chips';
import { contentText, h } from '../ui/dom';
import { addDays, canonRecipes, dayOfWeek } from './context';

/**
 * Form 7-W's one renderer (M5 Step 10), shared by the Pan's plan card and the plan screen (`#/plan`). Every item
 * shows its dish, its rules-check chip (✅ / 🔁 / ❓ / ⛔, never ✅ for a ❓) and its findings. A ⛔ item (a rule added
 * since it was planned) says `plan.blocked_dish`, lists the adapted versions the engine has, and its Cook button is
 * disabled; a ❓ item says `plan.unverified_dish`. Below: the plan's one food-group line and, when there is one, the
 * week's One More Technique slot. No counts of meals planned and no line about an empty day.
 */
export interface PlanRow { item: PlanItem; status: CheckStatus; findings: readonly Finding[] }

export interface PlanViewOpts {
  weekStart: string;
  rows: readonly PlanRow[];
  /** A Pan line by trigger (written lines only: the screens' own dialogue, never the model's text). */
  line: (trigger: string, vars: Record<string, string>) => string;
  flag?: PlanFlag;
  /** All seven days (the screen, with an add control per day); else only the days that hold something (the card). */
  allDays?: boolean;
  /** Dishes that could stand in for a ⛔ one (core `alternativesOn`). */
  alternatives?: (item: PlanItem) => CookAlternative[];
  /** The screen's controls on each item: Cook (disabled for ⛔) and Remove. Absent on the card and in Family Table mode. */
  onCook?: (item: PlanItem) => void;
  onRemove?: (item: PlanItem) => void;
  /** A per-day control (the screen's "Add a dish"). */
  dayExtra?: (day: number) => HTMLElement | null;
  offer?: SlotOfferView | null;
}

export interface SlotOfferView {
  offer: SlotOffer;
  /** The weekday the offer's dish would go on. */
  day: string;
  /** Absent: the offer is shown without its buttons (the card; Family Table). */
  onAnswer?: (yes: boolean) => void;
}

/**
 * A written line for a screen: the trigger's first line that its variables fill, exactly as written (no rotation and
 * no line history, so a redraw never changes the words and nothing is written to the store).
 */
export function writtenLine(trigger: string, vars: Record<string, string>): string {
  const t = Object.hasOwn(content.pan.triggers, trigger) ? content.pan.triggers[trigger] : undefined;
  if (t === undefined) throw new Error(`no line "${trigger}" in pan.yaml`);
  for (const l of t.lines) {
    const filled = fillLine(l, vars);
    if (filled !== null) return filled;
  }
  throw new Error(`line "${trigger}" needs variables it was not given`);
}

/** The practice day for a dish on `day`: the day before, unless that is already gone (then the dish's own day, M9). */
export function practiceDay(plan: Pick<Plan, 'weekStart'>, day: number, today: string): number {
  const t = dayOfWeek(plan.weekStart, today);
  const earliest = t === null ? (today < plan.weekStart ? 0 : day) : t;
  return day - 1 >= Math.max(0, earliest) ? day - 1 : day;
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** "Sunday": the weekday of plan-week day `day`. */
export function weekdayName(weekStart: string, day: number): string {
  return cap(WEEKDAY_NAMES[new Date(`${addDays(weekStart, day)}T00:00:00Z`).getUTCDay()]);
}

/** A finding in words, from the rules engine's own fields. */
function findingText(f: Finding): string {
  if (f.kind === 'empty_slot') return `${f.ingredient}: nothing fits`;
  if (f.swap) return `swapped: ${f.swap.toName} for ${f.ingredient}`;
  const path = (f.path ?? []).filter((id) => graph.has(id)).map((id) => graph.get(id).name);
  if (f.status === 'blocked') return path.length > 1 ? `${f.ingredient} counts as ${path[path.length - 1]}` : `${f.ingredient} is on your rules`;
  if (f.kind === 'label') return `${f.ingredient}: check the label`;
  return `${f.ingredient}: can't verify`;
}

const titleOf = (slug: string): string => dishName(slug, canonRecipes());

function itemRow(row: PlanRow, o: PlanViewOpts): HTMLElement {
  const { item, status, findings } = row;
  const name = item.kind === 'lesson' ? `${titleOf(item.slug)} (practice)` : titleOf(item.slug);
  const li = h('li', { class: 'plan-item', 'data-status': status, 'data-slug': item.slug },
    h('span', { class: 'plan-dish' }, contentText('span', name)), ' ', statusChip(status));
  const shown = findings.filter((f) => f.status !== 'blocked' || status === 'blocked');
  if (shown.length > 0) li.append(h('ul', { class: 'plan-findings' }, ...shown.map((f) => h('li', null, findingText(f)))));
  if (status === 'blocked') {
    li.append(contentText('p', o.line('plan.blocked_dish', blockedDishLine(item.slug, findings, canonRecipes(), graph).vars), { class: 'plan-line' }));
    const alts = (o.alternatives?.(item) ?? []).filter((a) => a.kind === 'recipe');
    if (alts.length > 0) {
      li.append(h('p', { class: 'plan-alt-label' }, 'Adapted versions, checked against your rules:'),
        h('ul', { class: 'plan-alternatives' }, ...alts.map((a) => h('li', null, statusChip(a.status), ' ',
          a.kind === 'recipe' ? h('a', { href: routeHref({ name: 'recipe', slug: a.slug }) }, contentText('span', titleOf(a.slug))) : null))));
    }
  } else if (status === 'unverified') {
    li.append(contentText('p', o.line('plan.unverified_dish', { dish: titleOf(item.slug) }), { class: 'plan-line' }));
  }
  const buttons: HTMLElement[] = [];
  if (o.onCook && item.kind === 'dish') {
    const cook = h('button', { type: 'button', class: 'btn btn-secondary plan-cook' }, 'Cook');
    cook.setAttribute('aria-label', `Cook ${name}`);
    // ⛔ is never cookable (§4.4): the button stays, disabled, so the row says why.
    if (status === 'blocked') cook.disabled = true;
    else cook.addEventListener('click', () => o.onCook!(item));
    buttons.push(cook);
  }
  if (o.onRemove) {
    const remove = h('button', { type: 'button', class: 'btn btn-secondary plan-remove', 'aria-label': `Remove ${name}` }, 'Remove');
    remove.addEventListener('click', () => o.onRemove!(item));
    buttons.push(remove);
  }
  if (buttons.length > 0) li.append(h('div', { class: 'button-row' }, ...buttons));
  return li;
}

const FLAG_TRIGGER: Record<Exclude<PlanFlag, null>, string> = { gap_green: 'plan.gap_green', gap_protein: 'plan.gap_protein', balanced: 'plan.balanced' };

/** The weekly slot: `one_more.offer` or `one_more.refresh`, with "Yes, add it" and "Not this week". */
function slotView(v: SlotOfferView, line: PlanViewOpts['line']): HTMLElement {
  const { offer } = v;
  const dish = titleOf(offer.recipe);
  const text = offer.kind === 'new'
    ? line('one_more.offer', { technique: techniqueName(offer.technique), known: techniqueName(offer.from), dish, day: v.day })
    : line('one_more.refresh', { technique: techniqueName(offer.technique), dish });
  const box = h('section', { class: 'plan-slot', 'aria-labelledby': 'plan-slot-title' },
    contentText('h3', content.bureau.forms.plan.fields.find((f) => f.key === 'one_more')?.label ?? 'One More Technique', { id: 'plan-slot-title' }),
    contentText('p', text, { class: 'plan-line' }), statusChip(offer.status));
  if (v.onAnswer) {
    const yes = h('button', { type: 'button', class: 'btn btn-primary plan-slot-yes' }, 'Yes, add it');
    const no = h('button', { type: 'button', class: 'btn btn-secondary plan-slot-no' }, 'Not this week');
    yes.addEventListener('click', () => v.onAnswer!(true));
    no.addEventListener('click', () => v.onAnswer!(false));
    box.append(h('div', { class: 'button-row' }, yes, no));
  }
  return box;
}

export function renderPlanView(o: PlanViewOpts): HTMLElement {
  const days = o.allDays ? [0, 1, 2, 3, 4, 5, 6] : [...new Set(o.rows.map((r) => r.item.day))].sort((a, b) => a - b);
  const list = h('ol', { class: 'plan-days' });
  for (const d of days) {
    const rows = o.rows.filter((r) => r.item.day === d);
    const label = weekdayName(o.weekStart, d);
    const day = h('li', { class: 'plan-day', 'data-day': String(d) }, h('h3', { class: 'plan-day-name', id: `plan-day-${d}`, tabindex: -1 }, label));
    if (rows.length > 0) day.append(h('ul', { class: 'plan-items', 'aria-label': label }, ...rows.map((r) => itemRow(r, o))));
    const extra = o.dayExtra?.(d) ?? null;
    if (extra) day.append(extra);
    list.append(day);
  }
  const out = h('div', { class: 'plan-view' }, list);
  if (o.flag) out.append(contentText('p', o.line(FLAG_TRIGGER[o.flag], {}), { class: 'plan-flag', 'data-flag': o.flag }));
  if (o.offer) out.append(slotView(o.offer, o.line));
  return out;
}

/**
 * Where the week's One More Technique would go: its dish's planned day, else the first day with no dish from the day
 * after today (M9), so its practice day (the day before) is today at the earliest, never a day already gone.
 */
export function slotDay(plan: Plan, offer: SlotOffer, today: string): number | null {
  const planned = plan.items.find((i) => i.kind === 'dish' && i.slug === offer.recipe);
  if (planned) return planned.day;
  const t = dayOfWeek(plan.weekStart, today);
  // A week that hasn't started yet: from its second day; one already under way: from tomorrow.
  const from = Math.max(1, t === null ? (today < plan.weekStart ? 1 : 7) : t + 1);
  for (let d = from; d < 7; d++) if (!plan.items.some((i) => i.kind === 'dish' && i.day === d)) return d;
  return null;
}

