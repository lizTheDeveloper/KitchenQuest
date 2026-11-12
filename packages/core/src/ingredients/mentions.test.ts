import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { checkWithNotes, noteMentions, pluralForms as fromBook, type MarginNote } from '../book/margin-notes';
import { dish, graph, PEANUT, subs } from '../week/fixtures';
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

// Fix round 1, C1: the scan reads the whole text. The 500-character cap belongs to a player's turn input only.
describe('fix round 1, C1: textMentions and noteMentions read the full text', () => {
  const filler = (n: number) => 'and then a plain word '.repeat(Math.ceil(n / 22)).slice(0, n);

  test("the reviewer's 572-character case: a peanut named in an explanation past character 500", () => {
    const explain = `${filler(530)} Peanuts are the cheapest protein of all.`;
    expect(explain.length).toBeGreaterThan(560);
    expect(textMentions([explain], graph)).toEqual(['peanut']);
    expect(textMentions(['A prompt?', 'An option.', explain], graph)).toEqual(['peanut']);
  });

  test('a note naming peanut past character 500 is scanned, and cook-with-my-notes is ⛔', () => {
    const notes: MarginNote[] = [
      { recipe: 'x', ops: [], text: filler(270), at: DAY },
      { recipe: 'x', ops: [], text: filler(270), at: DAY },
      { recipe: 'x', ops: [], text: 'Next time stir in peanuts at the end.', at: DAY },
    ];
    expect(noteMentions(notes, graph)).toEqual(['peanut']);
    expect(checkWithNotes(dish('leela', ['lentils', 'salt']), notes, [PEANUT], graph, subs, DAY).status).toBe('blocked');
  });

  test('property: a graph name at the end of a text longer than 2000 characters is found', () => {
    const ids = [...new Set(graph.labels().map((l) => graph.resolve(l)!))].sort();
    fc.assert(
      fc.property(fc.constantFrom(...ids), fc.integer({ min: 2001, max: 6000 }), fc.integer({ min: 1, max: 4 }), (id, n, parts) => {
        const name = graph.get(id).name;
        const texts = [...Array.from({ length: parts - 1 }, () => filler(n)), `${filler(n)} ${name}.`];
        expect(texts.at(-1)!.length).toBeGreaterThan(2000);
        expect(textMentions(texts, graph)).toContain(id);
        expect(noteMentions([{ recipe: 'x', ops: [], text: texts.join(' '), at: DAY }], graph)).toContain(id);
      }),
      { numRuns: 150 },
    );
  });
});
