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
