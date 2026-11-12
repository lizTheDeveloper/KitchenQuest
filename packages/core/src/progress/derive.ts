import { foldHistory, snapshotOf, viewOf } from './fold';
import type { Catalogue, ProgressHistory, ProgressView, RewardsData } from './types';

/**
 * M6 Ruling 18 (M5 m12): the API folds a player's ledger into a sealed snapshot once more than this many events have
 * been recorded since the last one (or since the start), so a read folds at most about this many events on top of
 * it. A cache only: the snapshot is `compactHistory(history, 0, cat).base`, the C15 fold, so nothing derived changes.
 */
export const SNAPSHOT_EVERY = 500;

/**
 * Everything shown about progress, as a fold over events and grants (Ruling 7). XP and stamps are sums of grants,
 * level is the highest level grant (at least 1) and trust the highest trust grant per cook, so a retune of
 * data/rewards.yaml can never lower any of them. The toolkit is a fold over events.
 */
export function deriveProgress(h: ProgressHistory, cat: Catalogue): ProgressView {
  return viewOf(foldHistory(h, cat));
}

/** The level a total of XP reaches on a curve: 1, plus one for each threshold at or below it. */
export function levelFor(xp: number, levels: readonly number[]): number {
  let level = 1;
  for (const threshold of levels) {
    if (xp >= threshold) level += 1;
    else break;
  }
  return level;
}

/**
 * The trust a cook's relationship has reached (Ruling 2). Stranger (0) until that cook's quest is done, then Guest (1),
 * then one level for each `weeks_for_level` threshold the distinct cook-weeks meet. The weeks need not be in a row,
 * and a gap costs nothing. Never above the highest level the data has a name for.
 */
export function trustLevel(cookWeeks: number, questDone: boolean, data: RewardsData): number {
  if (!questDone) return 0;
  let level = 1;
  data.trust.weeks_for_level.forEach((weeks, i) => {
    if (cookWeeks >= weeks) level = Math.max(level, i + 2);
  });
  return Math.min(level, data.trust.names.length - 1);
}

/**
 * C15: the device log's compaction. Folds the oldest events, and the grants made for them, into `base`, keeping the
 * newest `keep` events and their grants. deriveProgress, and the grants of any next event, are the same before and
 * after; nothing is lowered.
 */
export function compactHistory(h: ProgressHistory, keep: number, cat: Catalogue): ProgressHistory {
  const n = Math.max(0, Math.floor(Number.isFinite(keep) ? keep : 0));
  if (h.events.length <= n) return h;
  const cut = h.events.length - n;
  const folded = h.events.slice(0, cut);
  const kept = h.events.slice(cut);
  const keptIds = new Set(kept.map((e) => e.id));
  const keptGrants = h.grants.filter((g) => keptIds.has(g.eventId));
  const foldedGrants = h.grants.filter((g) => !keptIds.has(g.eventId));
  const base = snapshotOf(foldHistory({ events: folded, grants: foldedGrants, base: h.base }, cat));
  return { events: kept, grants: keptGrants, base };
}

/**
 * Erase events: a meal-log undo, or a `health_data` delete (I2 ruling). Every grant is kept, so XP, level, stamps
 * and trust never drop, and a grant's own `eventId` and `isoDay` keep the id seen and the nourishment cap counted.
 * The 2 h meal gap then compares surviving meal-log events only.
 *
 * Meant for `meal_logged` events (meal logs are account-only, so there are none in a device log or compacted base).
 * Erasing other kinds also keeps XP, but views derived from events (toolkit tiers, quest steps, cookedOn) would lose
 * them, so callers erase only meal logs. Account delete is not this: it removes both ledgers, events and grants.
 */
export function eraseEvents(h: ProgressHistory, ids: Iterable<string>): ProgressHistory {
  const gone = new Set(ids);
  return { events: h.events.filter((e) => !gone.has(e.id)), grants: h.grants, base: h.base };
}
