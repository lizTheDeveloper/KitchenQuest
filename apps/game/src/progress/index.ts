import { setBeforeSignOut } from '../api/account';
import type { ApiClient } from '../api/client';
import { accountKey, prunePartition, type PlayerStore } from '../state/store';
import type { ProgressService } from './service';

/**
 * The shell's handle on progress. It holds no progress code: the log, sync, view and lines load with the first
 * screen that needs them (`progressService()`), so first paint never carries them (Step 9.3).
 */
let deps: { client: ApiClient; store: PlayerStore; win: Window } | null = null;
let loading: Promise<ProgressService> | null = null;

/** Called once by main.ts. On a sign-in (and on start when signed in, and when the connection comes back) the device log is uploaded once. */
export function initProgress(client: ApiClient, store: PlayerStore, win: Window): void {
  deps = { client, store, win };
  let email = store.get().account?.email ?? null;
  const signedIn = () => { void progressService().then((s) => s.signedIn()); };
  if (email !== null) signedIn();
  store.subscribe((s) => {
    const now = s.account?.email ?? null;
    if (now === email) return;
    const was = email;
    email = now;
    // The account that left (signed out here, in another tab, or by a 401): what it synced is the server's now, so
    // only its unsynced events stay on the device, for its own next sign-in (the view is rebuilt from the server then).
    if (was !== null) store.update((st) => prunePartition(st, accountKey(was)));
    if (now !== null) signedIn();
  });
  // C1 ruling: a sign-out first posts what the account still holds (when online), then its partition is hidden.
  setBeforeSignOut(async () => { if (loading) await (await loading).sync.flush(); });
  win.addEventListener('online', () => { if (store.get().account !== null) signedIn(); });
}

/** The progress service, loaded on first use. Throws (rejects) before `initProgress`. */
export function progressService(): Promise<ProgressService> {
  if (!deps) return Promise.reject(new Error('progress is not initialised'));
  const d = deps;
  loading ??= import('./service').then((m) => m.createProgressService(d));
  return loading;
}
