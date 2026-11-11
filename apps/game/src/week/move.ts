import type { Plan, PlanItem } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { LocalRun, PlayerState, PlayerStore } from '../state/store';
import { h } from '../ui/dom';
import { addDays, devicePlan } from './context';

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

/** The device's plans whose days fall in the account's plan week starting `weekStart`, and their runs. */
export function moveCandidates(state: PlayerState, weekStart: string): { plans: Plan[]; runs: LocalRun[] } {
  const plans = state.localWeek.plans.filter((p) => {
    const at = daysFrom(weekStart, p.weekStart);
    return at > -7 && at < 7 && devicePlan(state, p.weekStart) !== null;
  });
  const weeks = new Set(plans.map((p) => p.weekStart));
  return { plans, runs: state.localWeek.runs.filter((r) => weeks.has(r.weekStart)) };
}

/**
 * The account's week with the device's items on the same dates added (the device's week may start on another day:
 * an item whose date is outside the account's week stays out). Nothing the account already holds is dropped.
 */
export function mergedWeek(account: Plan | null, weekStart: string, device: readonly Plan[]): Plan {
  const items: PlanItem[] = [...(account?.items ?? [])];
  let hard = account?.hard ?? false;
  let slot = account?.slot ?? 'unanswered';
  for (const p of device) {
    for (const i of p.items) {
      const day = daysFrom(weekStart, addDays(p.weekStart, i.day));
      if (day < 0 || day > 6) continue;
      const moved = { ...i, day };
      if (!items.some((x) => sameItem(x, moved))) items.push(moved);
    }
    hard ||= p.hard;
    if (slot === 'unanswered') slot = p.slot;
  }
  return { weekStart, items, hard, slot };
}

export type MoveResult = 'moved' | 'consent' | 'nothing' | 'failed';

/** The tap: put the device week on the account, then its ticks and its finish; remove it from the device only after. */
export async function moveWeek(store: PlayerStore, client: ApiClient, today: string): Promise<MoveResult> {
  const s = store.get();
  if (s.account === null || s.settings.familyTable) return 'nothing';
  const email = s.account.email;
  /** The account changed while a call was on its way: stop, so nothing of this week reaches another account. */
  const left = () => store.get().account?.email !== email;
  const cur = await client.getPlan(today);
  if (!cur.ok || left()) return 'failed';
  const { weekStart } = cur.data;
  const { plans, runs } = moveCandidates(store.get(), weekStart);
  if (plans.length === 0) return 'nothing';
  const account = cur.data.plan === null ? null : { weekStart: cur.data.plan.weekStart, items: cur.data.plan.items, hard: cur.data.plan.hard, slot: cur.data.plan.slot };
  const put = await client.putPlan(mergedWeek(account, weekStart, plans), today);
  if (!put.ok) return put.status === 403 && put.error.code === 'consent_required' ? 'consent' : 'failed';
  if (left()) return 'failed';
  const ticked = runs.flatMap((r) => r.items.filter((i) => i.ticked).map((i) => i.key));
  const finished = runs.some((r) => r.doneAt !== null);
  if (ticked.length > 0 || finished) {
    const open = await client.openRun(weekStart, today);
    if (!open.ok) return open.status === 403 ? 'consent' : 'failed';
    if (left()) return 'failed';
    let run = open.data;
    for (const key of [...new Set(ticked)]) {
      const row = run.items.find((i) => i.key === key);
      // A row the account's list no longer has (its pantry holds it, or the rules took its dish) is not ticked.
      if (row === undefined || row.ticked || run.doneAt !== null) continue;
      const t = await client.tick(run.id, key, true, today);
      if (!t.ok || left()) return 'failed';
      run = t.data;
    }
    if (finished && run.doneAt === null) {
      const f = await client.finishRun(run.id, today);
      if (!f.ok) return 'failed';
    }
  }
  // Every write landed for this same account: the week leaves the device (moved, not copied).
  const gone = new Set(plans.map((p) => p.weekStart));
  store.update((x) => (x.account?.email !== email ? x : {
    ...x, localWeek: { plans: x.localWeek.plans.filter((p) => !gone.has(p.weekStart)), runs: x.localWeek.runs.filter((r) => !gone.has(r.weekStart)) },
  }));
  return 'moved';
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
  const run = async () => {
    if (busy) return;
    busy = true;
    yes.disabled = true;
    try {
      const r = await moveWeek(opts.store, opts.client, opts.today);
      if (r === 'moved' || r === 'nothing') { box.remove(); opts.onMoved(); return; }
      if (r === 'consent') { opts.onConsent(() => { void run(); }); return; }
      note.textContent = "That didn't go through, so nothing moved. This week is still on this device.";
    } finally { busy = false; yes.disabled = false; }
  };
  yes.addEventListener('click', () => { void run(); });
  no.addEventListener('click', () => { dismissed = true; box.remove(); });
  return box;
}
