import type { MarketRunView, Plan } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult } from '../api/types';
import type { PlayerStore } from '../state/store';
import { weekOf } from './context';
import { createWeekStore, type WeekStore } from './local-week';

/**
 * The week, wherever it lives (M5 Step 10): signed out, the device (`local-week.ts`); signed in, the Step 6 routes,
 * always with `today`, the player's local date. Plans and runs are health data (Step 6 ruling), so a signed-in write
 * without `health_data` comes back as `consent` and the caller shows the consent card. Nothing here writes in Family
 * Table mode (C31): every write, and opening a run, answers `family_table` without a call.
 */
export type WeekFailure =
  | { kind: 'consent' }
  | { kind: 'family_table' }
  | { kind: 'rules' }
  | { kind: 'invalid'; problems: string[] }
  | { kind: 'closed' }
  | { kind: 'network' };
export type WeekResult<T> = { ok: true; value: T } | ({ ok: false } & WeekFailure);

export interface WeekNow { weekStart: string; plan: Plan | null }

export interface WeekSource {
  /** The current plan week (from the player's market days and `today`) and its plan, or null. */
  current(today: string): Promise<WeekResult<WeekNow>>;
  save(plan: Plan, today: string): Promise<WeekResult<{ previous: Plan | null }>>;
  /** An undo: `previous` back for its week, or the week's plan deleted when it is null. */
  restore(weekStart: string, previous: Plan | null, today: string): Promise<WeekResult<null>>;
  openRun(weekStart: string, today: string): Promise<WeekResult<MarketRunView>>;
  tick(run: MarketRunView, key: string, ticked: boolean, today: string): Promise<WeekResult<MarketRunView>>;
  /** `finished`: this call finished the run (the first "That's the shop done"). */
  finish(run: MarketRunView, today: string, at: Date): Promise<WeekResult<{ run: MarketRunView; finished: boolean }>>;
}

const fail = <T>(f: WeekFailure): WeekResult<T> => ({ ok: false, ...f });

/** An API refusal as a week failure. */
function refusal<T>(r: Extract<ApiResult<unknown>, { ok: false }>): WeekResult<T> {
  if (r.status === 403 && r.error.code === 'consent_required') return fail({ kind: 'consent' });
  if (r.status === 409 && r.error.code === 'run_closed') return fail({ kind: 'closed' });
  if (r.status === 409 && r.error.code === 'rules_need_review') return fail({ kind: 'rules' });
  if (r.status === 400 || r.status === 404) {
    const problems = (r.error.details as { problems?: unknown } | undefined)?.problems;
    return fail({ kind: 'invalid', problems: Array.isArray(problems) ? problems.filter((p): p is string => typeof p === 'string') : [r.error.code] });
  }
  return fail({ kind: 'network' });
}

/** The plan without the server's row id: the shape a save and an undo send. */
const bare = (p: (Plan & { id?: string }) | null): Plan | null => (p === null ? null : { weekStart: p.weekStart, items: p.items, hard: p.hard, slot: p.slot });

export function createWeekSource(deps: { store: PlayerStore; client: ApiClient; device?: WeekStore }): WeekSource {
  const { store, client } = deps;
  const device = deps.device ?? createWeekStore({ store });
  const signedIn = () => store.get().account !== null;
  const familyTable = () => store.get().settings.familyTable;

  return {
    async current(today) {
      if (!signedIn()) {
        const weekStart = weekOf(today, store.get().localProfile?.marketDays ?? []);
        return { ok: true, value: { weekStart, plan: device.plan(weekStart) } };
      }
      const r = await client.getPlan(today);
      if (!r.ok) return refusal(r);
      return { ok: true, value: { weekStart: r.data.weekStart, plan: bare(r.data.plan) } };
    },

    async save(plan, today) {
      if (familyTable()) return fail({ kind: 'family_table' });
      if (!signedIn()) {
        const out = device.savePlan(plan);
        if (!out.ok) return fail(out.problems.includes('rules: unreadable') ? { kind: 'rules' } : { kind: 'invalid', problems: out.problems });
        return { ok: true, value: { previous: out.previous } };
      }
      const before = await client.getPlan(today);
      if (!before.ok) return refusal(before);
      const r = await client.putPlan(plan, today);
      if (!r.ok) return refusal(r);
      return { ok: true, value: { previous: before.data.weekStart === plan.weekStart ? bare(before.data.plan) : null } };
    },

    async restore(weekStart, previous, today) {
      if (familyTable()) return fail({ kind: 'family_table' });
      if (!signedIn()) { device.restorePlan(weekStart, previous); return { ok: true, value: null }; }
      const r = previous === null ? await client.deletePlan(weekStart) : await client.putPlan(previous, today);
      if (!r.ok && r.status !== 404) return refusal(r);
      return { ok: true, value: null };
    },

    async openRun(weekStart, today) {
      // Family Table: opening a run is a write (C31). The screen shows the list computed on the device instead.
      if (familyTable()) return fail({ kind: 'family_table' });
      if (!signedIn()) {
        const run = device.run(weekStart, today);
        return run === null ? fail(device.plan(weekStart) === null ? { kind: 'invalid', problems: ['no plan'] } : { kind: 'rules' }) : { ok: true, value: run };
      }
      const r = await client.openRun(weekStart, today);
      return r.ok ? { ok: true, value: r.data } : refusal(r);
    },

    async tick(run, key, ticked, today) {
      if (familyTable()) return fail({ kind: 'family_table' });
      if (!signedIn()) {
        const out = device.tick(run.weekStart, key, ticked, today);
        return out === null ? fail({ kind: 'closed' }) : { ok: true, value: out };
      }
      const r = await client.tick(run.id, key, ticked, today);
      return r.ok ? { ok: true, value: r.data } : refusal(r);
    },

    async finish(run, today, at) {
      if (familyTable()) return fail({ kind: 'family_table' });
      if (!signedIn()) {
        const out = device.finish(run.weekStart, at);
        return out === null ? fail({ kind: 'closed' }) : { ok: true, value: out };
      }
      const r = await client.finishRun(run.id, today);
      if (!r.ok) return refusal(r);
      return { ok: true, value: { run: r.data, finished: run.doneAt === null && r.data.doneAt !== null } };
    },
  };
}
