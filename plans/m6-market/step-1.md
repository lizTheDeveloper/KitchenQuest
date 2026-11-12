# Step 1 — Core: stall banks, rules filtering, the Protein Counter and answers

This step adds the market's deciding code, pure and browser-safe, in a new core module `market/`. It decides:
- which stall questions a player may see today;
- whether Big Bram is the butcher or the Protein Counter;
- which tips and FAQ answers pass the player's rules;
- the round order and the display order of options;
- whether an answer is right.

No content changes here (Step 4) and no UI (Step 9). Every function takes the player's rules and the local date, and runs the M1 rules engine. A question survives only if everything it names is ✅ for this player, checked with no substitutions (README Global Constraints, §2.2): a question names the item itself, so a curated swap never makes a blocked item 🔁 here.

**Eval hash (Ruling 22, as overridden by the controller):** this step changes core `index.ts` and adds core `market/` to the turn's import closure, so `apps/api/test/eval-gate.test.ts` fails until Step 8: its recorded-pass (`evalHash`) assertion and its `EVAL_FILES`-equals-closure assertion. The gate is never skipped, on any branch. Run the API suite as is, report those `eval-gate.test.ts` failures as expected, and open no PR (Steps 1–8 get one PR after Step 8's eval passes).

**Files:**
- Create:
  - `packages/core/src/market/types.ts`: `StallOption`, `StallQuestion`, `StallVariant`, `StallFile` (core's shape of a whole stall file: `id`, `name`, `stall`, `art`, `persona?`, `triggers`, `games`, `questions`, `variants`, `seasonal`, `item_tips`, `faq`), `StallVariantFile` (`variants.protein_counter`: `name?`, `persona?`, `triggers`, `questions`, `item_tips`, `faq`), `StallTrigger` (`{ ai, lines, vars?, when?, notes? }`), `ItemTip`, `StallFaq`, `MarketCtx`, `AnsweredMap`. Step 5's `ClientStall` omits `persona` from these, and Steps 9–10 read the keepers' `triggers` (greet, correct, wrong, out_of_stock, out_of_stock_none, medical / allergen_note); the game's `StallFile`/`StallQuestion` in `apps/game/src/content/types.ts` become re-exports in Step 5 (as M5 moved quest types, C33);
  - `packages/core/src/market/bank.ts`: `questionStatus`, `stallVariant`, `stallBank`, `tipFor`, `faqFor`;
  - `packages/core/src/market/round.ts`: `nextRound`, `optionOrder`, `scoreAnswer`, `ROUND_SIZE`, `MAX_ROUND_ANSWERS`;
  - `packages/core/src/market/validate.ts`: `validateStallFile`;
  - `packages/core/src/market/country.ts`: `normalizeCountry` (lowercase, accents and punctuation stripped, then a small alias table to one name: "usa", "us", "united states of america" → "united states"; "uk", "great britain", "britain" → "united kingdom"; and so on). The `countries` scope compares normalised names on both sides;
  - `packages/core/src/market/index.ts`;
  - `packages/core/src/ingredients/mentions.ts`: `textMentions` (moved from `noteMentions`' body), with the helpers it needs moved and exported beside it: `words`, `pluralForms` and `lineOf` (today `words` and `lineOf` are module-private consts in `book/margin-notes.ts`; `margin-notes.ts` imports them back and keeps re-exporting `pluralForms`);
  - tests: `packages/core/src/market/{bank,round,validate}.test.ts`, `packages/core/src/market/never-safe.test.ts` (fast-check), `packages/core/src/ingredients/mentions.test.ts`, `packages/core/src/market/fixtures.ts`.
- Modify:
  - `packages/core/src/book/margin-notes.ts`: `noteMentions` builds its text parts as now and returns `textMentions(parts, graph)`. Behaviour is unchanged, and the existing margin-note tests pin it;
  - `packages/core/src/index.ts`, `packages/core/src/engine.ts`: export `market/` (browser-safe; no parser import);
  - `packages/core/test/no-streak.test.ts`: `DIRS` += `'market'` (the test lives in `test/`, not `src/progress/`, because it reads files with `node:fs`).

**Interfaces:**
- Consumes: `check`, `CheckResult`, `CheckStatus`, `Rule`, `Substitution` (M1); `IngredientGraph` (`resolve`, `labels`, `has`, `get`, `ancestors`, `descendants`); `pluralForms`, `words`, `lineOf` (M5 `book/margin-notes.ts`; `words` and `lineOf` are not exported there today, so they move, exported, to `ingredients/mentions.ts` with `textMentions`).
- Produces:
```ts
// market/types.ts
export interface StallOption { text: string; correct: boolean; reaction: string; contains?: string[] }
export interface StallQuestion {
  id: string; game: string; prompt: string; options: StallOption[]; explain: string;
  contains?: string[];
  /** Ruling 8: ISO country names this fact is true for; absent = everywhere. */
  countries?: string[];
  /** Ruling 5: value questions only, one entry per option in file order. */
  chalkboard?: { price: number; servings: number }[];
}
export type StallVariant = 'base' | 'protein_counter';
/** `subs` is carried for callers' convenience; questionStatus, tipFor and faqFor never apply it (a question names the item itself). */
export interface MarketCtx { rules: Rule[]; graph: IngredientGraph; subs: Substitution[]; date: string; country: string | null }
/** Per question id: whether it was ever answered correctly, and the local date it was last answered (Step 3 derives it). */
export type AnsweredMap = ReadonlyMap<string, { correct: boolean; lastAt: string }>;

// market/bank.ts
/** The worst check status, with NO substitutions, over q.contains ∪ every option's contains ∪ textMentions(prompt, options' text, explain). */
export function questionStatus(q: StallQuestion, ctx: MarketCtx): CheckStatus;
/**
 * 'protein_counter' when check of the `meat` category is ⛔ under ctx.rules (Ruling 4); 'base' otherwise.
 * Only meaningful for a stall file that has `variants.protein_counter`; every other stall is 'base'.
 */
export function stallVariant(stall: StallFile, ctx: MarketCtx): StallVariant;
/**
 * The questions this player may see at this stall now: the variant's (or base) questions plus `seasonal` (Step 2
 * supplies them; [] until then), each kept only when questionStatus is 'ok' AND its `countries` scope is
 * absent or contains ctx.country (both sides through `normalizeCountry`). Dropped questions are counted, never named, so a screen can say the
 * bank is smaller without revealing why.
 */
export function stallBank(stall: StallFile, ctx: MarketCtx, seasonal?: readonly StallQuestion[]):
  { variant: StallVariant; questions: StallQuestion[]; dropped: number };
export function tipFor(stall: StallFile, ingredientId: string, ctx: MarketCtx): ItemTip | null;   // null when the item (or anything its text names) is ⛔/❓, checked with no substitutions
export function faqFor(stall: StallFile, ctx: MarketCtx): { q: string; a: string }[];            // Ruling 21: when `a` names anything ⛔ or ❓ (no substitutions), a_if_blocked, else the stall's generic safety line (`medical`; the Spice Merchant's `allergen_note`)

// market/round.ts
export const ROUND_SIZE = 5;
export const MAX_ROUND_ANSWERS = 10;
/** Ruling 7: never answered correctly first, then least recently answered, then file order; at most `size`. */
export function nextRound(bank: readonly StallQuestion[], answered: AnsweredMap, size?: number): StallQuestion[];
/** Ruling 7: a fixed permutation of 0..n-1 from a stable hash (FNV-1a) of the question id. Same on every device. */
export function optionOrder(questionId: string, n: number): number[];
/** `pick` is the FILE index. Never throws: an out-of-range pick is { correct: false, valid: false }. */
export function scoreAnswer(q: StallQuestion, pick: number): { valid: boolean; correct: boolean; reaction: string; explain: string };

// market/validate.ts — never throws; each problem names the stall, the key path and the question id
export function validateStallFile(d: unknown, graph: IngredientGraph, opts: { knownGames: ReadonlySet<string> }): string[];

// ingredients/mentions.ts
/** Every graph id named in the texts (word-bounded name or alias, plural forms allowed). Sorted, each once. */
export function textMentions(texts: readonly string[], graph: IngredientGraph): string[];
```
- `questionStatus` builds one synthetic recipe from the contains ids and the mentioned ids (`lineOf(graph.get(id).name)`) and runs `check(recipe, ctx.rules, ctx.graph, [], ctx.date)` once: no substitutions. It is never cached across rule changes. An empty union is `ok`. A `contains` id the graph doesn't know is `unverified` (❓) here; Step 5's build makes it a hard failure, so shipped content never hits this path.
- `validateStallFile` problems:
  - not exactly one `correct: true`, or not 3–4 options;
  - a `contains` id (question or option level) missing from the graph;
  - an unknown `game` for the stall (the file's own `games:` keys);
  - an `item_tips` key not in the graph;
  - a duplicate question id across `questions`, `variants.*.questions` and `seasonal.*.*`;
  - a question naming an agency (`/\b(USDA|FSIS|FDA|FSA|NHS|FSANZ|CFIA|EFSA|FSSAI)\b/`) with no `countries` (Ruling 8);
  - a question with a `chalkboard` that isn't `game: value` or doesn't have one entry per option, or where the correct option isn't the strict minimum of `price / servings`, or where a reaction states a per-serving figure (`/=\s*(\d+(?:\.\d+)?)/`) that differs from its own entry's `price / servings` rounded to 2 places; and a `game: value` question whose text states a price (a number beside "chalkboard", "a serving" or a pack size) without a `chalkboard` (Ruling 5). Value questions that compare no prices (protein per 100 g, yields) need none;
  - a currency symbol (`$ £ € ¥ ₹ ₩ ₦ ₱ ¢`) anywhere in the file's question text (Ruling 5);
  - a `faq` entry with an empty `q`.
- Family Table and children: nothing in this module knows about modes. Step 9 decides what is recorded.

- [ ] **1.1 Write the failing tests:**
```ts
// bank.test.ts
test('a question whose contains is blocked is dropped; one whose correct option names a blocked item is dropped', ...);
test('a curated swap never keeps a question: lard under "no pork", garlic under a fructan rule, soy sauce under a soy rule are dropped although subs has swaps for them', ...);
test('a question that only NAMES a blocked item in its prompt text (no contains) is dropped: textMentions counts', ...);
test('❓ is never shown: a label-dependent item named in a question drops it under any restricting rule', ...);
test('an unknown contains id makes the question ❓, never ok', ...);
test('vegetarian rule (meat ⛔) → protein_counter; "no pork" only → base with pork and lard questions dropped', ...);
test('vegan → protein_counter with egg and milk questions dropped', ...);
test('countries scope: a [United States] question shows for country "USA"/"United States", not for "UK" or null', ...);
test('stallBank reports how many were dropped, never which', ...);
test('tipFor: null for a ⛔ or ❓ item; faqFor: a_if_blocked when the answer names a ⛔ or ❓ item, else the generic line (allergen_note at the spice stall)', ...);
// round.test.ts
test('nextRound: never-correct first, then least recently answered, then file order; same input → same output', ...);
test('optionOrder is a permutation, stable across calls, and differs between ids', ...);
test('over a stall bank of 15+ questions whose correct option is always file index 0, no display position holds more than half', ...);
test('scoreAnswer: file-index pick; out of range → valid false, correct false; a wrong answer returns its reaction and the explain', ...);
// validate.test.ts
test('each validateStallFile problem above, one fixture each, named by stall, key path and id', ...);
test('value question: correct option not the cheapest per serving → problem; a reaction "= 3.80" when the entry gives 3.75 → problem', ...);
test('a $ in a prompt or a ¢ in a reaction → problem; a value question about protein per 100 g needs no chalkboard', ...);
// never-safe.test.ts (fast-check)
test('for random rules over graph ids, no question stallBank returns names (contains or text) an id that check() reports blocked or unverified', ...);
// mentions.test.ts
test('textMentions finds names, aliases and plurals; noteMentions results are unchanged on the M5 fixtures', ...);
```
- [ ] **1.2 Run** `npm test -w @kitchenquest/core -- market mentions margin-notes no-streak` → FAIL. (`no-streak` is `packages/core/test/no-streak.test.ts`.)
- [ ] **1.3 Implement.** Keep `market/` free of any I/O, of the recipe parser and of `entitlements`. The architecture tests extend: `market/` must not import `progress/` (rewards are Step 3's, applied by the caller), and core `engine.ts` exports everything here.
- [ ] **1.4 Run** `npm test -w @kitchenquest/core` and `npm test -w @kitchenquest/game` → PASS, and `npm test -w @kitchenquest/api` → PASS except the expected `eval-gate.test.ts` failures (never skipped; report them as expected). `npm run typecheck` and `npm run lint` at the root are clean.
- [ ] **1.5 Commit** `feat(core): stall banks checked against the rules, the Protein Counter, fixed option order and answers`
