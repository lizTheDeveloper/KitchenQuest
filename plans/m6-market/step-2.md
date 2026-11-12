# Step 2 — Core: seasonality, region resolution and The Season's Table

Spec §3.5 asks for "what's in season in your region this month", from "a curated table by region and month". §17 adds The Season's Table: "produce and dishes follow real local seasons". This step adds the deciding code:
- which seasonal region, if any, the player's own profile names;
- what category an ingredient is in there this month;
- which of Wen's seasonal questions apply.

Nothing is guessed. No region, or more than one, means no season (README regional-honesty rule, Ruling 9). The Season's Table is information only (Ruling 10).

**Eval hash (Ruling 22, as overridden by the controller):** core `index.ts` changes again. The eval gate is never skipped: run the API suite as is and report the `eval-gate.test.ts` failures as expected, as in Step 1. No PR.

**Files:**
- Create:
  - `packages/core/src/market/season.ts`: `SeasonRegion`, `SeasonTable`, `seasonRegionFor`, `monthOf`, `seasonOf`, `seasonalQuestions`, `dishSeason`, `validateSeasonTable`, `seasonalAgrees`;
  - `packages/core/test/season-source.test.ts` (the source scan below: it reads `src/market/season.ts` with `node:fs`, so it lives in `test/`, as `no-streak.test.ts` does; core `src/` is type-checked without Node's types);
  - `packages/core/src/market/season.test.ts`, `packages/core/src/market/season.fixture.ts` (a synthetic two-region table: one temperate with `now`/`stored`/`travelled`, one tropical with `now`/`monsoon`/`all_year`/`travelled`; synthetic names, no real region claims).
- Modify: `packages/core/src/market/index.ts`; `packages/core/src/market/bank.ts` (only the doc comment on `stallBank`'s `seasonal` argument, now naming `seasonalQuestions`).

**Interfaces:**
- Consumes: `IngredientGraph` (`has`, `get(..).isA`); `StallFile`, `StallQuestion` (Step 1); `ParsedRecipe` (M1, for `dishSeason`); `isValidDate` (core).
- Produces:
```ts
export interface SeasonRegion {
  id: string;                         // kebab-case, e.g. "pnw-usa"
  name: string;                       // display name, e.g. "Pacific Northwest (US)"
  status: 'draft' | 'reviewed';
  sources: string[];                  // at least one citation
  match: { countries: string[]; regions: string[] };   // normalised phrases; regions [] = the whole country
  parent?: string;                    // Ruling 9: a declared SAME-COUNTRY broader region that is itself in the table
  categories: { id: string; label: string }[];          // the region's own, 2–5 of them; the first is "in season now"
  months: Partial<Record<'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'10'|'11'|'12', Record<string, string[]>>>;  // category id → ingredient ids
}
export type SeasonTable = Readonly<Record<string, SeasonRegion>>;
/**
 * The player's region id, or null. Normalise country and region (lowercase, strip accents and punctuation, collapse
 * spaces). A table region matches when its `countries` holds the country AND (its `regions` is [] OR one of its
 * `regions` phrases equals the region or is a whole-word part of it). Exactly one match → its id. Zero or more than one
 * → null. A null country → null. There is no default and no nearest guess.
 */
export function seasonRegionFor(profile: { country: string | null; region: string | null }, table: SeasonTable): string | null;
export function monthOf(localDate: string): number;      // 1–12 from YYYY-MM-DD; throws on a bad date
/**
 * The ingredient's category this month in this region: its own id first, then its isA ancestors breadth first (like
 * stallFor), then the region's `parent` the same way. null when the month has no entry or nothing matches: no note.
 */
export function seasonOf(ingredientId: string | null, regionId: string | null, month: number, table: SeasonTable, graph: IngredientGraph):
  { category: string; label: string; isNow: boolean } | null;
/** Wen's stall.seasonal[regionId][month], else the parent's, else []. Never another country's. */
export function seasonalQuestions(stall: StallFile, regionId: string | null, month: number, table: SeasonTable): StallQuestion[];
/** The plan view's note: the dish's ingredient ids that are `isNow` this month. [] when no region. Never a status. */
export function dishSeason(recipe: ParsedRecipe, regionId: string | null, month: number, table: SeasonTable, graph: IngredientGraph): string[];
export function validateSeasonTable(d: unknown, graph: IngredientGraph): string[];
/**
 * Cross-check (Ruling 9): every seasonal question's correct option text equals the label of the category the table
 * gives its `contains[0]` for that region and month, and every option text is one of that region's category labels
 * (plus an optional "Depends: ask the farmer"-style label the region declares). Wen's seasonal blocks must name
 * regions that are in the table.
 */
export function seasonalAgrees(stall: StallFile, table: SeasonTable): string[];
```
- `validateSeasonTable` problems:
  - an id not kebab-case;
  - no sources;
  - a `parent` not in the table or with a different `countries` list;
  - a parent cycle;
  - fewer than 2 or more than 5 categories;
  - a month key outside 1–12;
  - a category key the region doesn't declare;
  - an ingredient id not in the graph;
  - the same id in two categories of one month;
  - two regions whose `match` both accept the same normalised (country, region) pair from a probe list built from all the table's own phrases. That would make `seasonRegionFor` null for those players. It is reported, never resolved by picking one.
- Regional honesty, pinned by tests: no function here has a default region, month or hemisphere argument. `seasonRegionFor` never returns a region whose `countries` lacks the player's country.

- [ ] **2.1 Write the failing tests:**
```ts
test('seasonRegionFor: exact country + region phrase → id; country only with a regions:[] entry → id; no country → null', ...);
test('seasonRegionFor: two matching regions → null (never picks one); an unknown country → null; never another country\'s region', ...);
test('seasonRegionFor normalises: "Washington State, USA" / "washington" + "United States" → same id; accents stripped', ...);
test('seasonOf: own id, then isA ancestor, then parent; month without entry → null; null region → null', ...);
test('tropical fixture: its own categories (monsoon, all_year) are returned; no "stored" category exists for it', ...);
test('seasonalQuestions: region/month entry; parent fallback only within the same country; else []', ...);
test('dishSeason: ids in the first category only; [] for null region', ...);
test('validateSeasonTable: each problem above, one fixture each', ...);
test('seasonalAgrees: a seasonal question whose correct option disagrees with the table → problem naming the id', ...);
// packages/core/test/season-source.test.ts
test('no exported function in season.ts declares a default parameter (source scan of the module)', ...);
```
- [ ] **2.2 Run** `npm test -w @kitchenquest/core -- season` → FAIL (both `season.test.ts` and `test/season-source.test.ts`).
- [ ] **2.3 Implement.**
- [ ] **2.4 Run** `npm test -w @kitchenquest/core`, `npm test -w @kitchenquest/game` → PASS, and `npm test -w @kitchenquest/api` → PASS except the expected `eval-gate.test.ts` failures (never skipped; report them as expected).
- [ ] **2.5 Commit** `feat(core): seasonal regions from the player's own profile, no default, and the Season's Table notes`
