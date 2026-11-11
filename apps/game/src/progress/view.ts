import type { Catalogue, ProgressView, TechniqueRecord, Tier, ToolkitState } from '@kitchenquest/core/engine';
import type { PlayerState } from '../state/store';
import { catalogueOf } from './catalogue';
import { deviceView } from './log';

const RANK: Record<Tier, number> = { seen: 0, tried: 1, yours: 2 };
const own = <T>(r: Record<string, T>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);
const keys = (...rs: Record<string, unknown>[]): string[] => [...new Set(rs.flatMap((r) => Object.keys(r)))];

/** Per key, the larger number (a key on one side only keeps its value). */
function maxRecord(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  return Object.fromEntries(keys(a, b).map((k) => [k, Math.max(own(a, k) ?? 0, own(b, k) ?? 0)]));
}

/** Per key, the dates of both, sorted, without repeats. */
function unionDates(a: Record<string, string[]>, b: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(keys(a, b).map((k) => [k, [...new Set([...(own(a, k) ?? []), ...(own(b, k) ?? [])])].sort()]));
}

function maxToolkit(a: ToolkitState, b: ToolkitState): ToolkitState {
  const out = new Map<string, TechniqueRecord>(Object.entries(a.techniques));
  for (const [id, r] of Object.entries(b.techniques)) {
    const o = out.get(id);
    out.set(id, !o ? r : {
      tier: RANK[o.tier] >= RANK[r.tier] ? o.tier : r.tier,
      firstAt: o.firstAt < r.firstAt ? o.firstAt : r.firstAt,
      lastUsedAt: o.lastUsedAt > r.lastUsedAt ? o.lastUsedAt : r.lastUsedAt,
      recipes: [...new Set([...o.recipes, ...r.recipes])],
    });
  }
  return { techniques: Object.fromEntries(out) };
}

/**
 * Two views as one where nothing goes down (Ruling 8, C14, C15): XP, level and stamps the larger; each cook's trust
 * and each quest's steps the larger; each technique's best tier, earliest first use and latest use; quests done,
 * and cook dates, as a union; each quest's earliest start.
 */
export function maxView(a: ProgressView, b: ProgressView): ProgressView {
  return {
    xp: Math.max(a.xp, b.xp),
    level: Math.max(a.level, b.level),
    stamps: Math.max(a.stamps, b.stamps),
    trust: maxRecord(a.trust, b.trust),
    toolkit: maxToolkit(a.toolkit, b.toolkit),
    questsDone: [...new Set([...a.questsDone, ...b.questsDone])],
    questSteps: maxRecord(a.questSteps, b.questSteps),
    questStartedOn: Object.fromEntries(
      keys(a.questStartedOn, b.questStartedOn).map((k) => {
        const x = own(a.questStartedOn, k), y = own(b.questStartedOn, k);
        return [k, x === undefined ? y! : y === undefined ? x : x < y ? x : y];
      }),
    ),
    cookedOn: unionDates(a.cookedOn, b.cookedOn),
    framesCookedOn: unionDates(a.framesCookedOn, b.framesCookedOn),
  };
}

/**
 * The progress the game shows. Signed out: core `deriveProgress` of the device history. Signed in: the field-wise
 * max of the account view (null until `/progress` answers) and the device view, so nothing shown ever drops, also
 * while the sign-in upload is still on its way, and when compacted device events never reached the account.
 */
export function currentProgress(state: PlayerState, account: ProgressView | null, cat: Catalogue = catalogueOf()): ProgressView {
  const device = deviceView(state.progress, cat);
  if (state.account === null || account === null) return device;
  return maxView(account, device);
}
