import type { ProgressView, SharedTally, Tier } from '@kitchenquest/core/engine';
import type { ApiClient } from '../api/client';
import type { BureauForm } from '../content/types';
import { content, graph } from '../content';
import { getMentorServices } from '../mentor';
import { renderConsentCard } from '../mentor/consent-card';
import { progressService } from '../progress';
import { activeRules, localDate } from '../recipes/rules';
import { RouteNotFound, type AppContext, type Screen } from '../shell/app';
import { routeHref } from '../shell/router';
import { SCREEN_TITLES } from '../shell/titles';
import { contentText, h } from '../ui/dom';
import { cookWithNotes } from '../cook/with-notes';
import { BOOK_FILE_NAME, bookFile } from './book-export';
import { bookPages, NO_TALLY, notesBySlug, type BookNote, type BookPage } from './book-model';
import { fmtDate, notesPanel } from './notes-panel';

/**
 * The Recipe Book (M5 Step 11): `#/book` lists one page per dish a cook taught the player, in the order they first
 * cooked them, with the frames in their own section; `#/book/<slug>` is one page. Signed in, it reads every note with
 * one `GET /notes` (filtered here by slug, C32) and the Shared Table counts with `GET /shared-table/tally` (C21);
 * nothing is cached on the device. "Download my book" is always there, signed in or out, and always free (audit
 * M-7): the file is made here and saved only on that tap. Never on these screens: a price, the Guild, a streak, a
 * count of dishes not yet taught, or a comparison with anyone.
 */

const TIER_WORD: Readonly<Record<Tier, string>> = { seen: 'Seen', tried: 'Tried', yours: 'Yours' };
const INTRO = 'One page for each dish a cook has taught you, in the order you first cooked them.';
const NOTES_UNREAD = "Your margin notes couldn't be loaded just now, so they aren't shown. They're safe; try again in a moment.";
const DOWNLOAD = 'Download my book';

interface BookData { notes: BookNote[]; tally: SharedTally; notesLoaded: boolean }

async function loadBook(client: ApiClient, signedIn: boolean): Promise<BookData> {
  if (!signedIn) return { notes: [], tally: NO_TALLY, notesLoaded: true };
  const [n, t] = await Promise.all([client.listNotes(), client.sharedTally()]);
  // Read defensively: what the server sent is data, never trusted for shape.
  const rawNotes: unknown = n.ok ? (n.data as { notes?: unknown }).notes : null;
  const notes = Array.isArray(rawNotes) ? (rawNotes as BookNote[]) : [];
  const rawTally: unknown = t.ok ? t.data : null;
  const ok = typeof rawTally === 'object' && rawTally !== null && typeof (rawTally as { byRecipe?: unknown }).byRecipe === 'object' && (rawTally as { byRecipe?: unknown }).byRecipe !== null;
  return { notes, tally: ok ? (rawTally as SharedTally) : NO_TALLY, notesLoaded: n.ok && Array.isArray(rawNotes) };
}

/** The account's email never goes into the file, even quoted in a note. */
function redact(notes: readonly BookNote[], email: string | null): BookNote[] {
  if (email === null || email === '') return [...notes];
  const re = new RegExp(email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return notes.map((n) => (n.text === null ? n : { ...n, text: n.text.replace(re, '[your email]') }));
}

export function bookScreen(client: ApiClient): Screen {
  let alive = true;
  const stops: (() => void)[] = [];
  return {
    title: SCREEN_TITLES.book,
    async mount(el, route, ctx) {
      if (route.name !== 'book') throw new RouteNotFound();
      const slug = route.slug;
      if (slug !== null && (!Object.hasOwn(content.recipes, slug) || content.recipes[slug].meta.sacred)) throw new RouteNotFound();
      el.replaceChildren(h('h1', { tabindex: -1 }, SCREEN_TITLES.book), h('p', { role: 'status' }, 'Opening the book…'));
      const svc = await progressService();
      if (!alive) return;
      let shownFor: string | null | undefined;
      let data: BookData | null = null;
      let viewKey = '';
      /** What the book shows from progress: a redraw happens only when one of these changes. */
      const keyOf = () => { const v = svc.view(); return JSON.stringify([v.cookedOn, v.framesCookedOn, v.questsDone, v.toolkit]); };
      const draw = async () => {
        const email = ctx.store.get().account?.email ?? null;
        if (email !== shownFor) {
          shownFor = email;
          data = null;
          const loaded = await loadBook(client, email !== null);
          // The book is the signed-in session's: a sign-out or another account meanwhile shows nothing of it.
          if (!alive || (ctx.store.get().account?.email ?? null) !== email) return;
          data = loaded;
        }
        if (data === null) return;
        viewKey = keyOf();
        render(el, slug, ctx, svc.view(), data, email, client);
      };
      await draw();
      stops.push(svc.subscribe(() => {
        const email = ctx.store.get().account?.email ?? null;
        if (alive && (email !== shownFor || keyOf() !== viewKey)) void draw();
      }));
    },
    unmount() { alive = false; for (const stop of stops.splice(0)) stop(); },
  };
}

const NOT_IN_BOOK = "This dish isn't in your book yet. A page is written once a cook has taught it to you.";

function render(el: HTMLElement, slug: string | null, ctx: AppContext, view: ProgressView, data: BookData, email: string | null, client: ApiClient): void {
  const pages = bookPages(view, content, notesBySlug(data.notes), data.tally);
  const status = h('p', { class: 'book-status', role: 'status', 'data-content': '' });
  const download = h('button', { type: 'button', class: 'btn btn-secondary book-download' }, DOWNLOAD);
  download.addEventListener('click', () => {
    const file = bookFile(bookPages(view, content, notesBySlug(redact(data.notes, email)), data.tally),
      new Map(pages.dishes.map((p) => [p.slug, content.recipes[p.slug].source])));
    saveFile(el.ownerDocument, file);
    status.textContent = getMentorServices().dialogue.say('book.exported').text;
  });
  const tail = [h('div', { class: 'button-row' }, download), status];
  const unread = data.notesLoaded ? null : h('p', { class: 'book-notes-unread' }, NOTES_UNREAD);
  const back = h('p', null, h('a', { href: routeHref({ name: 'book', slug: null }) }, 'Back to the Recipe Book'));
  if (slug === null) { el.replaceChildren(...bookIndex(pages), ...(unread ? [unread] : []), ...tail); return; }
  const page = pages.dishes.find((p) => p.slug === slug);
  // Never a page for a dish not taught (or sacred, C39), and never its name.
  if (page === undefined) { el.replaceChildren(h('h1', { tabindex: -1 }, SCREEN_TITLES.book), h('p', null, NOT_IN_BOOK), back); return; }
  el.ownerDocument.title = `${page.dish} · Kitchen Quest`;
  const notesSlot = h('div', { class: 'book-notes-slot' });
  el.replaceChildren(...dishPage(page), ...(unread ? [unread] : [notesSlot]), ...tail, back);
  if (data.notesLoaded) mountNotes(notesSlot, page, ctx, client);
}

function bookIndex(pages: ReturnType<typeof bookPages>): HTMLElement[] {
  const { dialogue } = getMentorServices();
  const head = h('h1', { tabindex: -1 }, SCREEN_TITLES.book);
  if (pages.dishes.length === 0 && pages.frames.length === 0) return [head, contentText('p', dialogue.say('book.empty').text, { class: 'book-empty' })];
  return [
    head,
    h('p', null, INTRO),
    h('ul', { class: 'book-index' }, ...pages.dishes.map((p) => h('li', { class: 'book-index-item', 'data-slug': p.slug },
      contentText('a', p.dish, { href: routeHref({ name: 'book', slug: p.slug }) }), ' ', contentText('span', `· ${p.credit}`, { class: 'book-credit' })))),
    ...(pages.frames.length === 0 ? [] : [
      h('h2', null, 'Pantry Frames'),
      h('ul', { class: 'book-frames' }, ...pages.frames.map((f) => h('li', { class: 'book-frame', 'data-frame': f.id },
        contentText('strong', f.title), ` · ${f.technique} · `, contentText('span', f.credit, { class: 'book-credit' }),
        h('span', { class: 'book-dates' }, ` · cooked ${f.cookedOn.map(fmtDate).join(', ')}`)))),
    ]),
  ];
}

function dishPage(p: BookPage): HTMLElement[] {
  return [
    contentText('h1', p.dish, { tabindex: -1 }),
    h('blockquote', { class: 'book-gift' }, ...p.gift.map((g) => contentText('p', g))),
    contentText('p', p.credit, { class: 'book-credit' }),
    h('h2', null, 'Techniques'),
    h('ul', { class: 'book-techniques' }, ...p.techniques.map((t) => h('li', null, contentText('span', t.name), ` · ${TIER_WORD[t.tier]}`))),
    h('h2', null, 'Cooked on'),
    p.cookedOn.length === 0 ? h('p', null, 'Not cooked yet. The cook mode is ready when you are.') : h('ul', { class: 'book-dates' }, ...p.cookedOn.map((d) => h('li', null, fmtDate(d)))),
    ...(p.sharedMeals === 0 ? [] : [h('p', { class: 'book-shared' }, p.sharedMeals === 1 ? 'Shared at your table once.' : `Shared at your table ${p.sharedMeals} times.`)]),
    h('p', null, h('a', { href: routeHref({ name: 'recipe', slug: p.slug }) }, 'The recipe, as the cook wrote it')),
  ];
}

function mountNotes(slot: HTMLElement, page: BookPage, ctx: AppContext, client: ApiClient): void {
  const { writer, dialogue } = getMentorServices();
  const store = ctx.store;
  notesPanel(slot, { slug: page.slug, recipe: content.recipes[page.slug], notes: page.notes }, {
    writer, signedIn: store.get().account !== null, now: ctx.now, today: () => localDate(ctx.now()),
    say: (t, v) => dialogue.say(t, v).text,
    rules: () => activeRules(store.get(), graph),
    notes: () => Promise.resolve(page.notes),
    askConsent: (box) => askConsentIn(box, client),
    cook: (notes) => { cookWithNotes(page.slug, notes); ctx.navigate({ name: 'cook', slug: page.slug }); },
  });
}

/** The 3-C card in `box` (the M4 path, the v3 notice from the API, verbatim). */
function askConsentIn(box: HTMLElement, client: ApiClient): Promise<boolean> {
  return new Promise((resolve) => {
    void client.consents().then((r) => {
      const notice = r.ok ? r.data.notices.health_data : undefined;
      const form = content.bureau.forms.consent_health as BureauForm | undefined;
      if (notice === undefined || form === undefined) { resolve(false); return; }
      const card = renderConsentCard('health_data', {
        form, notice,
        onAgree: async () => {
          const g = await client.grantConsent('health_data', notice.version);
          if (g.ok) { card.remove(); resolve(true); }
        },
        onDecline: () => { card.remove(); resolve(false); },
      });
      box.append(card);
    });
  });
}

/** Saves `file` to the player's device as BOOK_FILE_NAME, on their tap. Nothing is uploaded anywhere. */
function saveFile(doc: Document, file: Blob): void {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: BOOK_FILE_NAME, hidden: true });
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
