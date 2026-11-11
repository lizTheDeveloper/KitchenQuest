import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { COOKED_FOR_COUNTS, COOKED_FOR_WHO, parseCookedFor, shareTally, type CookedFor, type SharedEntry } from './cooked-for';

/** The result holds nothing but the fixed enum values (Ruling 10). */
function onlyEnums(r: CookedFor | null): void {
  if (r === null) return;
  expect(Object.keys(r).sort()).toEqual(['count', 'who']);
  expect(COOKED_FOR_COUNTS).toContain(r.count);
  if (r.who !== null) expect(COOKED_FOR_WHO).toContain(r.who);
}

describe('parseCookedFor', () => {
  test.each([
    ['just me', { count: 'just_me', who: null }],
    ['Just me tonight', { count: 'just_me', who: null }],
    ['on my own', { count: 'just_me', who: null }],
    ['no one, just me', { count: 'just_me', who: null }],
    ['my flatmate Sam', { count: 'one', who: 'flatmate' }],
    ['mum, dad and my sister', { count: 'two_to_three', who: 'family' }],
    ['fed 6 of us', { count: 'four_plus', who: null }],
    ['the two of us', { count: 'one', who: null }],
    ['me and my partner', { count: 'one', who: 'partner' }],
    ['just me and my partner', { count: 'one', who: 'partner' }],
    ['my husband and the kids', { count: 'two_to_three', who: 'partner' }],
    ['the kids', { count: 'two_to_three', who: 'family' }],
    ['friends from work and my neighbour', { count: 'two_to_three', who: 'friends' }],
    ['cooked for 3 colleagues', { count: 'two_to_three', who: 'colleagues' }],
    ['Sam and Alex', { count: 'two_to_three', who: null }],
    ['dinner with Priya', { count: 'one', who: null }],
    ['a dinner party, 8 guests', { count: 'four_plus', who: 'guests' }],
    // Fix round 1, M2.
    ['my wife and 3 kids', { count: 'four_plus', who: 'partner' }],
    ['my flatmate and one friend', { count: 'two_to_three', who: 'flatmate' }],
    ['Cooked for Sam', { count: 'one', who: null }],
    ['for Priya', { count: 'one', who: null }],
  ] as const)('%s', (text, expected) => {
    expect(parseCookedFor(text)).toEqual(expected);
  });

  test('unreadable → null, so the UI offers the fixed chips', () => {
    for (const t of ['', '   ', 'it was nice', '🍲🍲', 'sam and alex', '?', 'Yes', 'Pasta', 'Delicious', 'Tonight', 'Leftovers', 'Everybody']) expect(parseCookedFor(t)).toBeNull();
  });

  test('parseCookedFor never returns a name or a health word (names, "nut allergy", emoji, 500 chars)', () => {
    const texts = [
      'my flatmate Sam',
      "my son's nut allergy",
      'Gran, who is coeliac, and Uncle Bob',
      'Sam 🥜🍤 anaphylaxis Alex',
      'my wife Maria (diabetic) and her mum Rosa',
      'x'.repeat(500),
      `${'Priya, '.repeat(80)}and me`,
      'ＭＹ　ＳＩＳＴＥＲ',
      'mу sistеr Аnna', // Cyrillic lookalikes
    ];
    for (const t of texts) {
      const r = parseCookedFor(t);
      onlyEnums(r);
      const json = JSON.stringify(r);
      for (const word of ['Sam', 'Gran', 'Bob', 'Maria', 'Rosa', 'Priya', 'Anna', 'Alex', 'nut', 'allergy', 'coeliac', 'diabetic', 'anaphylaxis', '🥜'])
        expect(json.toLowerCase()).not.toContain(word.toLowerCase());
    }
    expect(parseCookedFor("my son's nut allergy")).toEqual({ count: 'one', who: 'family' });
  });

  test('property: any text gives null or enum values only, and never throws', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (t) => {
        onlyEnums(parseCookedFor(t));
      }),
      { numRuns: 500 },
    );
    expect(parseCookedFor(undefined as never)).toBeNull();
  });
});

describe('shareTally', () => {
  const e = (count: CookedFor['count'], recipe: string | null, frame: string | null = null): SharedEntry => ({ cookedOn: '2026-11-11', recipe, frame, cookedFor: { count, who: null } });
  test('shareTally: just_me ignored; byRecipe counts per slug; frame entries add to shared only', () => {
    const tally = shareTally([
      e('just_me', 'india/kerala/parippu'),
      e('one', 'india/kerala/parippu'),
      e('four_plus', 'india/kerala/parippu'),
      e('two_to_three', 'japan/osaka/onigiri'),
      e('one', null, 'fried-rice'),
      e('just_me', null, 'green-sauce'),
      // A frame cook that also names the dish it stood in for still counts as a frame: shared only.
      e('two_to_three', 'india/kerala/parippu', 'fried-rice'),
    ]);
    expect(tally).toEqual({ shared: 5, byRecipe: { 'india/kerala/parippu': 2, 'japan/osaka/onigiri': 1 } });
    expect(Object.keys(tally).sort()).toEqual(['byRecipe', 'shared']);
  });

  test('malformed rows count for nothing; an empty list is zero', () => {
    expect(shareTally([])).toEqual({ shared: 0, byRecipe: {} });
    expect(shareTally([null, { cookedFor: { count: 'loads' } }, { recipe: 'x' }] as never)).toEqual({ shared: 0, byRecipe: {} });
  });
});
