// M7 Step 9 fix round 2: the per-device Family Table set (voice/family-devices.ts).
import { describe, expect, test } from 'vitest';
import { familyDevices, MAX_FAMILY_DEVICES } from '../src/voice/family-devices.js';

describe('familyDevices', () => {
  test('off is true only when it removed the last device that reported on; an unknown device is a no-op', () => {
    const u = 'user-fd-1';
    expect(familyDevices.off(u, 'never-on')).toBe(false); // never reported on: changes nothing
    expect(familyDevices.on(u, 'a')).toBe(true);
    expect(familyDevices.on(u, 'b')).toBe(true);
    expect(familyDevices.off(u, 'c')).toBe(false);
    expect(familyDevices.off(u, 'a')).toBe(false); // b is still in Family Table
    expect(familyDevices.off(u, 'b')).toBe(true);
    expect(familyDevices.off(u, 'b')).toBe(false); // already gone
    expect(familyDevices.count(u)).toBe(0);
  });

  test('bounded per user: past the cap a new device is not remembered (its on still blocks; the route sets the registry)', () => {
    const u = 'user-fd-2';
    for (let i = 0; i < MAX_FAMILY_DEVICES; i++) expect(familyDevices.on(u, `d${i}`)).toBe(true);
    expect(familyDevices.on(u, 'one-more')).toBe(false);
    expect(familyDevices.count(u)).toBe(MAX_FAMILY_DEVICES);
    expect(familyDevices.on(u, 'd0')).toBe(true); // a known one still is
  });
});
