import { describe, expect, test } from 'vitest';
import { EMPTY_TOOLKIT, type ProgressView } from '@kitchenquest/core/engine';
import { content } from '../content';
import type { ClientContent } from '../content/types';
import { BOOK_FILE_NAME, bookFile, inert, noteText } from './book-export';
import { bookPages, NO_TALLY, notesBySlug, type BookNote } from './book-model';

const PARIPPU = 'india/kerala/parippu';
const FRIJOLES = 'mexico/oaxaca/frijoles-de-olla';
const ONIGIRI = 'japan/osaka/onigiri';
const view = (p: Partial<ProgressView> = {}): ProgressView => ({
  xp: 0, level: 1, stamps: 0, trust: {}, toolkit: EMPTY_TOOLKIT, questsDone: [], questSteps: {}, questStartedOn: {}, cookedOn: {}, framesCookedOn: {}, ...p,
});
const note = (recipe: string, id: string, text: string | null = 'less salt next time'): BookNote => ({ recipe, ops: [{ op: 'add', name: 'lime' }], text, at: '2026-11-10', id });

describe('bookPages (M5 Step 11)', () => {
  test('nothing taught: no pages, and no list of untaught dishes', () => {
    expect(bookPages(view(), content, new Map(), NO_TALLY)).toEqual({ dishes: [], frames: [] });
  });

  test('one page per taught dish (cooked, or its cook\'s quest done), ordered by first cook date; community credit first', () => {
    const v = view({ cookedOn: { [FRIJOLES]: ['2026-11-08', '2026-11-03'], [PARIPPU]: ['2026-11-05'] }, questsDone: [content.cooks.haruka.quest.id] });
    const { dishes } = bookPages(v, content, new Map(), NO_TALLY);
    expect(dishes.map((d) => d.slug)).toEqual([FRIJOLES, PARIPPU, ONIGIRI]);
    expect(dishes[0].cookedOn).toEqual(['2026-11-03', '2026-11-08']);
    expect(dishes[2].cookedOn).toEqual([]);
    const leela = content.cooks.leela;
    const p = dishes[1];
    expect(p.gift).toEqual(leela.gift);
    expect(p.credit.startsWith(`The home cooks of ${leela.place}`)).toBe(true);
    expect(p.credit.indexOf(leela.place)).toBeLessThan(p.credit.indexOf(leela.name));
    expect(p.techniques.map((t) => t.id)).toEqual(content.recipes[PARIPPU].meta.skills);
    expect(p.techniques.every((t) => t.name !== '')).toBe(true);
  });

  test('a cooked sacred dish has no page (C39)', () => {
    const sacred: ClientContent = { ...content, recipes: { ...content.recipes, [PARIPPU]: { ...content.recipes[PARIPPU], meta: { ...content.recipes[PARIPPU].meta, sacred: true } } } };
    const { dishes } = bookPages(view({ cookedOn: { [PARIPPU]: ['2026-11-05'] }, questsDone: [content.cooks.leela.quest.id] }), sacred, new Map([[PARIPPU, [note(PARIPPU, 'n1')]]]), { shared: 1, byRecipe: { [PARIPPU]: 1 } });
    expect(dishes).toEqual([]);
  });

  test('sharedMeals per page comes from the tally\'s byRecipe; notes are filtered by slug from one list (C21, C32)', () => {
    const all = [note(PARIPPU, 'n1'), note(FRIJOLES, 'n2'), note(PARIPPU, 'n3'), note(ONIGIRI, 'n4')];
    const v = view({ cookedOn: { [PARIPPU]: ['2026-11-05'], [FRIJOLES]: ['2026-11-06'] } });
    const { dishes } = bookPages(v, content, notesBySlug(all), { shared: 4, byRecipe: { [PARIPPU]: 3 } });
    const by = Object.fromEntries(dishes.map((d) => [d.slug, d]));
    expect(by[PARIPPU].sharedMeals).toBe(3);
    expect(by[FRIJOLES].sharedMeals).toBe(0);
    expect(by[PARIPPU].notes.map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(by[FRIJOLES].notes.map((n) => n.id)).toEqual(['n2']);
    expect(Object.keys(by)).not.toContain(ONIGIRI); // a note never makes a page
  });

  test('signed out: no tally means zeros, never a guess', () => {
    const { dishes } = bookPages(view({ cookedOn: { [PARIPPU]: ['2026-11-05'] } }), content, new Map(), NO_TALLY);
    expect(dishes[0].sharedMeals).toBe(0);
  });

  test('frames have their own section, each once it has been cooked', () => {
    const f = content.frames[0];
    const { dishes, frames } = bookPages(view({ framesCookedOn: { [f.id]: ['2026-11-07'] } }), content, new Map(), NO_TALLY);
    expect(dishes).toEqual([]);
    expect(frames).toEqual([{ id: f.id, title: f.title, technique: expect.any(String), credit: f.credit, cookedOn: ['2026-11-07'] }]);
    expect(bookPages(view({ framesCookedOn: { [f.id]: [] } }), content, new Map(), NO_TALLY).frames).toEqual([]);
  });

  test('no counts across cultures: a page carries no total, "of", "collected" or "unlocked"', () => {
    const v = view({ cookedOn: { [PARIPPU]: ['2026-11-05'] } });
    const text = JSON.stringify(bookPages(v, content, new Map(), NO_TALLY));
    expect(text).not.toMatch(/\b\d+ of \d+\b|collected|unlocked|acquired/i);
  });
});

describe('the book export (M5 Step 11)', () => {
  const pages = (notes: BookNote[]) => bookPages(view({ cookedOn: { [PARIPPU]: ['2026-11-05'] }, framesCookedOn: { [content.frames[0].id]: ['2026-11-07'] } }), content, notesBySlug(notes), { shared: 2, byRecipe: { [PARIPPU]: 2 } });
  const source = new Map([[PARIPPU, content.recipes[PARIPPU].source]]);

  test('a single HTML blob, no <script>, no http(s) URL, no email; contains the Cooklang source and the notes', async () => {
    const hostile = note(PARIPPU, 'n1', '<script>alert(1)</script> see https://example.com/x and mail me at cook@example.com');
    const blob = bookFile(pages([hostile, note(PARIPPU, 'n2', 'more garlic')]), source);
    expect(blob.type).toBe('text/html');
    const html = await blob.text();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\b(?:src|href)=/i);
    expect(html).toContain(inert(content.recipes[PARIPPU].source));
    expect(html).toContain('more garlic');
    expect(html).toContain('Your margin notes');
    expect(html).toContain(content.frames[0].title);
    expect(BOOK_FILE_NAME).toBe('kitchen-quest-recipe-book.html');
  });

  test('the account email is never written: the screen redacts it, and nothing else in the file names the account', async () => {
    const html = await bookFile(pages([note(PARIPPU, 'n1', 'for [your email]')]), source).text();
    expect(html).not.toContain('@example.com');
    expect(html).not.toMatch(/n1/); // no row ids either
  });

  test('signed out: progress and dates only, no notes section', async () => {
    const html = await bookFile(pages([]), source).text();
    expect(html).toContain('2026-11-05');
    expect(html).not.toContain('Your margin notes');
  });

  test('noteText spells the ops then the player\'s words', () => {
    expect(noteText({ ops: [{ op: 'swap', from: 'lentils', to: 'chickpeas' }, { op: 'remove', name: 'chilli' }], text: 'less salt' }))
      .toBe('used chickpeas instead of lentils; left out chilli; less salt');
  });
});

describe('fix M3/M9: the export never carries an email', () => {
  test('redactNotes removes the account email and any email-like string from the text and every ingredient-change field', async () => {
    const { redactNotes } = await import('./book-export');
    const n: BookNote = {
      recipe: PARIPPU, id: 'n1', at: '2026-11-10', text: 'ask Cook@Example.com or x.y+z@mail.example.org',
      ops: [{ op: 'add', name: 'me@here.io' }, { op: 'swap', from: 'a@b.co', to: 'c@d.co' }, { op: 'remove', name: 'chilli' }],
    };
    const [r] = redactNotes([n], 'cook@example.com');
    expect(JSON.stringify(r)).not.toMatch(/@/);
    expect(r.ops[2]).toEqual({ op: 'remove', name: 'chilli' });
    const html = await bookFile(bookPages(view({ cookedOn: { [PARIPPU]: ['2026-11-05'] } }), content, notesBySlug(redactNotes([n], 'cook@example.com')), NO_TALLY), new Map()).text();
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.\w/);
  });
});
