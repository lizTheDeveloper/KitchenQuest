import { describe, expect, test } from 'vitest';
import { isWriteRequest } from './requests.js';

// Fix round 4 (R9): the player's own words ask for a record to change; with no card the turn says write.not_done.
describe('isWriteRequest', () => {
  test.each([
    // rev7d L3 and rev7c C
    'make saturday my market day', 'clear my pantry', 'forget my rules', 'set saturday as market day', 'remember saturday is shop day', 'delete my rule',
    'change my market day to saturday', 'Please SAVE my lunch', 'add milk to my pantry', 'remove eggs from the pantry', 'take milk off my list',
    'update my profile', 'wipe my rules', 'log my dinner', 'remember I eat lunch at one', 'can you note my breakfast time', 'make my lunch time 12:30',
    'erase my allergies', 'cross milk off the shopping list', 'set my region to Oaxaca', 'put rice in the cupboard',
  ])('%j is a write request', (text) => expect(isWriteRequest(text)).toBe(true));

  test.each([
    'what should I make for dinner', 'what should I cook tonight?', 'add a pinch of salt', 'clear the counter first', 'how do I set the timer',
    'tell me about frijoles de olla', 'make it spicier', 'can I get the recipe', 'is the leftover chicken from monday still good?', 'what can I make with rice',
    'I had toast for lunch', "what's in pad thai?",
  ])('%j is not a write request', (text) => expect(isWriteRequest(text)).toBe(false));
});
