// Fix round 1 (M3): the voice constants, pinned to the plan's Global Constraints values.
import { expect, test } from 'vitest';
import * as constants from './constants';

test('every voice constant has the value the plan sets, and there are no others', () => {
  expect({ ...constants }).toEqual({
    SAMPLE_RATE_IN: 16_000,
    FRAME_MS: 20,
    MAX_UTTERANCE_MS: 30_000,
    PRE_ROLL_MS: 300,
    VAD_HANGOVER_MS: 300,
    MIN_SPEECH_MS: 200,
    BARGE_IN_MIN_MS: 250,
    FILLER_AFTER_MS: 600,
    HANDS_FREE_IDLE_MS: 600_000,
    MAX_SPEAK_ITEMS: 8,
    MAX_SPEAK_CHARS: 600,
    SPEAK_VAR_MAX: 80,
    HINT_MAX_WORDS: 60,
    MAX_ALTERNATIVES: 3,
    RECENT_REPLIES: 8,
    RECENT_REPLY_TTL_MS: 600_000,
  });
});
