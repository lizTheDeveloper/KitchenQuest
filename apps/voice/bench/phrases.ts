// M7 Step 3: the benchmark's utterances. The spike's ten cooking phrases (docs/spikes/2026-11-09-voice-latency.md,
// its stt_bench.py) and its hard terms, plus ten short openers, the kind of turn a cook starts with.

export const SPIKE_PHRASES: readonly string[] = [
  'I had leftover pad thai',
  "I'm allergic to kiwi, K-I-W-I",
  'set a timer for twelve minutes',
  'add gochujang to the shopping list',
  'do we have any epazote left',
  'swap soy sauce for tamari',
  'how long do I simmer the dal',
  "I'm out of shallots and fish sauce",
  'what temperature for the sourdough',
  'log two eggs and a slice of halloumi',
];

export const OPENERS: readonly string[] = [
  'hey Pan',
  'what should I cook tonight',
  'next step',
  'read that again',
  'I made the soup',
  'what can I make with eggs',
  'is this one spicy',
  'how long is left',
  'thanks',
  'what goes with rice',
];

/** The hard words the spike scored ("terms"), and the vocabulary hint a pantry-aware app would send for them. */
export const TERMS: readonly string[] = ['gochujang', 'epazote', 'tamari', 'kiwi', 'halloumi', 'shallots'];
export const HINT: readonly string[] = ['gochujang', 'epazote', 'tamari', 'kiwi', 'halloumi', 'shallots', 'dal'];

export const NOISE_LEVELS = ['clean', '15dB', '5dB'] as const;
export type NoiseLevel = (typeof NOISE_LEVELS)[number];
