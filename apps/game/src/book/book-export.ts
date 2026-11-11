import type { NoteOp } from '@kitchenquest/core/engine';
import type { BookNote, BookPage, FramePage } from './book-model';

/**
 * The Recipe Book as one self-contained file (M5 Step 11, audit M-7): free, always available, signed in or out, and
 * saved only when the player taps "Download my book". Plain HTML with one inline stylesheet: no script, no remote asset,
 * no link that loads anything. It holds only the player's own book: each taught dish's page with the canon recipe's
 * Cooklang source, the dates cooked, the techniques and the player's margin notes, then the frames. Sacred dishes have
 * no page (C39), so none is ever here. No account detail (no email, no id) is ever written into it.
 */

export const BOOK_FILE_NAME = 'kitchen-quest-recipe-book.html';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * Text as inert HTML: every markup character escaped, and any "scheme://" broken with a zero-width space so nothing in
 * the file reads as a link to anywhere (a note may quote one). The words read the same.
 */
export function inert(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/([a-z][a-z0-9+.-]*):\/\//gi, '$1:/​/');
}

export function opText(op: NoteOp): string {
  switch (op.op) {
    case 'add': return `added ${op.name}`;
    case 'remove': return `left out ${op.name}`;
    case 'swap': return `used ${op.to} instead of ${op.from}`;
  }
}

/** A note as words: its ingredient changes, then the player's own text. */
export function noteText(n: Pick<BookNote, 'ops' | 'text'>): string {
  return [...n.ops.map(opText), ...(n.text === null || n.text.trim() === '' ? [] : [n.text.trim()])].join('; ');
}

const STYLE = [
  'body{font-family:Georgia,serif;max-width:42rem;margin:2rem auto;padding:0 1rem;color:#2b2118;background:#fbf6ec;line-height:1.5}',
  'h1,h2,h3{font-family:Georgia,serif;line-height:1.2}',
  'section{border-top:1px solid #c9b79c;margin-top:2rem;padding-top:1rem}',
  'pre{white-space:pre-wrap;background:#f3ead8;padding:.75rem;border-radius:4px;font-size:.9rem}',
  '.credit{font-style:italic}',
  '.foot{font-size:.85rem;color:#5c4a36}',
].join('');

const list = (items: readonly string[]): string => (items.length === 0 ? '' : `<ul>${items.map((i) => `<li>${inert(i)}</li>`).join('')}</ul>`);

function dishSection(p: BookPage, source: string | undefined): string {
  return [
    '<section>',
    `<h2>${inert(p.dish)}</h2>`,
    ...p.gift.map((g) => `<p>${inert(g)}</p>`),
    `<p class="credit">${inert(p.credit)}</p>`,
    p.techniques.length === 0 ? '' : `<h3>Techniques</h3>${list(p.techniques.map((t) => t.name))}`,
    p.cookedOn.length === 0 ? '' : `<h3>Cooked on</h3>${list(p.cookedOn)}`,
    p.sharedMeals === 0 ? '' : `<p>Shared at your table ${p.sharedMeals === 1 ? 'once' : `${p.sharedMeals} times`}.</p>`,
    source === undefined ? '' : `<h3>The recipe, as the cook wrote it</h3><pre>${inert(source)}</pre>`,
    p.notes.length === 0 ? '' : `<h3>Your margin notes</h3>${list(p.notes.map((n) => `${n.at.slice(0, 10)}: ${noteText(n)}`))}`,
    '</section>',
  ].join('');
}

function frameSection(f: FramePage): string {
  return [
    '<section>',
    `<h2>${inert(f.title)}</h2>`,
    `<p>${inert(f.technique)}</p>`,
    `<p class="credit">${inert(f.credit)}</p>`,
    `<h3>Cooked on</h3>${list(f.cookedOn)}`,
    '</section>',
  ].join('');
}

/**
 * The book file: `text/html`, one document, to be saved as BOOK_FILE_NAME. `recipesSource` maps a page's slug to its
 * canon Cooklang source; a slug without one gets no recipe block.
 */
export function bookFile(pages: { dishes: BookPage[]; frames: FramePage[] }, recipesSource: ReadonlyMap<string, string>): Blob {
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>My Kitchen Quest Recipe Book</title>',
    `<style>${STYLE}</style></head><body>`,
    '<h1>My Recipe Book</h1>',
    '<p class="foot">Kept by the Pantry Bureau on your behalf, and now on yours. The recipes are the cooks\' communities\', shared under their licence; the notes are yours.</p>',
    ...pages.dishes.map((p) => dishSection(p, recipesSource.get(p.slug))),
    pages.frames.length === 0 ? '' : `<h2>Pantry Frames</h2>${pages.frames.map(frameSection).join('')}`,
    '</body></html>',
  ].join('\n');
  return new Blob([html], { type: 'text/html' });
}

const EMAIL_LIKE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const REDACTED = '[an email address]';

/**
 * The notes as they may go into the file (fix M3): the account's email, and anything shaped like an email address,
 * replaced in the text and in every ingredient-change field. The player's notes are otherwise untouched.
 */
export function redactNotes<N extends Pick<BookNote, 'ops' | 'text'>>(notes: readonly N[], email: string | null): N[] {
  const exact = email === null || email === '' ? null : new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const clean = (t: string): string => (exact === null ? t : t.replace(exact, REDACTED)).replace(EMAIL_LIKE, REDACTED);
  return notes.map((n) => ({
    ...n,
    text: n.text === null ? null : clean(n.text),
    ops: n.ops.map((op): NoteOp => (op.op === 'swap' ? { op: 'swap', from: clean(op.from), to: clean(op.to) } : { op: op.op, name: clean(op.name) })),
  }));
}
