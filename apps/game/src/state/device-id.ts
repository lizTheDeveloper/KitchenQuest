// M7 Step 9 fix round 2 (Ruling 17, per device): this install's random id, sent only with the Family Table report so
// the server can tell this device's report from another's. An opaque UUID in device storage (`kq.device.v1`): no
// personal data, never shown, never sent anywhere else. "Delete everything on this device" removes it with the rest.
import { safeLocalStorage } from './store';

export const DEVICE_KEY = 'kq.device.v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Without storage (private mode, blocked site data) the id lasts this page's life. */
let memo: string | null = null;

export function deviceId(storage: Storage | null = safeLocalStorage()): string {
  try {
    const v = storage?.getItem(DEVICE_KEY) ?? null;
    if (v !== null && UUID.test(v)) return v;
  } catch { /* storage unavailable */ }
  const id = storage === null ? (memo ??= crypto.randomUUID()) : crypto.randomUUID();
  try { storage?.setItem(DEVICE_KEY, id); } catch { memo ??= id; return memo; }
  return id;
}
