import { describe, expect, test } from 'vitest';
import { noteMentions, pluralForms as fromBook, type MarginNote } from '../book/margin-notes';
import { graph } from '../week/fixtures';
import { lineOf, pluralForms, textMentions, words } from './mentions';

const DAY = '2026-11-11';

describe('textMentions (moved from noteMentions, M6 Step 1)', () => {
  test('textMentions finds names, aliases and plurals; noteMentions results are unchanged on the M5 fixtures', () => {
    expect(textMentions(['a handful of berries'], graph)).toEqual(['berry']);
    expect(textMentions(['two green chillies, three bay leaves'], graph)).toEqual(['bay_leaf', 'green_chili']);
    expect(textMentions(['a splash of shoyu'], graph)).toEqual(['soy_sauce']); // an alias
    expect(textMentions(['Peanuts!', 'and some TOMATOES'], graph)).toEqual(['peanut', 'tomato']);
    expect(textMentions(['crumbs from two loaves', 'blunt knives'], graph)).toEqual(['loaf', 'test_knife']);
    // Word-bounded: "pineapple" is not "pine nut", "salted" is not "salt", "rice" inside "price" is nothing.
    expect(textMentions(['a pineapple, salted', 'the price'], graph)).toEqual([]);
    expect(textMentions([], graph)).toEqual([]);
    // Sorted, each once.
    expect(textMentions(['onion', 'onions', 'an onion and garlic'], graph)).toEqual(['garlic', 'onion']);

    // noteMentions is textMentions over each note's text and op names: the M5 cases, unchanged.
    const notes: MarginNote[] = [
      { recipe: 'x', ops: [{ op: 'swap', from: 'lentils', to: 'chickpeas' }, { op: 'remove', name: 'onion' }], text: 'topped with berries and salted peanuts', at: DAY },
      { recipe: 'x', ops: [{ op: 'add', name: 'two green chillies' }], text: null, at: DAY },
    ];
    expect(noteMentions(notes, graph)).toEqual(['berry', 'chickpea', 'green_chili', 'lentil', 'onion', 'peanut']);
    expect(noteMentions(notes, graph)).toEqual(textMentions(['topped with berries and salted peanuts', 'lentils', 'chickpeas', 'onion', 'two green chillies'], graph));
    expect(noteMentions([], graph)).toEqual([]);
  });

  test('the helpers moved with it: words, pluralForms (still re-exported from book/) and lineOf', () => {
    expect(words('  Green-Chilli,  & salt ')).toBe(' green chilli salt ');
    expect(fromBook).toBe(pluralForms);
    expect(pluralForms('berry')).toEqual(['berry', 'berrys', 'berryes', 'berries']);
    expect(pluralForms('loaf')).toContain('loaves');
    expect(pluralForms('knife')).toContain('knives');
    expect(lineOf('lard')).toEqual({ name: 'lard', displayName: null, quantity: null, unit: null, note: null });
  });
});
