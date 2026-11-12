import { compactHistory, deriveProgress, type Catalogue, type ProgressEvent, type ProgressHistory, type ProgressView, type RewardGrant } from '@kitchenquest/core/engine';
import { MAX_DEVICE_EVENTS, partitionOf, withPartition, type DeviceProgress, type PlayerStore } from '../state/store';
import { catalogueOf } from './catalogue';

/** A progress event id: an opaque UUID (the API accepts only those, I3 ruling), never derived from content. */
export function newEventId(): string {
  return crypto.randomUUID();
}

/** The device log as core's `ProgressHistory`. */
export const historyOf = (p: DeviceProgress): ProgressHistory => ({ events: p.events, grants: p.grants, base: p.base });

/** What the device log alone shows (signed out, or the device half of the signed-in max, C14). */
export function deviceView(p: DeviceProgress, cat: Catalogue = catalogueOf()): ProgressView {
  return deriveProgress(historyOf(p), cat);
}

/**
 * Add events core accepted, and the grants it made for them, to partition `key` of the device log (C1 ruling: the
 * guest's when null, else that account's; the caller pins the key when it judged the events). With `pending` (the default) their
 * ids wait for the account upload (Ruling 8). Over MAX_DEVICE_EVENTS, core `compactHistory` folds the oldest events
 * and their grants into `progress.base` (a totals snapshot, C15): no derived value ever drops, and the next event's
 * grants are the same as without compaction. A folded event's id leaves `pendingUpload` (it can no longer be
 * posted; the signed-in view is the field-wise max of account and device, so nothing shown drops either).
 */
export function appendEvents(
  store: PlayerStore, key: string | null, events: ProgressEvent[], grants: RewardGrant[], opts: { pending?: boolean; cat?: Catalogue; max?: number } = {},
): void {
  if (events.length === 0) return;
  const cat = opts.cat ?? catalogueOf();
  const max = opts.max ?? MAX_DEVICE_EVENTS;
  store.update((s) => {
    const p = partitionOf(s, key);
    const held = new Set(p.events.map((e) => e.id));
    const fresh = events.filter((e) => !held.has(e.id));
    if (fresh.length === 0) return s;
    const freshIds = new Set(fresh.map((e) => e.id));
    let h: ProgressHistory = {
      events: [...p.events, ...fresh],
      grants: [...p.grants, ...grants.filter((g) => freshIds.has(g.eventId))],
      base: p.base,
    };
    // M6 Step 9 (C9): a stall round is scored from the stall files, which the device catalogue holds only once the lazy
    // market content has loaded. Folding one without them would fix its answers as never correct in the snapshot, so
    // the log waits (a little over its cap) until a catalogue with the market compacts it.
    const unscored = cat.market === undefined && h.events.some((e) => e.kind === 'stall_round');
    if (h.events.length > max && !unscored) h = compactHistory(h, max, cat);
    const kept = new Set(h.events.map((e) => e.id));
    const pending = opts.pending === false ? p.pendingUpload : [...p.pendingUpload, ...fresh.map((e) => e.id)];
    return withPartition(s, key, {
      events: [...h.events], grants: [...h.grants], base: h.base, pendingUpload: pending.filter((id) => kept.has(id)),
      ...(p.epoch === undefined ? {} : { epoch: p.epoch }),
    });
  });
}

/** Mark ids of partition `key` as uploaded (accepted, duplicate or refused for good): they are never posted again. */
export function markUploaded(store: PlayerStore, key: string | null, ids: Iterable<string>): void {
  const done = new Set(ids);
  if (done.size === 0) return;
  store.update((s) => {
    const p = partitionOf(s, key);
    const left = p.pendingUpload.filter((id) => !done.has(id));
    return left.length === p.pendingUpload.length ? s : withPartition(s, key, { ...p, pendingUpload: left });
  });
}
