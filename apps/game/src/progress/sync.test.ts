import { describe, expect, test } from 'vitest';
import { MAX_PROGRESS_EVENTS_PER_DAY, type Catalogue, type ProgressEvent, type ProgressView, type RewardGrant, type RulesContext } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { ApiResult, ProgressPostResponse } from '../api/types';
import { accountKey, createStore, partitionOf, prunePartition, type PlayerStore } from '../state/store';
import { standInFixture } from './stand-in.fixture';
import { grantLines } from './announce';
import { currentProgress } from './view';
import { newEventId } from './log';
import { createProgressSync, EVENTS_PER_REQUEST, PROGRESS_REQUEST_GAP_MS } from './sync';

const PARIPPU = 'india/kerala/parippu';
const VIEW: ProgressView = { xp: 0, level: 1, stamps: 0, trust: {}, toolkit: { techniques: {} }, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, marketAnswered: {} };
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

function setup(opts: { answer?: (p: Post) => ApiResult<ProgressPostResponse>; online?: () => boolean; store?: PlayerStore; gapMs?: number; context?: () => RulesContext | undefined; catalogue?: Catalogue } = {}) {
  const store = opts.store ?? createStore(null);
  const { client, posts } = fakeClient(opts.answer);
  const time = fakeTime();
  const warnings: string[] = [];
  const sync = createProgressSync({
    store, client, online: opts.online ?? (() => true), ...('gapMs' in opts ? (opts.gapMs === undefined ? {} : { gapMs: opts.gapMs }) : { gapMs: 0 }), now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
    ...(opts.context ? { context: opts.context } : {}), ...(opts.catalogue ? { catalogue: opts.catalogue } : {}),
    onWarnings: (w) => warnings.push(...w.flatMap((x) => x.warnings)),
  });
  return { store, posts, sync, time, warnings };
}
const A = 'a@example.test';
const B = 'b@example.test';
const signIn = (store: PlayerStore, email = A) => store.update((s) => ({ ...s, account: { email } }));
const signOutOf = (store: PlayerStore) => store.update((s) => ({ ...s, account: null }));
const part = (store: PlayerStore, email: string | null) => partitionOf(store.get(), email === null ? null : accountKey(email));

describe('progress sync', () => {
  test('sync: signed out → local grants; sign-in uploads only the account\'s own log; guest progress goes up once (upload: true) only after the tap; replay after offline → duplicates only, no double lines', async () => {
    let online = true;
    const { store, posts, sync } = setup({ online: () => online, answer: (p) => ok({ duplicate: p.events.map((e) => e.id) }) });
    // Signed out: core on the device decides, nothing is posted, the guest partition holds it.
    const first = cooked('2026-11-09');
    const grants = await sync.record([first]);
    expect(grants.some((g) => g.kind === 'xp' && g.reason === 'cook')).toBe(true);
    expect(posts).toHaveLength(0);
    const more = Array.from({ length: 149 }, (_, i) => lesson(`2026-10-${String((i % 28) + 1).padStart(2, '0')}`));
    await sync.record(more);
    const held = part(store, null).events.map((e) => e.id);
    expect(part(store, null).pendingUpload).toEqual(held);

    // Sign in: nothing of the guest's goes up on its own (C1 ruling); the offer stands.
    signIn(store);
    await sync.uploadDeviceLog();
    expect(posts).toHaveLength(0);
    expect(sync.guestOffer()).toBe(true);
    // The tap: every guest event once, in log order, 100 per request, marked upload; then shown with the account.
    expect(await sync.addGuestProgress()).toBe(true);
    expect(posts.map((p) => p.upload)).toEqual([true, true]);
    expect(posts.map((p) => p.events.length)).toEqual([EVENTS_PER_REQUEST, held.length - EVENTS_PER_REQUEST]);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).toEqual(held);
    expect(part(store, null).pendingUpload).toEqual([]);
    expect(part(store, null).events).toEqual([]); // N5: moved, not copied: the account's server holds it now
    expect(currentProgress({ ...store.get(), account: null }).xp).toBe(0);
    expect(part(store, A).events.map((e) => e.id)).toEqual(held);
    expect(part(store, A).pendingUpload).toEqual([]);
    expect(sync.guestOffer()).toBe(false);
    await sync.uploadDeviceLog();
    expect(posts).toHaveLength(2); // once

    // Offline while signed in: the device's grants are used and the event waits in A's partition.
    online = false;
    const offline = cooked('2026-11-10');
    const said = grantLines(await sync.record([offline]), [offline]);
    expect(posts).toHaveLength(2);
    expect(part(store, A).pendingUpload).toEqual([offline.id]);
    online = true;
    await sync.uploadDeviceLog();
    expect(posts).toHaveLength(3);
    expect(posts[2]).toEqual({ events: [offline], upload: true });
    expect(part(store, A).pendingUpload).toEqual([]);
    expect(said.length).toBeLessThanOrEqual(2); // the one record's lines, and no second set from the replay
  });

  test('N2: the guest add runs once at a time (two taps, one post), and the offer hides while it runs', async () => {
    let release: (() => void) | null = null;
    const store = createStore(null);
    const posts: ProgressEvent[][] = [];
    const client = {
      postProgressEvents: async (events: ProgressEvent[]) => {
        posts.push(events);
        await new Promise<void>((r) => { release = r; });
        return ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })) });
      },
    } as unknown as ApiClient;
    const sync = createProgressSync({ store, client, online: () => true, gapMs: 0 });
    await sync.record([cooked('2026-11-09')]);
    signIn(store);
    expect(sync.guestOffer()).toBe(true);
    const one = sync.addGuestProgress();
    const two = sync.addGuestProgress();
    expect(sync.guestOffer()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    release!();
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(posts).toHaveLength(1);
  });

  test('N1: an answer that lands after its account signed out removes those events from the hidden partition', async () => {
    let release: (() => void) | null = null;
    const store = createStore(null);
    const client = {
      postProgressEvents: async (events: ProgressEvent[]) => {
        await new Promise<void>((r) => { release = r; });
        return ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })) });
      },
    } as unknown as ApiClient;
    const sync = createProgressSync({ store, client, online: () => true, gapMs: 0, liveWaitMs: 0 });
    signIn(store);
    const e = cooked('2026-11-09');
    void sync.record([e]);
    await new Promise((r) => setTimeout(r, 0));
    // Signed out while the post is out: the prune keeps it, as still unsynced.
    store.update((s) => prunePartition({ ...s, account: null }, accountKey(A)));
    expect(part(store, A).events.map((x) => x.id)).toEqual([e.id]);
    release!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(part(store, A).events).toEqual([]);
    expect(part(store, A).grants).toEqual([]);
    expect(part(store, A).pendingUpload).toEqual([]);
  });

  test('C1: A signs out, and the guest sees nothing of A', async () => {
    const { store, sync } = setup({ online: () => false });
    signIn(store);
    await sync.record([cooked('2026-11-09')]);
    expect(currentProgress(store.get()).cookedOn['india/kerala/parippu']).toEqual(['2026-11-09']);
    signOutOf(store);
    const guest = currentProgress(store.get());
    expect(guest.cookedOn).toEqual({});
    expect(guest.xp).toBe(0);
    expect(store.get().progress.events).toEqual([]);
  });

  test('C1: A then B: nothing of A is posted to B; A\'s offline events stay with A until A returns', async () => {
    let online = false;
    const { store, posts, sync } = setup({ online: () => online });
    signIn(store, A);
    const mine = cooked('2026-11-09');
    await sync.record([mine]);
    expect(part(store, A).pendingUpload).toEqual([mine.id]);
    signOutOf(store);
    signIn(store, B);
    online = true;
    await sync.uploadDeviceLog();
    await sync.record([cooked('2026-11-10', 'japan/osaka/onigiri')]);
    expect(sync.guestOffer()).toBe(false);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).not.toContain(mine.id);
    expect(currentProgress(store.get()).cookedOn['india/kerala/parippu']).toBeUndefined();
    expect(part(store, A).pendingUpload).toEqual([mine.id]); // still A's, still waiting
    // A comes back: A's events go up as A.
    signOutOf(store);
    signIn(store, A);
    await sync.uploadDeviceLog();
    expect(posts.at(-1)).toEqual({ events: [mine], upload: true });
    expect(part(store, A).pendingUpload).toEqual([]);
  });

  test('C1: an account switch while a post waits never sends it under the new account', async () => {
    const { store, posts, sync, time } = setup({ gapMs: 5_000 });
    signIn(store, A);
    await sync.record([cooked('2026-11-01')]); // first post, at once
    const second = cooked('2026-11-02');
    void sync.record([second]); // waits for the gap
    signOutOf(store);
    signIn(store, B);
    await time.advance(6_000);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).not.toContain(second.id);
    expect(part(store, A).pendingUpload).toEqual([second.id]);
  });

  test('sync: signed in, a live record is posted (not as an upload), returns the server\'s grants and caches the view with the partition', async () => {
    const level: RewardGrant = { id: 'x#0', eventId: '', isoDay: '2026-11-09', kind: 'level', level: 2 };
    const view: ProgressView = { ...VIEW, xp: 500, level: 4 };
    const { store, posts, sync } = setup({ answer: (p) => ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [{ ...level, eventId: e.id }] })), view }) });
    signIn(store);
    const e = cooked('2026-11-09');
    const grants = await sync.record([e]);
    expect(posts).toEqual([{ events: [e], upload: undefined }]);
    expect(grants).toEqual([{ ...level, eventId: e.id }]);
    expect(store.get().accountProgress[accountKey(A)].view).toEqual(view);
    expect(part(store, A).pendingUpload).toEqual([]);
    expect(part(store, A).events.map((x) => x.id)).toEqual([e.id]); // the device keeps the account's own copy
    expect(currentProgress(store.get()).level).toBe(4);
    signOutOf(store);
    expect(currentProgress(store.get()).level).toBe(1); // the cached view is hidden with its partition
  });

  test('sync: signed out, the 201st event of one day gets no grants, as on the server (C14)', async () => {
    const { store, sync } = setup();
    const filler = Array.from({ length: MAX_PROGRESS_EVENTS_PER_DAY }, () => lesson('2026-11-09'));
    await sync.record(filler);
    expect(store.get().progress.events).toHaveLength(MAX_PROGRESS_EVENTS_PER_DAY);
    const over = cooked('2026-11-09');
    expect(await sync.record([over])).toEqual([]);
    expect(store.get().progress.events.map((e) => e.id)).not.toContain(over.id);
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
    expect(part(store, A).pendingUpload).toEqual([e.id]);
    limited = false;
    await sync.uploadDeviceLog();
    await sync.record([cooked('2026-11-09', 'japan/osaka/onigiri')]);
    expect(posts).toHaveLength(1); // nothing sent inside the wait
    await time.advance(29_000);
    expect(posts).toHaveLength(1);
    await time.advance(2_000);
    expect(posts.length).toBe(2);
    expect(posts[1].upload).toBe(true);
    expect(part(store, A).pendingUpload).toEqual([]);
  });

  test('sync: a live batch queued before a 429 lands waits out retryAfterSeconds too (the post chain checks the block)', async () => {
    let release: (() => void) | null = null;
    const store = createStore(null);
    const posts: ProgressEvent[][] = [];
    const time = fakeTime();
    const client = {
      postProgressEvents: async (events: ProgressEvent[]) => {
        posts.push(events);
        if (posts.length === 1) {
          await new Promise<void>((r) => { release = r; });
          return { ok: false, status: 429, error: { code: 'rate_limited', message: '', details: { retryAfterSeconds: 30 } } };
        }
        return ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })) });
      },
    } as unknown as ApiClient;
    const sync = createProgressSync({ store, client, online: () => true, gapMs: 0, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer });
    signIn(store);
    void sync.record([cooked('2026-11-01')]);
    await new Promise((r) => setTimeout(r, 0));
    void sync.record([cooked('2026-11-02')]); // buffered behind the first
    release!();
    await new Promise((r) => setTimeout(r, 0));
    await time.advance(1_000);
    expect(posts).toHaveLength(1);
    await time.advance(30_000);
    expect(posts.length).toBeGreaterThanOrEqual(2);
  });

  test('sync: by default requests are paced PROGRESS_REQUEST_GAP_MS apart, under 60 a minute', async () => {
    expect(60_000 / PROGRESS_REQUEST_GAP_MS).toBeLessThan(60);
    let online = false;
    const { store, posts, sync, time } = setup({ gapMs: undefined, online: () => online });
    signIn(store);
    await sync.record(Array.from({ length: 150 }, (_, i) => lesson(`2026-10-${String((i % 28) + 1).padStart(2, '0')}`)));
    online = true;
    const up = sync.uploadDeviceLog();
    await new Promise((r) => setTimeout(r, 0));
    expect(posts).toHaveLength(1);
    await time.advance(PROGRESS_REQUEST_GAP_MS - 100);
    expect(posts).toHaveLength(1);
    await time.advance(200);
    await up;
    expect(posts).toHaveLength(2);
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

  test('sync: the stored event is core\'s result.event (a claim that doesn\'t hold is dropped and reported); with the player\'s rules a true claim is kept', async () => {
    const fx = standInFixture();
    const { store, sync, warnings } = setup({ catalogue: fx.cat, context: () => fx.ctx });
    const good: ProgressEvent = { id: newEventId(), kind: 'cooked', at: fx.today, recipe: fx.standIn, planned: false, standsInFor: ['leela'] };
    const bad: ProgressEvent = { id: newEventId(), kind: 'cooked', at: fx.today, recipe: fx.standIn, planned: false, standsInFor: ['haruka'] };
    await sync.record([good, bad]);
    const held = store.get().progress.events;
    expect(held.find((e) => e.id === good.id)).toHaveProperty('standsInFor', ['leela']);
    expect(held.find((e) => e.id === bad.id)).not.toHaveProperty('standsInFor');
    expect(warnings).toEqual(['stand_in_dropped']);
  });

  test('Family Table mode keeps nothing: no event stored, none posted', async () => {
    const { store, posts, sync } = setup();
    store.update((s) => ({ ...s, settings: { ...s.settings, familyTable: true } }));
    signIn(store);
    expect(await sync.record([cooked('2026-11-09')])).toEqual([]);
    expect(part(store, A).events).toEqual([]);
    expect(posts).toEqual([]);
  });
});

describe('M5 Step 11 fix I2: a signed-in meal_logged waits in its own account until the server answers', () => {
  const meal = (mealLogId: string, extra: Record<string, unknown> = {}): ProgressEvent =>
    ({ id: newEventId(), kind: 'meal_logged', at: '2026-11-10', minute: 600, mealLogId, ...extra });
  const meals = (store: PlayerStore, email: string | null) => part(store, email).events.filter((e) => e.kind === 'meal_logged');
  const posted = (posts: Post[]) => posts.flatMap((p) => p.events).filter((e) => e.kind === 'meal_logged');

  test('offline, then back online: it posts once, with the same mealLogId; then it leaves the device', async () => {
    let online = false;
    const { store, posts, sync } = setup({ online: () => online });
    signIn(store);
    await sync.record([meal('m1', { note: 'never kept' })]);
    expect(posts).toEqual([]);
    expect(meals(store, A)).toEqual([{ id: expect.any(String), kind: 'meal_logged', at: '2026-11-10', minute: 600, mealLogId: 'm1' }]);
    expect(meals(store, null)).toEqual([]);
    online = true;
    await sync.uploadDeviceLog();
    await sync.uploadDeviceLog();
    expect(posted(posts).map((e) => (e as { mealLogId?: string }).mealLogId)).toEqual(['m1']);
    expect(meals(store, A)).toEqual([]);
  });
  test('a server failure keeps it; unknown_meal_log drops it', async () => {
    let fail = true;
    const { store, sync } = setup({ answer: (p) => (fail ? { ok: false, status: 500, error: { code: 'x', message: '' } } : ok({ rejected: p.events.map((e) => ({ clientId: e.id, problems: ['unknown_meal_log'] })) })) });
    signIn(store);
    await sync.record([meal('m1')]);
    expect(meals(store, A)).toHaveLength(1);
    fail = false;
    await sync.uploadDeviceLog();
    expect(meals(store, A)).toEqual([]);
  });
  test('undo while pending: nothing is posted', async () => {
    let online = false;
    const { store, posts, sync } = setup({ online: () => online });
    signIn(store);
    await sync.record([meal('m1')]);
    sync.forgetMeal('m1');
    expect(meals(store, A)).toEqual([]);
    online = true;
    await sync.uploadDeviceLog();
    expect(posted(posts)).toEqual([]);
  });
  test('undo while its post waits in line: the meal is never posted', async () => {
    const { store, posts, sync, time } = setup({ gapMs: 5_000 });
    signIn(store);
    await sync.record([lesson('2026-11-10')]); // sets the pacing clock: the next post waits
    void sync.record([meal('m2')]);
    await new Promise((r) => setTimeout(r, 0));
    sync.forgetMeal('m2');
    await time.advance(10_000);
    expect(posted(posts)).toEqual([]);
  });
  test('an account switch while pending: nothing is posted under the new account; it stays with its own', async () => {
    let online = false;
    const { store, posts, sync } = setup({ online: () => online });
    signIn(store, A);
    await sync.record([meal('m1')]);
    signOutOf(store);
    signIn(store, B);
    online = true;
    await sync.uploadDeviceLog();
    expect(posted(posts)).toEqual([]);
    expect(meals(store, B)).toEqual([]);
    expect(meals(store, A)).toHaveLength(1);
  });
  test('signed out: a meal_logged is never kept in the guest partition', async () => {
    const { store, sync } = setup();
    await sync.record([meal('m1')]);
    expect(meals(store, null)).toEqual([]);
  });
});

// M6 Step 9 fix round 1 (I1, M8): the review's scratch repro. A Protein Counter round reveals a meat-excluding rule
// (Ruling 17), so the guest → account move holds it back until the account has health_data consent, and opens the
// consent card. An event the server refuses is never filed under the account: it stays in the guest partition (not
// offered again), and its grants are never shown with the account.
describe('the guest → account move and health-revealing stall rounds (fix round 1, I1)', async () => {
  const { loadMarket } = await import('../market/content');
  const { catalogueOf, rulesContextOf, withMarket } = await import('./catalogue');
  const market = await loadMarket();
  withMarket(market);
  const TODAY = '2026-11-12';
  const VEG = { id: 'r-veg', target: { kind: 'category' as const, ids: ['meat', 'fish', 'shellfish', 'gelatin'] }, type: 'avoid' as const, severity: 'preference' as const };
  const pcq = market.stalls.bram.variants!.protein_counter!.questions[0];
  const pcRound = (): ProgressEvent => ({ id: newEventId(), kind: 'stall_round', at: TODAY, stall: 'bram', answers: [{ q: pcq.id, pick: pcq.options.findIndex((o) => o.correct) }] });

  function guestWithRound(answer: (p: Post) => ApiResult<ProgressPostResponse>, consent: { granted: boolean }) {
    const store = createStore(null);
    store.update((s) => ({ ...s, localRules: [VEG] }));
    const posts: Post[] = [];
    const held: (() => void)[] = [];
    const client = { postProgressEvents: (events: ProgressEvent[], upload?: true) => { const p = { events, upload }; posts.push(p); return Promise.resolve(answer(p)); } } as unknown as ApiClient;
    const sync = createProgressSync({
      store, client, online: () => true, gapMs: 0, catalogue: catalogueOf(), context: () => rulesContextOf([VEG], [], TODAY),
      healthConsent: () => Promise.resolve(consent.granted), onHeldForConsent: (retry) => { held.push(retry); },
    });
    return { store, posts, held, sync };
  }
  const refuseStallRounds = (p: Post) => ok({
    accepted: p.events.filter((e) => e.kind !== 'stall_round').map((e) => ({ clientId: e.id, grants: [] })),
    rejected: p.events.filter((e) => e.kind === 'stall_round').map((e) => ({ clientId: e.id, problems: ['consent_required'] })),
  });

  test('no health_data: the round is held in the guest partition (its grants unshown with the account), the consent card is asked for, the rest moves', async () => {
    const consent = { granted: false };
    const { store, posts, held, sync } = guestWithRound(refuseStallRounds, consent);
    const round = pcRound();
    const local = await sync.record([round, lesson(TODAY)]);
    expect(local.some((g) => g.kind === 'xp' && g.reason === 'market_game')).toBe(true);
    signIn(store);
    expect(await sync.addGuestProgress()).toBe(true);
    expect(posts.flatMap((p) => p.events.map((e) => e.kind))).toEqual(['lesson']);
    expect(held).toHaveLength(1);
    expect(part(store, A).events.map((e) => e.kind)).toEqual(['lesson']);
    expect(part(store, A).grants.some((g) => g.eventId === round.id)).toBe(false);
    expect(part(store, null).events.map((e) => e.id)).toEqual([round.id]);
    expect(part(store, null).pendingUpload).toEqual([round.id]); // still offered: it waits for consent
    expect(currentProgress(store.get()).xp).toBe(part(store, A).grants.filter((g) => g.kind === 'xp').reduce((n, g) => n + (g.kind === 'xp' ? g.amount : 0), 0));
  });

  test('a refused round is never filed under the account: it stays with the guest, is not offered again, and shows no grant with the account', async () => {
    const consent = { granted: true };
    const { store, posts, held, sync } = guestWithRound(refuseStallRounds, consent);
    const round = pcRound();
    await sync.record([round]);
    signIn(store);
    await sync.addGuestProgress();
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).toEqual([round.id]);
    expect(held).toEqual([]);
    expect(part(store, A).events).toEqual([]);
    expect(part(store, A).grants).toEqual([]);
    expect(currentProgress(store.get()).xp).toBe(0);
    expect(part(store, null).events.map((e) => e.id)).toEqual([round.id]);
    expect(part(store, null).pendingUpload).toEqual([]);
    expect(sync.guestOffer()).toBe(false);
  });

  test('with consent and an accepting server, the held round moves on the retry', async () => {
    const consent = { granted: false };
    const { store, posts, held, sync } = guestWithRound((p) => ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [] })) }), consent);
    const round = pcRound();
    await sync.record([round]);
    signIn(store);
    await sync.addGuestProgress();
    expect(posts).toEqual([]);
    expect(held).toHaveLength(1);
    consent.granted = true;
    held[0]();
    await expect.poll(() => part(store, A).events.map((e) => e.id)).toEqual([round.id]);
    expect(part(store, null).events).toEqual([]);
  });

  test('M8: a live round the server refuses leaves the account partition, with its device grants', async () => {
    const consent = { granted: true };
    const { store, sync } = guestWithRound(refuseStallRounds, consent);
    signIn(store);
    const round = pcRound();
    expect(await sync.record([round])).toEqual([]);
    expect(part(store, A).events).toEqual([]);
    expect(part(store, A).grants).toEqual([]);
  });

  // M6 final M1: device B never knew that device A answered this question right first. B's own judgment gives 5 XP;
  // the server refuses it (not first-correct for the account). B neither keeps nor announces that XP.
  test('final M1: two devices: the server\'s grants replace the device\'s for a stall round; offline, its XP is not announced', async () => {
    const stampOnly = (p: Post) => ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [{ id: `${e.id}#s`, eventId: e.id, isoDay: e.at, kind: 'stamp' as const, stamp: 'market_game' as const }] })) });
    const { store, sync } = guestWithRound(stampOnly, { granted: true });
    signIn(store);
    const round = pcRound();
    const said = await sync.record([round]);
    expect(said.filter((g) => g.kind === 'xp')).toEqual([]);
    expect(part(store, A).grants).toEqual([{ id: `${round.id}#s`, eventId: round.id, isoDay: TODAY, kind: 'stamp', stamp: 'market_game' }]);
    expect(currentProgress(store.get()).xp).toBe(0);

    // Offline (or the server late): the device's stall XP is kept for now but not said; the stamp line still is.
    const off = createStore(null);
    off.update((s) => ({ ...s, localRules: [VEG], account: { email: A } }));
    const offline = createProgressSync({ store: off, client: {} as ApiClient, online: () => false, gapMs: 0, catalogue: catalogueOf(), context: () => rulesContextOf([VEG], [], TODAY) });
    const r2 = pcRound();
    const lines = await offline.record([r2]);
    expect(lines.some((g) => g.kind === 'xp')).toBe(false);
    expect(lines.some((g) => g.kind === 'stamp')).toBe(true);
    expect(partitionOf(off.get(), accountKey(A)).grants.some((g) => g.kind === 'xp' && g.eventId === r2.id)).toBe(true);
    // Signed out, the device is the record: its XP is said.
    const guest = createStore(null);
    guest.update((s) => ({ ...s, localRules: [VEG] }));
    const g = createProgressSync({ store: guest, client: {} as ApiClient, online: () => false, gapMs: 0, catalogue: catalogueOf(), context: () => rulesContextOf([VEG], [], TODAY) });
    expect((await g.record([pcRound()])).some((x) => x.kind === 'xp')).toBe(true);
  });
});

describe('M7 Step 7 (M6 fix review N1): another device\'s health_data delete reaches this one on its next sync', () => {
  const E1 = '11111111-1111-4111-8111-111111111111';
  const round = (id: string): ProgressEvent => ({ id, kind: 'stall_round', at: '2026-11-09', stall: 'bram', answers: [{ q: 'bram-pc-most-protein', pick: 2 }] });

  test('GET /progress with a new healthErasure erases the live partition\'s stall rounds; the same id again keeps rounds recorded since', async () => {
    const store = createStore(null);
    signIn(store);
    const key = accountKey(A);
    let erasure: string | null = null;
    const client = {
      getProgress: () => Promise.resolve({ ok: true, status: 200, data: { view: VIEW, healthErasure: erasure } }),
      postProgressEvents: (events: ProgressEvent[]) => Promise.resolve(ok({ accepted: events.map((e) => ({ clientId: e.id, grants: [] })), healthErasure: erasure })),
    } as unknown as ApiClient;
    const sync = createProgressSync({ store, client, online: () => true, gapMs: 0 });
    store.update((s) => ({ ...s, accountProgress: { ...s.accountProgress, [key]: { progress: { events: [round('r1'), lesson('2026-11-09')], grants: [], base: null, pendingUpload: [] }, view: null } } }));
    // No erasure yet: nothing changes.
    await sync.refreshAccountView();
    expect(part(store, A).events.map((e) => e.kind)).toEqual(['stall_round', 'lesson']);
    // The phone withdrew with delete: the laptop's next sync drops its copy.
    erasure = E1;
    await sync.refreshAccountView();
    expect(part(store, A).events.map((e) => e.kind)).toEqual(['lesson']);
    expect(JSON.stringify(store.get().accountProgress)).not.toContain('bram-pc');
    // A round recorded since (synced): the same id on the next sync, and the round stays.
    store.update((s) => ({ ...s, accountProgress: { ...s.accountProgress, [key]: { ...s.accountProgress[key], progress: { ...s.accountProgress[key].progress, events: [...s.accountProgress[key].progress.events, round('r2')] } } } }));
    await sync.refreshAccountView();
    expect(part(store, A).events.map((e) => e.kind)).toEqual(['lesson', 'stall_round']);
    sync.stop();
  });

  test('a post\'s answer carries the signal too, and it never reaches another account\'s partition', async () => {
    const store = createStore(null);
    signIn(store, B);
    const keyB = accountKey(B);
    store.update((s) => ({ ...s, accountProgress: { ...s.accountProgress, [keyB]: { progress: { events: [round('rb')], grants: [], base: null, pendingUpload: [] }, view: null } } }));
    signOutOf(store);
    signIn(store);
    const { sync } = setup({ store, answer: (p) => ok({ accepted: p.events.map((e) => ({ clientId: e.id, grants: [] })), healthErasure: E1 }) });
    store.update((s) => ({ ...s, accountProgress: { ...s.accountProgress, [accountKey(A)]: { progress: { events: [round('ra')], grants: [], base: null, pendingUpload: ['ra'] }, view: null } } }));
    await sync.uploadDeviceLog();
    expect(part(store, A).events).toEqual([]);
    expect(store.get().accountProgress[accountKey(A)].erasure).toBe(E1);
    expect(part(store, B).events.map((e) => e.id)).toEqual(['rb']);
    sync.stop();
  });
});
