// Fix round 1 (M3, M4): the voice module's public surface is exactly the Step 1 interface, re-exported by core.
// M7 Step 5 (carry 1) adds the close codes of both protocols; Step 6 the heard card's shared line (`heardLine`).
import { expect, test } from 'vitest';
import * as engine from '../engine';
import * as core from '../index';
import * as voice from './index';

const INTERFACE = [
  // constants
  'SAMPLE_RATE_IN', 'FRAME_MS', 'MAX_UTTERANCE_MS', 'PRE_ROLL_MS', 'VAD_HANGOVER_MS', 'MIN_SPEECH_MS', 'BARGE_IN_MIN_MS', 'FILLER_AFTER_MS',
  'HANDS_FREE_IDLE_MS', 'MAX_SPEAK_ITEMS', 'MAX_SPEAK_CHARS', 'SPEAK_VAR_MAX', 'HINT_MAX_WORDS', 'MAX_ALTERNATIVES', 'RECENT_REPLIES', 'RECENT_REPLY_TTL_MS',
  // protocols
  'VOICE_PROTOCOL_VERSION', 'VOICE_CLOSE_CODES', 'voiceCloseReason', 'UPSTREAM_CLOSE', 'UPSTREAM_REFUSAL', 'upstreamClose', 'upstreamRefusal', 'encodeFrame', 'decodeFrame', 'parseClientMsg', 'parseServerMsg', 'parseTurnInput', 'parseUpstreamClientMsg', 'parseUpstreamServerMsg',
  // heard check
  'phoneticKey', 'KNOWN_CONFUSIONS', 'soundAlikes', 'heardCheck', 'applyHeardChoice', 'tryHeardChoice', 'heardConfirmed', 'isRuleTermId', 'heardLine', 'HEARD_CHECK_TRIGGER', 'HEARD_CHECK_SPELLED_TRIGGER',
  // speech, commands, filler
  'speechText', 'speechChunks', 'stepSpeech', 'cookCommand', 'fillerFor',
];

test('voice/index exports the interface and nothing else; core index.ts and engine.ts re-export all of it', () => {
  expect(Object.keys(voice).sort()).toEqual([...INTERFACE].sort());
  for (const name of INTERFACE) {
    expect(name in core, name).toBe(true);
    expect(name in engine, name).toBe(true);
  }
});
