// M7 Step 9 fix round 2 (Ruling 17, per device): this install's random id, sent only with the Family Table report so
// the server can tell this device's report from another's. An opaque UUID in device storage (`kq.device.v1`): no
// personal data, never shown, never sent anywhere else. "Delete everything on this device" removes it with the rest.
import { safeLocalStorage } from './store';

export const DEVICE_KEY = 'kq.device.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Fix round 3 (N-6): the id this page settled on, per storage (and for no storage): every call gives the same one. */
const memo = new WeakMap<object, string>();
const NO_STORAGE = {};

export function deviceId(storage: Storage | null = safeLocalStorage()): string {
  const slot = storage ?? NO_STORAGE;
  const known = memo.get(slot);
  try {
    const v = storage?.getItem(DEVICE_KEY) ?? null;
    if (v !== null && UUID.test(v)) { memo.set(slot, v); return v; }
    // Removed (delete everything): a new install's id. Anything else not a UUID: this page's id, written back.
    if (known !== undefined && !(v === null && storage !== null)) {
      try { storage?.setItem(DEVICE_KEY, known); } catch { /* kept in memory */ }
      return known;
    }
  } catch {
    // Unreadable storage: the id this page already has, or a new one kept for the page's life.
    if (known !== undefined) return known;
  }
  const id = crypto.randomUUID();
  memo.set(slot, id);
  try { storage?.setItem(DEVICE_KEY, id); } catch { /* kept in memory for this page */ }
  return id;
}
