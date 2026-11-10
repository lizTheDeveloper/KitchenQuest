import { expect, test, vi } from 'vitest';
import { deleteOfflineCopy } from './register';

test('deleteOfflineCopy deletes only kq- caches and unregisters every worker', async () => {
  const keys = ['kq-shell-a', 'kq-shell-b', 'someone-else'];
  const deleted: string[] = [];
  let unregistered = 0;
  const reg = { unregister: () => { unregistered++; return Promise.resolve(true); } };
  const nav = { serviceWorker: { getRegistrations: () => Promise.resolve([reg, reg]) } } as unknown as Navigator;
  const cs = { keys: () => Promise.resolve(keys), delete: (k: string) => { deleted.push(k); return Promise.resolve(true); } } as unknown as CacheStorage;
  await deleteOfflineCopy(nav, cs);
  expect(deleted).toEqual(['kq-shell-a', 'kq-shell-b']);
  expect(unregistered).toBe(2);
});

test('deleteOfflineCopy copes with no service worker or cache support', async () => {
  await expect(deleteOfflineCopy({} as Navigator, undefined)).resolves.toBeUndefined();
});

test('deleteOfflineCopy still deletes caches when unregistering fails', async () => {
  const deleted: string[] = [];
  const nav = { serviceWorker: { getRegistrations: () => Promise.reject(new Error('nope')) } } as unknown as Navigator;
  const cs = { keys: () => Promise.resolve(['kq-shell-a']), delete: (k: string) => { deleted.push(k); return Promise.resolve(true); } } as unknown as CacheStorage;
  await deleteOfflineCopy(nav, cs);
  expect(deleted).toEqual(['kq-shell-a']);
});

test('deleteOfflineCopy gives up after its timeout, so the caller always gets to reload', async () => {
  vi.useFakeTimers();
  try {
    const never = new Promise<never>(() => {});
    const nav = { serviceWorker: { getRegistrations: () => never } } as unknown as Navigator;
    const cs = { keys: () => never } as unknown as CacheStorage;
    let done = false;
    void deleteOfflineCopy(nav, cs).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test('a delete marks the tab so its next load skips the worker, once', async () => {
  const { SKIP_SW_KEY, skipServiceWorkerOnce, takeServiceWorkerSkip } = await import('./register');
  const m = new Map<string, string>();
  const session = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } } as unknown as Storage;
  expect(takeServiceWorkerSkip(session)).toBe(false);
  skipServiceWorkerOnce(session);
  expect(m.get(SKIP_SW_KEY)).toBe('1');
  expect(takeServiceWorkerSkip(session)).toBe(true);
  expect(takeServiceWorkerSkip(session)).toBe(false);
  const broken = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } } as unknown as Storage;
  expect(() => skipServiceWorkerOnce(broken)).not.toThrow();
  expect(takeServiceWorkerSkip(broken)).toBe(false);
  expect(takeServiceWorkerSkip(null)).toBe(false);
});

test('deleteOfflineCopy unregisters the worker before it clears the caches, so the worker cannot refill them', async () => {
  const order: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const reg = { unregister: async () => { order.push('unregister:start'); await held; order.push('unregister:end'); return true; } };
  const nav = { serviceWorker: { getRegistrations: () => Promise.resolve([reg]) } } as unknown as Navigator;
  const cs = { keys: () => { order.push('keys'); return Promise.resolve(['kq-shell-a']); }, delete: () => { order.push('delete'); return Promise.resolve(true); } } as unknown as CacheStorage;
  const done = deleteOfflineCopy(nav, cs);
  await new Promise((r) => setTimeout(r, 0));
  expect(order).toEqual(['unregister:start']);
  release();
  await done;
  expect(order).toEqual(['unregister:start', 'unregister:end', 'keys', 'delete']);
});
