// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import type { ProgressEvent, ProgressView } from '@kitchenquest/core/engine';
import { signOut } from '../api/account';
import type { ApiClient } from '../api/client';
import { accountKey, createStore, STORE_KEY } from '../state/store';
import { initProgress, progressService } from './index';
import { newEventId } from './log';

const EMAIL = 'cook@example.test';
const SERVER_VIEW: ProgressView = { xp: 640, level: 4, stamps: 3, trust: { leela: 2 }, toolkit: { techniques: {} }, questsDone: ['leela-tempering'], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {} };
const cooked = (at: string): ProgressEvent => ({ id: newEventId(), kind: 'cooked', at, recipe: 'india/kerala/parippu', planned: false });
const settle = async (until: () => boolean) => { for (let i = 0; i < 200 && !until(); i++) await new Promise((r) => setTimeout(r, 5)); };

function memStorage(): Storage & { dump(): Record<string, string> } {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, removeItem: (k) => { m.delete(k); }, setItem: (k, v) => { m.set(k, v); },
    dump: () => Object.fromEntries(m),
  };
}

/** Every object key in a JSON value, at any depth. */
const allKeys = (v: unknown): string[] =>
  typeof v === 'object' && v !== null ? Object.entries(v).flatMap(([k, x]) => [...(Array.isArray(v) ? [] : [k]), ...allKeys(x)]) : [];

describe('account partitions on the device (sign-out ruling)', () => {
  test('N1: at start-up, every partition but the live one keeps only its unsynced events (no view)', async () => {
    vi.resetModules();
    const { initProgress: init } = await import('./index');
    const { accountKey: key, createStore: make, withPartition: put } = await import('../state/store');
    const store = make(null);
    const e = (id: string): ProgressEvent => ({ id, kind: 'lesson', at: '2026-11-09', recipe: 'india/kerala/parippu' });
    const k = key('gone@example.test');
    store.update((s) => put(s, k, { events: [e('synced'), e('waiting')], grants: [], base: null, pendingUpload: ['waiting'] }, SERVER_VIEW));
    const live = key(EMAIL);
    store.update((s) => put({ ...s, account: { email: EMAIL } }, live, { events: [e('mine')], grants: [], base: null, pendingUpload: [] }, SERVER_VIEW));
    init({} as ApiClient, store, { document, navigator: { onLine: false }, addEventListener: () => undefined } as unknown as Window);
    expect(store.get().accountProgress[k].progress.events.map((x) => x.id)).toEqual(['waiting']);
    expect(store.get().accountProgress[k].view).toBeNull();
    expect(store.get().accountProgress[live].progress.events.map((x) => x.id)).toEqual(['mine']); // the live one is untouched
  });

  test('synced → pruned on sign-out; offline sign-out keeps only the unsynced; the same account back → view from the server, kept events uploaded; no email in any key', async () => {
    const storage = memStorage();
    const store = createStore(storage);
    let online = true;
    const posts: { events: ProgressEvent[]; upload?: true }[] = [];
    const client = {
      postProgressEvents: (events: ProgressEvent[], upload?: true) => {
        posts.push({ events, upload });
        return Promise.resolve({ ok: true, status: 200, data: { accepted: events.map((e) => ({ clientId: e.id, grants: [] })), duplicate: [], rejected: [], warnings: [], view: SERVER_VIEW } });
      },
      getProgress: () => Promise.resolve({ ok: true, status: 200, data: { view: SERVER_VIEW } }),
      logout: () => Promise.resolve({ ok: true, status: 204, data: null }),
    } as unknown as ApiClient;
    const win = { document, navigator: { get onLine() { return online; } }, addEventListener: () => undefined } as unknown as Window;
    initProgress(client, store, win);
    const key = accountKey(EMAIL);
    const stored = () => JSON.parse(storage.getItem(STORE_KEY)!) as { accountProgress: Record<string, { progress: { events: ProgressEvent[]; grants: unknown[] }; view: unknown }> };

    // Signed in and online: the cook goes up, and the server's view is cached with the partition.
    store.update((s) => ({ ...s, account: { email: EMAIL } }));
    const svc = await progressService();
    await settle(() => store.get().accountProgress[key]?.view !== undefined && store.get().accountProgress[key]?.view !== null);
    const synced = cooked('2026-11-09');
    await svc.record([synced]);
    expect(posts.flatMap((p) => p.events.map((e) => e.id))).toEqual([synced.id]);
    expect(stored().accountProgress[key].progress.events.map((e) => e.id)).toEqual([synced.id]);

    // Sign-out with everything synced: localStorage holds no events and no view for that account.
    store.update((s) => ({ ...s, cookProgress: { slug: 'india/kerala/parippu', step: 3 }, dialogueHistory: { 'quest.cook_adapted': [1] } }));
    await signOut(client, store);
    // N4: the cook-mode resume point and the session's line history go with it.
    expect(store.get().cookProgress).toBeNull();
    expect(store.get().dialogueHistory).toEqual({});
    expect(stored().accountProgress[key].progress.events).toEqual([]);
    expect(stored().accountProgress[key].progress.grants).toEqual([]);
    expect(stored().accountProgress[key].view).toBeNull();

    // Back in, offline: a cook waits; an offline sign-out keeps only that unsynced event.
    store.update((s) => ({ ...s, account: { email: EMAIL } }));
    await settle(() => false);
    online = false;
    const waiting = cooked('2026-11-10');
    await svc.record([waiting]);
    await signOut(client, store);
    expect(stored().accountProgress[key].progress.events.map((e) => e.id)).toEqual([waiting.id]);
    expect(stored().accountProgress[key].view).toBeNull();

    // The same account signs back in, online: the kept event goes up, and the view is rebuilt from the server.
    online = true;
    posts.length = 0;
    store.update((s) => ({ ...s, account: { email: EMAIL } }));
    await settle(() => store.get().accountProgress[key]?.view !== undefined && store.get().accountProgress[key]?.view !== null && posts.length > 0);
    expect(posts).toEqual([{ events: [waiting], upload: true }]);
    expect(store.get().accountProgress[key].view).toEqual(SERVER_VIEW);
    expect(svc.view().level).toBe(4);

    // No raw email in any storage key: neither localStorage's keys nor any key inside what is stored.
    const dump = storage.dump();
    for (const [k, v] of Object.entries(dump)) {
      expect(k).not.toContain('@');
      for (const inner of allKeys(JSON.parse(v))) expect(inner, inner).not.toContain('@');
    }
    expect(Object.keys(stored().accountProgress)).toEqual([key]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
