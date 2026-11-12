import { describe, expect, test } from 'vitest';
import { defaultCatalog } from '../catalog.js';
import { isWriteRequest as isWrite } from './requests.js';

const { graph, ruleTerms } = defaultCatalog();
const isWriteRequest = (text: string) => isWrite(text, graph, ruleTerms);

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

// Fix round 5 (rev7e): a change verb with a rule statement is a write request too.
test.each(['note that peanuts nearly killed me, can I eat this?', 'remember I am allergic to peanuts', "save that I'm allergic to sesame"])('%j is a write request (fix round 5)', (text) =>
  expect(isWriteRequest(text)).toBe(true),
);
test.each(['peanuts nearly killed me', 'is this ok for my dinner? update me'])('%j is not (fix round 5)', (text) => expect(isWriteRequest(text)).toBe(false));

// M6 Step 8 fix round 1 (m4): a tick of the market list is a write request; a tick the animal, in a health context, never is.
describe('tick requests', () => {
  test.each(['tick the shallots', 'tick off the onion please', 'can you tick the dal', 'cross the dal off', 'check the onion off my list', 'ticked the eggs'])('%j is a write request', (t) =>
    expect(isWriteRequest(t)).toBe(true),
  );
  test.each([
    'got a tick bite, now red meat makes me ill',
    'i had a tick bite last summer',
    'tick bites gave me alpha-gal',
    'a tick bit me on holiday',
    'I was bitten by a tick and now I can\'t eat beef',
    'the tick-borne thing means no red meat',
    'found a tick on my leg',
    'ticks on the dog again',
    'deer ticks are everywhere',
  ])('%j is not a write request', (t) => expect(isWriteRequest(t)).toBe(false));
});

// M7 Step 7 (M6 final M15): the tick health contexts the M6 pattern still matched; a tick sentence that is health text
// is never a tick request either.
describe('tick health contexts (M6 final M15)', () => {
  test.each([
    'I got alpha-gal from a lone star tick',
    'got ticks hiking',
    'got ticks camping last weekend and now beef makes me ill',
    'the itch came after a tick, could it be alpha-gal?',
  ])('%j is not a write request', (t) => expect(isWriteRequest(t)).toBe(false));
  // Positive controls: a tick of the list, also beside a health sentence, still is one.
  test.each(['tick the shallots', 'tick the shallots. i am allergic to peanuts', 'ticked the eggs'])('%j is still a write request', (t) =>
    expect(isWriteRequest(t)).toBe(true),
  );
});
