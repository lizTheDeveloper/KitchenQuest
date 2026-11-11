import { describe, expect, test } from 'vitest';
import { MAX_PROGRESS_EVENTS_PER_DAY, type ProgressEvent, type ProgressView, type RewardGrant } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, ProgressPostResponse } from '../api/types';
import { createStore, type PlayerStore } from '../state/store';
import { grantLines } from './announce';
import { newEventId } from './log';
import { createProgressSync, EVENTS_PER_REQUEST } from './sync';

const PARIPPU = 'india/kerala/parippu';
const VIEW: ProgressView = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {} };
const cooked = (at: string, recipe = PARIPPU): ProgressEvent => ({ id: newEventId(), kind: 'cooked', at, recipe, planned: false });
const lesson = (at: string): ProgressEvent => ({ id: newEventId(), kind: 'lesson', at, recipe: PARIPPU });

interface Post { events: ProgressEvent[]; upload: true | undefined }

/** A fake API: records every post and answers with `answer` (default: everything accepted, no grants). */
function fakeClient(answer?: (p: Post) => ApiResult<ProgressPostResponse>) {
  const posts: Post[] = [];
  const client = {
    postProgressEvents: (events: ProgressEvent[], upload?: true) => {
      const p = { events, upload };
      posts.push(p);
      return Promise.resolve(answer ? answer(p) : ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })) }));
    },
    getProgress: () => Promise.resolve({ ok: true, status: 200, data: { view: VIEW } }),
  } as unknown as ApiClient;
  return { client, posts };
}
const ok = (r: Partial<ProgressPostResponse>): ApiResult<ProgressPostResponse> =>
  ({ ok: true, status: 200, data: { accepted: [], duplicate: [], rejected: [], warnings: [], view: VIEW, ...r } });

/** Timers we run by hand, and a clock we move. */
function fakeTime() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: (x: unknown) => { const i = timers.indexOf(x as never); if (i >= 0) timers.splice(i, 1); },
    async advance(ms: number) {
      t += ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

function setup(opts: { answer?: (p: Post) => ApiResult<ProgressPostResponse>; online?: () => boolean; store?: PlayerStore } = {}) {
  const store = opts.store ?? createStore(null);
  const { client, posts } = fakeClient(opts.answer);
  const time = fakeTime();
  const views: ProgressView[] = [];
  const sync = createProgressSync({
    store, client, online: opts.online ?? (() => true), gapMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    onAccountView: (v) => views.push(v),
  });
  return { store, posts, sync, time, views };
}
const signIn = (store: PlayerStore) => store.update((s) => ({ ...s, account: { email: 'a@example.test' } }));

describe('progress sync', () => {
  test('sync: signed out → local grants; sign-in → device log uploaded once with upload: true; replay after offline → duplicates only, no double lines', async () => {
    let online = true;
    const { store, posts, sync } = setup({
      online: () => online,
      // The server has the events already (they went up once): a replay is only duplicates.
      answer: (p) => ok({ duplicate: p.events.map((e) => e.id) }),
    });
    // Signed out: core on the device decides, nothing is posted.
    const first = cooked('2026-11-09');
    const grants = await sync.record([first]);
    expect(grants.some((g) => g.kind === 'xp' && g.reason === 'cook')).toBe(true);
    expect(posts).toHaveLength(0);
    const more = Array.from({ length: 149 }, (_, i) => lesson(`2026-10-${String((i % 28) + 1).padStart(2, '0')}`));
    await sync.record(more);
    const held = store.get().progress.events.map((e) => e.id);
    expect(store.get().progress.pendingUpload).toEqual(held);

    // Sign in: every held event once, in log order, 100 per request, marked upload.
    signIn(store);
    await sync.uploadDeviceLog();
    expect(posts.map((p) => p.upload)).toEqual([true, true]);
    expect(posts.map((p) => p.events.length)).toEqual([EVENTS_PER_REQUEST, held.length - EVENTS_PER_REQUEST]);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).toEqual(held);
    expect(store.get().progress.pendingUpload).toEqual([]);
    await sync.uploadDeviceLog();
    expect(posts).toHaveLength(2); // once

    // Offline while signed in: the device's grants are used and the event waits.
    online = false;
    const offline = cooked('2026-11-10');
    const said = grantLines(await sync.record([offline]), [offline]);
    expect(posts).toHaveLength(2);
    expect(store.get().progress.pendingUpload).toEqual([offline.id]);
    // Back online: the replay posts it once; the server says duplicate; nothing new is said.
    online = true;
    await sync.uploadDeviceLog();
    expect(posts).toHaveLength(3);
    expect(posts[2]).toEqual({ events: [offline], upload: true });
    expect(store.get().progress.pendingUpload).toEqual([]);
    expect(said.length).toBeLessThanOrEqual(2); // the one record's lines, and no second set from the replay
  });

  test('sync: signed in, a live record is posted (not as an upload) and returns the server\'s grants', async () => {
    const level: RewardGrant = { id: 'x#0', eventId: '', isoDay: '2026-11-09', kind: 'level', level: 2 };
    const { store, posts, sync, views } = setup({ answer: (p) => ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [{ ...level, eventId: e.id }] })) }) });
    signIn(store);
    const e = cooked('2026-11-09');
    const grants = await sync.record([e]);
    expect(posts).toEqual([{ events: [e], upload: undefined }]);
    expect(grants).toEqual([{ ...level, eventId: e.id }]);
    expect(views).toHaveLength(1);
    expect(store.get().progress.pendingUpload).toEqual([]);
    expect(store.get().progress.events.map((x) => x.id)).toEqual([e.id]); // the device keeps its own copy
  });

  test('sync: signed out, the 201st event of one day gets no grants, as on the server (C14)', async () => {
    const { store, sync } = setup();
    const filler = Array.from({ length: MAX_PROGRESS_EVENTS_PER_DAY }, () => lesson('2026-11-09'));
    await sync.record(filler);
    expect(store.get().progress.events).toHaveLength(MAX_PROGRESS_EVENTS_PER_DAY);
    const over = cooked('2026-11-09');
    expect(await sync.record([over])).toEqual([]);
    expect(store.get().progress.events.map((e) => e.id)).not.toContain(over.id);
    // The same cook the next day earns as usual.
    expect((await sync.record([cooked('2026-11-10')])).length).toBeGreaterThan(0);
  });

  test('sync: a 429 keeps events unsynced until retryAfterSeconds has passed, then they go up', async () => {
    let limited = true;
    const { store, posts, sync, time } = setup({
      answer: (p) => (limited
        ? { ok: false, status: 429, error: { code: 'rate_limited', message: 'slow down', details: { retryAfterSeconds: 30 }, retryAfter: 30 } }
        : ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [] })) })),
    });
    signIn(store);
    const e = cooked('2026-11-09');
    const grants = await sync.record([e]);
    expect(grants.length).toBeGreaterThan(0); // the device's own, meanwhile
    expect(store.get().progress.pendingUpload).toEqual([e.id]);
    limited = false;
    await sync.uploadDeviceLog();
    await sync.record([cooked('2026-11-09', 'japan/osaka/onigiri')]);
    expect(posts).toHaveLength(1); // nothing sent inside the wait
    await time.advance(29_000);
    expect(posts).toHaveLength(1);
    await time.advance(2_000);
    expect(posts.length).toBe(2);
    expect(posts[1].upload).toBe(true);
    expect(store.get().progress.pendingUpload).toEqual([]);
  });

  test('sync: live events recorded while a request is out ride together in the next one (batched)', async () => {
    let release: (() => void) | null = null;
    const store = createStore(null);
    const posts: ProgressEvent[][] = [];
    const client = {
      postProgressEvents: async (events: ProgressEvent[]) => {
        posts.push(events);
        if (posts.length === 1) await new Promise<void>((r) => { release = r; });
        return ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })) });
      },
    } as unknown as ApiClient;
    const sync = createProgressSync({ store, client, online: () => true, gapMs: 0 });
    signIn(store);
    const a = sync.record([cooked('2026-11-01')]);
    await new Promise((r) => setTimeout(r, 0));
    const b = sync.record([cooked('2026-11-02')]);
    const c = sync.record([cooked('2026-11-03')]);
    release!();
    await Promise.all([a, b, c]);
    expect(posts.map((p) => p.length)).toEqual([1, 2]);
  });

  test('Family Table mode keeps nothing: no event stored, none posted', async () => {
    const { store, posts, sync } = setup();
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    signIn(store);
    expect(await sync.record([cooked('2026-11-09')])).toEqual([]);
    expect(store.get().progress.events).toEqual([]);
    expect(posts).toEqual([]);
  });
});
