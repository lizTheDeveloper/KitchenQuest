import {
  checkPlan, marketList, normalizeName, STALL_IDS, validatePlan, type ListItem, type MarketRunView, type Plan,
} from '@kitchenquest/core/engine';
import { content } from '../content';
import type { LocalRun, PlayerState, PlayerStore } from '../state/store';
import { canonRecipes, devicePlan, planContextFor, retainedWeek, rulesOf } from './context';

/**
 * The week on this device (M5 Step 10, Ruling 8): signed out, the plan and its market run live in the player store,
 * in the API's shapes (C40), and are judged exactly as the server judges them (Step 6): a plan is shape-checked by
 * core `validatePlan` and never stored with an item ⛔ on its date; a run's unticked rows are recomputed by core
 * `marketList` from the plan, the pantry and the rules as they are now, and its ticked rows are kept as they are.
 * Ticking puts the item in the pantry with today's date and `source: 'market'` (Ruling 16); unticking removes
 * exactly that row, by id. Signed-in weeks go through the API instead (week/source.ts).
 */
export interface WeekStore {
  plan(weekStart: string): Plan | null;
  /** Saves a plan; refused (nothing written) when its shape is wrong or an item is ⛔ on its date. */
  savePlan(p: Plan): { ok: true; previous: Plan | null } | { ok: false; problems: string[] };
  /** Puts `previous` back for its week (an undo), or deletes the week's plan and run when it is null. */
  restorePlan(weekStart: string, previous: Plan | null): void;
  /** The week's run, opened (created) on first read; null when the week has no plan or the rules can't be read. */
  run(weekStart: string, today: string): MarketRunView | null;
  /** null when there is no such run, the key is not on it any more, or the run is done. */
  tick(weekStart: string, key: string, ticked: boolean, today: string): MarketRunView | null;
  /** "That's the shop done": sets doneAt once. Returns the run and whether this call finished it. */
  finish(weekStart: string, at: Date): { run: MarketRunView; finished: boolean } | null;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** core `marketList`'s own order: stall, then name, then key. */
const listOrder = (a: ListItem, b: ListItem): number =>
  STALL_IDS.indexOf(a.stall) - STALL_IDS.indexOf(b.stall) || byText(normalizeName(a.name), normalizeName(b.name)) || byText(a.key, b.key);

const viewOf = (r: LocalRun): MarketRunView => ({ id: r.id, weekStart: r.weekStart, items: r.items, doneAt: r.doneAt });

const storedPlan = devicePlan;

/** Plans (and runs) whose week ended more than PLAN_RETENTION_WEEKS ago leave the device. */
const retained = (s: PlayerState, today: string): PlayerState['localWeek'] => retainedWeek(s.localWeek, today);

/** The run's rows now (the server's `recompute`): ticked rows kept exactly, every other row from `marketList`. */
function recompute(s: PlayerState, plan: Plan, existing: LocalRun | null): Pick<LocalRun, 'items' | 'pantryIds'> | null {
  const rules = rulesOf(s);
  if (rules === null) return null;
  const fresh = marketList(plan, planContextFor(plan.weekStart, rules), s.localPantry, content.stallOf);
  const ticked = (existing?.items ?? []).filter((i) => i.ticked);
  const keys = new Set(ticked.map((i) => i.key));
  const items = [...ticked, ...fresh.filter((i) => !keys.has(i.key))].sort(listOrder);
  const pantryIds = Object.fromEntries(Object.entries(existing?.pantryIds ?? {}).filter(([k]) => keys.has(k)));
  return { items, pantryIds };
}

export function createWeekStore(deps: { store: PlayerStore; newId?: () => string; today?: () => string }): WeekStore {
  const { store } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const runOf = (s: PlayerState, weekStart: string) => s.localWeek.runs.find((r) => r.weekStart === weekStart) ?? null;
  const withRun = (s: PlayerState, run: LocalRun): PlayerState =>
    ({ ...s, localWeek: { ...s.localWeek, runs: [...s.localWeek.runs.filter((r) => r.weekStart !== run.weekStart), run] } });

  return {
    plan: (weekStart) => storedPlan(store.get(), weekStart),

    savePlan(p) {
      const plan: Plan = { weekStart: p.weekStart, items: p.items.map((i) => ({ ...i })), hard: p.hard, slot: p.slot };
      const problems = validatePlan(plan, { recipes: canonRecipes() });
      if (problems.length > 0) return { ok: false, problems };
      let out: { ok: true; previous: Plan | null } | { ok: false; problems: string[] } = { ok: false, problems: ['plan: not saved'] };
      store.update((s) => {
        const rules = rulesOf(s);
        // Can't verify is never safe: with the rules unreadable nothing is planned.
        if (rules === null) { out = { ok: false, problems: ['rules: unreadable'] }; return s; }
        const blocked = checkPlan(plan, planContextFor(plan.weekStart, rules)).filter((c) => c.status === 'blocked');
        if (blocked.length > 0) { out = { ok: false, problems: [...new Set(blocked.map((c) => `blocked: ${c.item.slug}`))] }; return s; }
        out = { ok: true, previous: storedPlan(s, plan.weekStart) };
        const kept = retained(s, deps.today?.() ?? plan.weekStart);
        return { ...s, localWeek: { ...kept, plans: [...kept.plans.filter((x) => x.weekStart !== plan.weekStart), plan] } };
      });
      return out;
    },

    restorePlan(weekStart, previous) {
      store.update((s) => ({
        ...s,
        localWeek: previous === null
          ? { plans: s.localWeek.plans.filter((x) => x.weekStart !== weekStart), runs: s.localWeek.runs.filter((r) => r.weekStart !== weekStart) }
          : { ...s.localWeek, plans: [...s.localWeek.plans.filter((x) => x.weekStart !== weekStart), previous] },
      }));
    },

    run(weekStart) {
      let view: MarketRunView | null = null;
      store.update((s) => {
        const plan = storedPlan(s, weekStart);
        if (plan === null) return s;
        const existing = runOf(s, weekStart);
        if (existing?.doneAt) { view = viewOf(existing); return s; }
        const rows = recompute(s, plan, existing);
        if (rows === null) return s;
        const run: LocalRun = { id: existing?.id ?? newId(), weekStart, doneAt: null, ...rows };
        view = viewOf(run);
        return withRun(s, run);
      });
      return view;
    },

    tick(weekStart, key, ticked, today) {
      let view: MarketRunView | null = null;
      store.update((s) => {
        const plan = storedPlan(s, weekStart);
        const existing = runOf(s, weekStart);
        if (plan === null || existing === null || existing.doneAt !== null) return s;
        const rows = recompute(s, plan, existing);
        if (rows === null) return s;
        const index = rows.items.findIndex((i) => i.key === key);
        if (index < 0) return s;
        const row = rows.items[index];
        const pantryIds = { ...rows.pantryIds };
        let pantry = s.localPantry;
        if (ticked && !row.ticked) {
          const id = newId();
          pantry = [...pantry, { id, name: row.name, ingredientId: row.ingredientId, addedOn: today, source: 'market' }];
          pantryIds[key] = id;
        } else if (!ticked && row.ticked) {
          // That row only, by id: an item of the same name that was already there is never touched.
          if (Object.hasOwn(pantryIds, key)) { const id = pantryIds[key]; pantry = pantry.filter((p) => p.id !== id); }
          delete pantryIds[key];
        }
        const run: LocalRun = { ...existing, items: rows.items.map((i, n) => (n === index ? { ...i, ticked } : i)), pantryIds };
        view = viewOf(run);
        return { ...withRun(s, run), localPantry: pantry };
      });
      return view;
    },

    finish(weekStart, at) {
      let out: { run: MarketRunView; finished: boolean } | null = null;
      store.update((s) => {
        const existing = runOf(s, weekStart);
        if (existing === null) return s;
        if (existing.doneAt !== null) { out = { run: viewOf(existing), finished: false }; return s; }
        const run: LocalRun = { ...existing, doneAt: at.toISOString() };
        out = { run: viewOf(run), finished: true };
        return withRun(s, run);
      });
      return out;
    },
  };
}
