import { describe, expect, test } from 'vitest';
import * as voice from './index';

describe('the voice library', () => {
  test('its surface is the controller, the providers, the speak plan and the earcon (Step 9 and 10 consume these)', () => {
    expect(Object.keys(voice).sort()).toEqual(
      ['CHECK_SCREEN', 'RAISED_DB', 'createVoiceController', 'devBrowserProvider', 'handsFreeBuild', 'providerKind', 'serviceProvider', 'sizzle', 'speakPlan'].sort(),
    );
  });
});
