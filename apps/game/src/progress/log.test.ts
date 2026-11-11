import { describe, expect, test } from 'vitest';
import { grantsFor, grantsForBatch, type ProgressEvent } from '@kitchenquest/core/engine';
import { content } from '../content';
import { createStore, MAX_DEVICE_EVENTS } from '../state/store';
import { catalogueOf } from './catalogue';
import { appendEvents, deviceView, historyOf, markUploaded, newEventId } from './log';

const cat = catalogueOf();
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const slugs = Object.keys(content.recipes).filter((s) => !content.recipes[s].meta.sacred);

/** `n` cooks spread over days, five a day, of every canon dish in turn: real XP, levels, tiers and trust weeks. */
function cooks(n: number, from = 0): ProgressEvent[] {
  return Array.from({ length: n }, (_, i) => ({ id: newEventId(), kind: 'cooked' as const, at: day(Math.floor((from + i) / 5)), recipe: slugs[(from + i) % slugs.length], planned: false }));
}

describe('progress log', () => {
  test('newEventId is a v4 UUID', () => {
    expect(newEventId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('appended events wait for upload; markUploaded clears them for good', () => {
    const store = createStore(null);
    const events = cooks(3);
    const results = grantsForBatch(events, historyOf(store.get().progress), cat, content.rewards, content.techniques.freshness);
    appendEvents(store, results.map((r) => r.event), results.flatMap((r) => r.grants));
    expect(store.get().progress.pendingUpload).toEqual(events.map((e) => e.id));
    markUploaded(store, [events[0].id]);
    expect(store.get().progress.pendingUpload).toEqual(events.slice(1).map((e) => e.id));
    appendEvents(store, results.map((r) => r.event), []); // the same ids again: nothing doubles
    expect(store.get().progress.events).toHaveLength(3);
  });

  test('a 2001st event compacts into base and no derived value drops; the next grants are the same (C15)', () => {
    const store = createStore(null);
    const events = cooks(MAX_DEVICE_EVENTS);
    const results = grantsForBatch(events, historyOf(store.get().progress), cat, content.rewards, content.techniques.freshness);
    expect(results.every((r) => r.problems.length === 0)).toBe(true);
    appendEvents(store, results.map((r) => r.event), results.flatMap((r) => r.grants));
    expect(store.get().progress.base).toBeNull();
    const before = deviceView(store.get().progress);
    const uncompacted = historyOf(store.get().progress);

    const [next] = cooks(1, MAX_DEVICE_EVENTS + 40);
    const r = grantsFor(next, historyOf(store.get().progress), cat, content.rewards, content.techniques.freshness);
    appendEvents(store, [r.event], r.grants);
    const p = store.get().progress;
    expect(p.events).toHaveLength(MAX_DEVICE_EVENTS);
    expect(p.base).not.toBeNull();
    expect(p.pendingUpload).not.toContain(events[0].id); // folded: no longer posted
    const after = deviceView(p);
    expect(after.xp).toBeGreaterThanOrEqual(before.xp);
    expect(after.level).toBeGreaterThanOrEqual(before.level);
    expect(after.stamps).toBeGreaterThanOrEqual(before.stamps);
    for (const [cook, t] of Object.entries(before.trust)) expect(after.trust[cook]).toBeGreaterThanOrEqual(t);
    for (const [t, rec] of Object.entries(before.toolkit.techniques)) expect(after.toolkit.techniques[t].tier).toBe(rec.tier);
    for (const [slug, dates] of Object.entries(before.cookedOn)) for (const d of dates) expect(after.cookedOn[slug]).toContain(d);
    // The view after equals the uncompacted history plus the new event.
    const full = deviceView({ events: [...uncompacted.events, r.event], grants: [...uncompacted.grants, ...r.grants], base: null, pendingUpload: [] });
    expect(after).toEqual(full);
    // And the event after that earns exactly what it would have without compaction.
    const [third] = cooks(1, MAX_DEVICE_EVENTS + 80);
    const compacted = grantsFor(third, historyOf(p), cat, content.rewards, content.techniques.freshness);
    const plain = grantsFor(third, { events: [...uncompacted.events, r.event], grants: [...uncompacted.grants, ...r.grants], base: null }, cat, content.rewards, content.techniques.freshness);
    expect(compacted.grants).toEqual(plain.grants);
  });
});
