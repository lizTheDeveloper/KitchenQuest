import type { Catalogue, ProgressView, TechniqueRecord, Tier, ToolkitState } from '@kitchenquest/core/engine';
import { accountViewOf, partitionKey, partitionOf, type PlayerState } from '../state/store';
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

type Answered = ProgressView['marketAnswered'];
/** A view's stall answers; a view cached before M6 has none. */
const answeredOf = (v: { marketAnswered?: Answered }): Answered => v.marketAnswered ?? {};

/** Per stall question, ever correct on either side, and the later of the two last-answered dates (M6). */
function maxAnswered(a: Answered, b: Answered): Answered {
  return Object.fromEntries(
    keys(a, b).map((k) => {
      const x = own(a, k), y = own(b, k);
      if (x === undefined || y === undefined) return [k, { ...(x ?? y)! }];
      return [k, { correct: x.correct || y.correct, lastAt: x.lastAt > y.lastAt ? x.lastAt : y.lastAt }];
    }),
  );
}

/**
 * Two views as one where nothing goes down (Ruling 8, C14, C15): XP, level and stamps the larger; each cook's trust
 * and each quest's steps the larger; each technique's best tier, earliest first use and latest use; quests done,
 * and cook dates, as a union; each quest's earliest start; each stall question ever correct on either side, last
 * answered on the later date (M6).
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
    marketAnswered: maxAnswered(answeredOf(a), answeredOf(b)),
  };
}

/**
 * The progress the game shows, from the live partition only (C1 ruling). Signed out: core `deriveProgress` of the
 * guest partition. Signed in: the field-wise max of that account's view (the last one the server sent, cached with
 * its partition, M6) and its own device partition, so nothing shown ever drops, also while an upload is on its way,
 * after a reload, and when compacted device events never reached the account. Another account's partition, and the
 * guest's, are never part of it.
 */
export function currentProgress(state: PlayerState, cat: Catalogue = catalogueOf()): ProgressView {
  const key = partitionKey(state);
  const log = partitionOf(state, key);
  const account = key === null ? null : accountViewOf(state, key);
  // M5 final m12: folded once per partition log (and cached account view), not once per subscriber per change. The
  // log and the view are replaced, never changed in place, on every write, so their identity is the cache key.
  const hit = memo.get(log);
  if (hit !== undefined && hit.cat === cat && hit.account === account) return hit.view;
  const device = deviceView(log, cat);
  const view = account === null ? device : maxView(account, device);
  memo.set(log, { cat, account, view });
  return view;
}
const memo = new WeakMap<object, { cat: Catalogue; account: ProgressView | null; view: ProgressView }>();
