// @vitest-environment happy-dom
// M7 Step 9 fix round 3: "Delete everything on this device" on a Family Table device first tells the server this
// install left Family Table (its own id), then signs out, so its id never holds the account's voice block afterwards.
import { describe, expect, test } from 'vitest';
import type { ApiClient } from '../api/client';
import { createStore } from '../state/store';
import { signOutBeforeDelete } from './settings-screen';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
function api(calls: string[], ok = true) {
  return {
    setFamilyTable: (on: boolean, id: string) => { calls.push(`family ${String(on)} ${id}`); return Promise.resolve(ok ? { ok: true, status: 204, data: null } : { ok: false, status: 0, error: { code: 'network', message: '' } }); },
    logout: () => { calls.push('logout'); return Promise.resolve({ ok: true, status: 204, data: null }); },
  } as unknown as ApiClient;
}
const state = (ft: boolean, signedIn = true) => {
  const s = createStore(null);
  s.update((x) => ({ ...x, account: signedIn ? { email: 'a@b.c' } : null, settings: { ...x.settings, familyTable: ft } }));
  return s.get();
};

describe('signOutBeforeDelete', () => {
  test('a Family Table device sends {on:false} with its id, then signs out', async () => {
    const calls: string[] = [];
    expect(await signOutBeforeDelete(api(calls), state(true), ID, 100)).toBe(true);
    expect(calls).toEqual([`family false ${ID}`, 'logout']);
  });

  test('not in Family Table: only the sign-out; signed out: nothing; a failed report never holds up the delete', async () => {
    const off: string[] = [];
    await signOutBeforeDelete(api(off), state(false), ID, 100);
    expect(off).toEqual(['logout']);
    const out: string[] = [];
    expect(await signOutBeforeDelete(api(out), state(true, false), ID, 100)).toBe(true);
    expect(out).toEqual([]);
    const failed: string[] = [];
    expect(await signOutBeforeDelete(api(failed, false), state(true), ID, 100)).toBe(true);
    expect(failed).toEqual([`family false ${ID}`, 'logout']);
  });
});
