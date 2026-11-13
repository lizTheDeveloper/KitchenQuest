import { describe, expect, test } from 'vitest';
import { deleteDeviceData } from './store';
import { DEVICE_KEY, deviceId } from './device-id';

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, clear: () => { m.clear(); },
  };
}

describe('M7 Step 9 fix round 2: the per-install device id', () => {
  test('a random UUID, kept in device storage: the same across reloads, different per install; "Delete everything" removes it', () => {
    const a = mem();
    const first = deviceId(a);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a.getItem(DEVICE_KEY)).toBe(first);
    expect(deviceId(a)).toBe(first); // a reload reads it back
    expect(deviceId(mem())).not.toBe(first); // another install
    a.setItem(DEVICE_KEY, 'cook@example.com'); // anything else is replaced, never sent
    expect(deviceId(a)).not.toBe('cook@example.com');
    expect(deleteDeviceData(a)).toContain(DEVICE_KEY);
    expect(a.getItem(DEVICE_KEY)).toBeNull();
    // No storage: stable for this page's life.
    expect(deviceId(null)).toBe(deviceId(null));
  });
});
