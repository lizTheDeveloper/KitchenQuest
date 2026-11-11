# Step 11 — Game: cook → log, Cooked for Someone, margin notes, the Recipe Book and its export

The end of the loop, and the place it is kept. When cook mode finishes, three optional questions follow in order, each skippable with one tap and each a card or chip, never a gate:
1. "Who ate with you?" (Cooked for Someone)
2. "Did you change anything?" (Margin Notes)
3. "Log it?": spec §5's one-tap logging for game dishes (M4 deferral C25).

In Family Table mode (`settings.familyTable`; Ruling 25, C31) the flow asks neither "Who ate with you?" nor "Did you change anything?". "Log it?" is a card, and M4's Family Table panel shows no cards (§19), so it is not offered either: cook mode ends with the Pan's lines only, and nothing is kept.

Then the Recipe Book (`#/book`) shows one page per taught dish. Each page holds the gift line and credit first, the techniques used, the dates cooked, your margin notes and the Shared Table tally. Frames have their own section. The book exports as one self-contained file, free and always available (audit M-7). Photos are M8.

**Files:**
- Create:
  - `apps/game/src/cook/after-cook.ts`: the three-question flow;
  - `apps/game/src/book/book-model.ts`: pages from progress, content, notes and the shared table (core-only inputs; no fetch inside);
  - `apps/game/src/book/book-screen.ts`;
  - `apps/game/src/book/book-export.ts`: a standalone HTML file with inline styles, each canon recipe's Cooklang source, notes and dates; no scripts, no remote assets;
  - `apps/game/src/book/notes-panel.ts`: list, add (card), delete; "cook with my notes".
- Modify:
  - `apps/game/src/cook/finish.ts` and `cook-screen.ts`: hand off to `after-cook` after the `cooked` event (Step 9);
  - `apps/game/src/mentor/writer.ts`: `margin_note`, `cooked_for` and `meal` (dish) local cards → `POST /notes`, `POST /shared-table`, `POST /meals`;
  - `apps/game/src/mentor/cards-view.ts`: the 2-M/MARGIN and 5-S/SHARED TABLE slips;
  - `apps/game/src/api/{client,types}.ts`: `listNotes`, `createNote`, `deleteNote`, `recordShared`, `sharedTally`, `deleteShared`;
  - `apps/game/src/shell/router.ts`, `screens.ts`, `titles.ts`: `book`, `book/<slug>`;
  - `apps/game/src/recipes/card-model.ts`: "cook with my notes" builds the card from `checkWithNotes`;
  - `apps/game/src/kitchen/kitchen-screen.ts`: the book on the shelf (HTML link; sprite slot M10) and the Shared Table tally on the apprentice card.
- Test: unit tests beside each module; `apps/game/e2e/cook-log.e2e.test.ts` and `apps/game/e2e/book.e2e.test.ts` (new).

**Interfaces:**
- Consumes: `parseCookedFor`, `COOKED_FOR_*`, `SharedEntry`, `SharedTally`, `parseMarginNote`, `checkWithNotes`, `applyNotes`, `validateNote` (Step 3); `ProgressView` (`cookedOn`, `framesCookedOn`) (Step 1); `ClientContent` (Step 4); `buildMealCard` (M4 core); Step 7 routes; `POST /meals` (M4); `record` (Step 9); `exportAccount` (M2).
- Produces:
```ts
// cook/after-cook.ts
export function afterCook(slot: HTMLElement, input: { slug: string | null; frame: string | null; recipe: ParsedRecipe; at: string },
  deps: { writer: CardWriter; record; signedIn(): boolean; familyTable(): boolean; healthConsent(): 'granted' | 'reconsent' | 'missing'; dialogue: Dialogue }): Promise<void>;
// book/book-model.ts
export interface BookPage { slug: string; dish: string; cook: string; gift: string[]; credit: string; techniques: { id: string; tier: Tier }[];
  cookedOn: string[]; notes: (MarginNote & { id: string })[]; sharedMeals: number }
export interface FramePage { id: string; title: string; technique: string; credit: string; cookedOn: string[] }   // from view.framesCookedOn
export function bookPages(view: ProgressView, content: ClientContent, notes: Map<string, (MarginNote & { id: string })[]>, shared: SharedTally):
  { dishes: BookPage[]; frames: FramePage[] };
  // a page exists only for a dish the player was TAUGHT (quest done or cooked) and never for a sacred dish (C39); never a list of
  // untaught dishes; no "n of m"; BookPage.sharedMeals = shared.byRecipe[slug] ?? 0 (C21); signed out, shared = { shared: 0, byRecipe: {} };
  // a frame appears once it has been cooked at least once
// book/book-export.ts
export function bookFile(pages: ReturnType<typeof bookPages>, recipesSource: Map<string, string>): Blob;   // text/html; filename "kitchen-quest-recipe-book.html"
```
- The after-cook flow:
  - **Who ate with you?** Chips "Just me", "One more", "Two or three", "Four or more", then optional who-chips, or a short text parsed by `parseCookedFor` into those same values. Typed names are dropped before the card is built. The 5-S card shows exactly what will be stored: count and word, no name. One tap stamps it.
    - "Just me" gets `cooked_for.alone`; others get `cooked_for.shared`. The warmth is equal and nothing is counted against the player.
    - Signed out, the step is skipped silently: there is nowhere to keep it, and the Pan doesn't nag.
  - **Did you change anything?** Free text up to 280 characters, parsed into ops. The 2-M card reads back `margin.readback` with the ops spelled out. A rule clash shows `margin.blocked` with the finding before the stamp, so the player knows "cook with my notes" will show ⛔.
    - Without `health_data` consent → `consent.health_first` and the 3-C card (M4 path, now v3). Signed out → `margin.needs_account`.
    - Never offered for a sacred dish or a frame.
  - **Log it?** A `log.dish_offer` card with servings chips (½, 1, 2) and the meal slot from the clock (core `slotForTime`, M4). One tap → `POST /meals`. The game then posts a `meal_logged` event, so nourishment is computed by core (Ruling 5) and never shown as a number.
    - Signed out → `log.needs_account` (M4).
    - No consent → the 3-C card first.
    - "Not now" is always there and costs nothing.
- Recipe Book:
  - Signed in, the book reads `GET /notes` (every note, filtered here by slug, C32) and `GET /shared-table/tally` (`byRecipe` for each page, C21).
  - The order is by the first cook date. There are no tabs per country with counts.
  - The credit line names the community first (audit M-5, voice §0.4).
  - Margin notes show as "your margin notes" under the canon text. The canon text is never edited.
  - Deleting a note is a tap with M4-style undo. It never touches XP.
  - The page has a "Download my book" button, signed in or out. Signed out it contains progress and dates only.
  - The export file is checked for no `<script>`, no remote URL and no account email.
- Never on these screens: a price, the Guild, a streak, "x of 9", "collected", "unlocked", or comparison with anyone. Step 12's scan adds them.

- [ ] **11.1 Write the failing tests:**
```ts
test('after cook: all three steps skippable; skipping writes nothing and costs nothing', ...);
test('cooked-for: "my flatmate Sam and his sister" → card shows two_to_three + flatmate; the request body has no "Sam"', ...);
test('margin note: "used peanut butter" for a peanut-rule player → margin.blocked before stamp; stamped note → cook-with-notes card ⛔', ...);
test('margin note without health_data → 3-C card first; signed out → margin.needs_account; sacred dish → not offered', ...);
test('one-tap log: Log it → POST /meals with confirmed true, then a meal_logged event; no XP number shown anywhere', ...);
test('book: one page per taught dish, community credit first, no counts across cultures; frames section separate; a cooked sacred dish has no page (C39)', ...);
test('book: sharedMeals per page comes from the tally\'s byRecipe; notes are filtered by slug from one GET /notes (C21, C32)', ...);
test('Family Table: after cook asks nothing and writes nothing (C31)', ...);
test('book export: a single HTML blob, no <script>, no http(s) URL, no email; contains the Cooklang source and notes', ...);
// e2e cook-log.e2e.test.ts and book.e2e.test.ts (mocked /api)
```
- [ ] **11.2 Run** `npm test -w @kitchenquest/game -- after-cook book notes writer` and `npm run test:e2e -w @kitchenquest/game -- cook-log book` → FAIL.
- [ ] **11.3 Implement.** Every slip's initial focus goes to the read-back text, not the Stamp button (audit R2), which is M4's rule extended to the new forms.
- [ ] **11.4 Run** `npm test -w @kitchenquest/game` and `npm run test:e2e -w @kitchenquest/game` → PASS.
- [ ] **11.5 Commit** `feat(game): cook → log with Cooked for Someone and margin notes; the Recipe Book and its free export`
