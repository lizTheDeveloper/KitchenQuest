import { describe, expect, test } from 'vitest';
import type { PlayerSettings } from '../state/store';
import { iosNoteVisible, isIos, isStandalone } from './install';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

test('isIos', () => {
  expect(isIos(IPHONE, 5)).toBe(true);
  expect(isIos(IPAD_DESKTOP, 5)).toBe(true);
  expect(isIos(IPAD_DESKTOP, 0)).toBe(false);
  expect(isIos(ANDROID, 5)).toBe(false);
});

describe('isStandalone', () => {
  const win = (matches: boolean, standalone?: boolean) => ({ matchMedia: () => ({ matches }), navigator: { standalone } });
  test('display-mode standalone', () => expect(isStandalone(win(true))).toBe(true));
  test('iOS navigator.standalone', () => expect(isStandalone(win(false, true))).toBe(true));
  test('in the browser', () => expect(isStandalone(win(false, false))).toBe(false));
});

test('iosNoteVisible', () => {
  const base: PlayerSettings = { showCalories: false, reducedMotion: 'system', familyTable: false, iosNoteDismissed: false, rescueNudges: true, voice: { on: false, readAloud: true, handsFree: false } };
  for (const ios of [true, false]) {
    for (const standalone of [true, false]) {
      for (const dismissed of [true, false]) {
        expect(iosNoteVisible({ ...base, iosNoteDismissed: dismissed }, { ios, standalone }), `${ios} ${standalone} ${dismissed}`)
          .toBe(ios && !standalone && !dismissed);
      }
    }
  }
});
