import { blockedDishLine, dishName, type LineRef, type Plan, type PlanItem } from '@kitchenquest/core/engine';
import { graph } from '../content';
import type { ApiClient } from '../api/client';
import type { LocalRun, PlayerState, PlayerStore } from '../state/store';
import { contentText, h } from '../ui/dom';
import { blockedLinesFor, blockedSlugs } from './blocked';
import { addDays, canonRecipes, devicePlan, retainedWeek, rulesOf } from './context';
import { writtenLine } from './plan-view';

/**
 * Ruling 2 (Task 10 fix round 1): a week planned signed out reaches the account only on a tap ("Move this week to
 * your account?"), never by itself. The device's week is the guest's (Step 9 partitions): it is offered only to the
 * account signed in now, and once the account has confirmed every write it leaves the device (moved, not copied).
 * Plans are health data: without `health_data` the PUT is 403 and the consent card is shown; the tap can be made
 * again once it is granted. Every call sends `today`.
 */

const DAY_MS = 86_400_000;
const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
const sameItem = (a: PlanItem, b: PlanItem) => a.day === b.day && a.kind === b.kind && a.slug === b.slug;

/** An item of a device plan, placed on the account's week starting `weekStart`, or null when its date is outside it. */
function inWeek(p: Plan, i: PlanItem, weekStart: string): PlanItem | null {
  const day = daysFrom(weekStart, addDays(p.weekStart, i.day));
  return day < 0 || day > 6 ? null : { ...i, day };
}

/**
 * The device's plans with at least one item on a date in the account's plan week starting `weekStart`, and their
 * runs. Only those items move (N1); a device item on another date stays on the device.
 */
export function moveCandidates(state: PlayerState, weekStart: string): { plans: Plan[]; runs: LocalRun[] } {
  const plans = state.localWeek.plans.filter((p) => devicePlan(state, p.weekStart) !== null && p.items.some((i) => inWeek(p, i, weekStart) !== null));
  const weeks = new Set(plans.map((p) => p.weekStart));
  return { plans, runs: state.localWeek.runs.filter((r) => weeks.has(r.weekStart)) };
}

/**
 * The account's week with the device's items on the same dates added (the device's week may start on another day:
 * an item whose date is outside the account's week stays out, and so does a dish in `keep`). Nothing the account
 * already holds is dropped.
 */
export function mergedWeek(account: Plan | null, weekStart: string, device: readonly Plan[], keep: ReadonlySet<string> = new Set()): Plan {
  const items: PlanItem[] = [...(account?.items ?? [])];
  let hard = account?.hard ?? false;
  let slot = account?.slot ?? 'unanswered';
  for (const p of device) {
    for (const i of p.items) {
      const moved = keep.has(i.slug) ? null : inWeek(p, i, weekStart);
      if (moved !== null && !items.some((x) => sameItem(x, moved))) items.push(moved);
    }
    hard ||= p.hard;
    if (slot === 'unanswered') slot = p.slot;
  }
  return { weekStart, items, hard, slot };
}

/**
 * The device week after a move (N1): from each moved plan only the items that went to the account leave; a plan with
 * nothing left goes with its run, and a plan with items left keeps its run's rows for those dishes. On-device
 * retention (PLAN_RETENTION_WEEKS) applies to what stays.
 */
export function afterMove(w: PlayerState['localWeek'], moved: readonly Plan[], weekStart: string, keep: ReadonlySet<string>, today: string): PlayerState['localWeek'] {
  const plans: Plan[] = [];
  const runs: LocalRun[] = [];
  for (const p of w.plans) {
    const m = moved.find((x) => x.weekStart === p.weekStart);
    const left = m === undefined ? p.items : p.items.filter((i) => keep.has(i.slug) || inWeek(p, i, weekStart) === null);
    if (left.length === 0) continue;
    plans.push({ ...p, items: left });
    const run = w.runs.find((r) => r.weekStart === p.weekStart);
    if (run === undefined) continue;
    if (m === undefined) { runs.push(run); continue; }
    const dishes = new Set(left.map((i) => i.slug));
    const items = run.items.filter((i) => i.forDishes.some((d) => dishes.has(d)));
    runs.push({ ...run, items, pantryIds: Object.fromEntries(Object.entries(run.pantryIds).filter(([k]) => items.some((i) => i.key === k))) });
  }
  return retainedWeek({ plans, runs }, today);
}

/**
 * What a tap did. `moved`: everything that could go is with the account (`lines`: the dishes the account's rules
 * refuse, which stayed on the device, N2). `partial`: the plan landed but the ticks or the finish didn't all follow;
 * the device week is kept whole and a second tap carries on (`week.move_partial`, N2).
 */
export interface MoveResult { kind: 'moved' | 'partial' | 'consent' | 'nothing' | 'failed'; lines: LineRef[] }
const result = (kind: MoveResult['kind'], lines: LineRef[] = []): MoveResult => ({ kind, lines });

/** The tap: put the device week on the account, then its ticks and its finish; remove what moved from the device only after. */
export async function moveWeek(store: PlayerStore, client: ApiClient, today: string): Promise<MoveResult> {
  const s = store.get();
  if (s.account === null || s.settings.familyTable) return result('nothing');
  const email = s.account.email;
  /** The account changed while a call was on its way: stop, so nothing of this week reaches another account. */
  const left = () => store.get().account?.email !== email;
  const cur = await client.getPlan(today);
  if (!cur.ok || left()) return result('failed');
  const { weekStart } = cur.data;
  const { plans, runs } = moveCandidates(store.get(), weekStart);
  if (plans.length === 0) return result('nothing');
  const account = cur.data.plan === null ? null : { weekStart: cur.data.plan.weekStart, items: cur.data.plan.items, hard: cur.data.plan.hard, slot: cur.data.plan.slot };
  // N2: a dish the account's rules refuse (400 plan_invalid, `blocked: <slug>`) stays on the device, named; the rest moves.
  const keep = new Set<string>();
  let lines: LineRef[] = [];
  let put = await client.putPlan(mergedWeek(account, weekStart, plans, keep), today);
  if (!put.ok && put.status === 400 && put.error.code === 'plan_invalid') {
    const problems = (put.error.details as { problems?: unknown } | undefined)?.problems;
    const slugs = blockedSlugs(Array.isArray(problems) ? problems.filter((x): x is string => typeof x === 'string') : []);
    const devices = new Set(plans.flatMap((p) => p.items.map((i) => i.slug)));
    // Only the device's own dishes are kept back; a block in the account's own week can't be fixed by the move.
    if (slugs.length === 0 || slugs.some((x) => !devices.has(x))) return result('failed');
    for (const x of slugs) keep.add(x);
    const rules = rulesOf(store.get());
    const named = rules === null ? [] : blockedLinesFor(mergedWeek(null, weekStart, plans), rules).filter((l) => slugs.some((x) => l.vars.dish === dishName(x, canonRecipes())));
    lines = named.length > 0 ? named : slugs.map((x) => blockedDishLine(x, [], canonRecipes(), graph));
    if (left()) return result('failed');
    const rest = mergedWeek(account, weekStart, plans, keep);
    put = rest.items.length === (account?.items.length ?? 0) ? { ok: true, status: 200, data: { plan: { ...rest, id: '' }, checks: [] } } : await client.putPlan(rest, today);
  }
  if (!put.ok) return put.status === 403 && put.error.code === 'consent_required' ? result('consent') : result('failed', lines);
  if (left()) return result('failed');
  const ticked = runs.flatMap((r) => r.items.filter((i) => i.ticked && !i.forDishes.every((d) => keep.has(d))).map((i) => i.key));
  const finished = runs.some((r) => r.doneAt !== null);
  const partial = (): MoveResult => result('partial', [...lines, { trigger: 'week.move_partial', vars: {} }]);
  if (ticked.length > 0 || finished) {
    const open = await client.openRun(weekStart, today);
    if (!open.ok) return open.status === 403 ? result('consent') : partial();
    if (left()) return result('failed');
    let run = open.data;
    for (const key of [...new Set(ticked)]) {
      const row = run.items.find((i) => i.key === key);
      // A row the account's list no longer has (its pantry holds it, or the rules took its dish) is not ticked.
      if (row === undefined || row.ticked || run.doneAt !== null) continue;
      const t = await client.tick(run.id, key, true, today);
      if (!t.ok) return partial();
      if (left()) return result('failed');
      run = t.data;
    }
    if (finished && run.doneAt === null) {
      const f = await client.finishRun(run.id, today);
      if (!f.ok) return partial();
    }
  }
  // Every write landed for this same account: what moved leaves the device (moved, not copied); the rest stays.
  store.update((x) => (x.account?.email !== email ? x : { ...x, localWeek: afterMove(x.localWeek, plans, weekStart, keep, today) }));
  return result('moved', lines);
}

const OFFER = 'Move this week to your account?';
const OFFER_NOTE = 'You planned this week on this device before signing in. Moving it puts it with your account, and takes it off this device.';
let dismissed = false;

/**
 * The offer on the week screens, or null when there is nothing to move (or "Not now" was tapped on this page load).
 * `onMoved` redraws the screen; `onConsent` shows the health consent card (its grant lets the tap be made again).
 */
export function moveOffer(opts: {
  store: PlayerStore; client: ApiClient; weekStart: string; today: string; onMoved(): void; onConsent(retry: () => void): void;
}): HTMLElement | null {
  const s = opts.store.get();
  if (dismissed || s.account === null || s.settings.familyTable || moveCandidates(s, opts.weekStart).plans.length === 0) return null;
  const yes = h('button', { type: 'button', class: 'btn btn-primary week-move' }, 'Move it');
  const no = h('button', { type: 'button', class: 'btn btn-secondary week-move-later' }, 'Not now');
  const note = h('p', { role: 'status' });
  const box = h('section', { class: 'week-move-offer', 'aria-labelledby': 'week-move-title' },
    h('h2', { id: 'week-move-title', tabindex: -1 }, OFFER), h('p', null, OFFER_NOTE), h('div', { class: 'button-row' }, yes, no), note);
  let busy = false;
  let done = false;
  /** The Pan's written lines go in as written content (Step 12 fix round 1), the screen's own words beside them. */
  const showNote = (said: string, chrome: string | null) => {
    note.replaceChildren(...(said ? [contentText('span', said)] : []), ...(said && chrome ? [' '] : []), ...(chrome ? [chrome] : []));
  };
  const run = async () => {
    if (busy) return;
    busy = true;
    yes.disabled = true;
    try {
      const r = await moveWeek(opts.store, opts.client, opts.today);
      const said = r.lines.map((l) => writtenLine(l.trigger, l.vars)).join(' ');
      if ((r.kind === 'moved' && r.lines.length === 0) || r.kind === 'nothing') { box.remove(); opts.onMoved(); return; }
      if (r.kind === 'consent') { opts.onConsent(() => { void run(); }); return; }
      // Moved, with a dish the account's rules refuse kept on the device: say which, then "Done" redraws.
      if (r.kind === 'moved') { yes.remove(); no.textContent = 'Done'; done = true; showNote(said, null); return; }
      // N2: say what moved and what didn't; never "nothing moved" when the plan did.
      showNote(said, r.kind === 'partial' ? null : "That didn't go through, so nothing moved. This week is still on this device.");
    } finally { busy = false; yes.disabled = false; }
  };
  yes.addEventListener('click', () => { void run(); });
  no.addEventListener('click', () => { if (done) { box.remove(); opts.onMoved(); return; } dismissed = true; box.remove(); });
  return box;
}
