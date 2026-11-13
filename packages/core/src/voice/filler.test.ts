// M7 Step 1 (§7.6b.8): the scripted filler while a turn runs: the ledger line for a write-shaped turn, else thinking.
import { describe, expect, test } from 'vitest';
import { fillerFor } from './filler';

describe('fillerFor', () => {
  test('"I had toast for lunch" and "got the shallots" → ledger; "what is a roux" → thinking', () => {
    expect(fillerFor('I had toast for lunch')).toBe('voice.filler.ledger');
    expect(fillerFor('got the shallots')).toBe('voice.filler.ledger');
    expect(fillerFor('what is a roux')).toBe('voice.filler.thinking');
  });

  test('a pantry add or removal and a rule statement are ledger turns; a question is thinking', () => {
    expect(fillerFor('I bought eggs')).toBe('voice.filler.ledger');
    expect(fillerFor('we ran out of rice')).toBe('voice.filler.ledger');
    expect(fillerFor("I'm allergic to sesame")).toBe('voice.filler.ledger');
    expect(fillerFor('how long do I stir it')).toBe('voice.filler.thinking');
    expect(fillerFor('')).toBe('voice.filler.thinking');
  });
});
