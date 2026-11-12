import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { stallBank } from './bank';
import { ctx as marketCtx, avoid } from './fixtures';
import { check } from '../rules/check';
import { dishSeason, dishSeasonNote, monthOf, seasonalAgrees, seasonalQuestions, seasonNote, seasonOf, seasonRegionFor, validateSeasonTable, type SeasonRegion, type SeasonTable } from './season';
import { ALL_YEAR, clone, COAST, dish, EAST_VALE, graph, MONSOON, NOW, seasonal, STORED, TABLE, TRAVELLED, VALE, WEN, WITH_CHILD } from './season.fixture';
import type { StallFile } from './types';

const region = (over: Partial<SeasonRegion> & { id: string }): SeasonRegion => ({ ...clone(VALE), months: {}, ...over });
const p = (country: string | null, regionName: string | null = null) => ({ country, region: regionName });

describe('seasonRegionFor', () => {
  test('seasonRegionFor: exact country + region phrase → id; country only with a regions:[] entry → id; no country → null', () => {
    expect(seasonRegionFor(p('Canada', 'test vale'), TABLE)).toBe('test-vale');
    expect(seasonRegionFor(p('Canada', 'Vale of Tests'), TABLE)).toBe('test-vale');
    expect(seasonRegionFor(p('Sri Lanka', null), TABLE)).toBe('test-coast');
    expect(seasonRegionFor(p('Sri Lanka', 'anywhere at all'), TABLE)).toBe('test-coast');
    // A region list that isn't [] needs a region phrase: the country alone is not enough.
    expect(seasonRegionFor(p('Canada', null), TABLE)).toBeNull();
    expect(seasonRegionFor(p('Canada', 'somewhere else'), TABLE)).toBeNull();
    expect(seasonRegionFor(p(null, 'test vale'), TABLE)).toBeNull();
    expect(seasonRegionFor(p('', 'test vale'), TABLE)).toBeNull();
    expect(seasonRegionFor(p(null, null), TABLE)).toBeNull();
  });

  test('seasonRegionFor: two matching regions → null (never picks one); an unknown country → null; never another country\'s region', () => {
    const twice: SeasonTable = { ...TABLE, 'test-vale-too': region({ id: 'test-vale-too', match: { countries: ['Canada'], regions: ['vale'] } }) };
    expect(seasonRegionFor(p('Canada', 'test vale'), twice)).toBeNull();
    expect(seasonRegionFor(p('Canada', 'vale'), twice)).toBe('test-vale-too');
    expect(seasonRegionFor(p('Atlantis', 'test vale'), TABLE)).toBeNull();
    // The right region words in another country: not this region.
    expect(seasonRegionFor(p('India', 'test vale'), TABLE)).toBeNull();
    expect(seasonRegionFor(p('United States', 'test vale'), TABLE)).toBeNull();
    expect(seasonRegionFor(p('India', null), TABLE)).toBeNull();
    // An empty table: no default, no nearest guess.
    expect(seasonRegionFor(p('Canada', 'test vale'), {})).toBeNull();
  });

  test('seasonRegionFor normalises: "Washington State, USA" / "washington" + "United States" → same id; accents stripped', () => {
    const t: SeasonTable = {
      'test-wa': region({ id: 'test-wa', match: { countries: ['United States'], regions: ['washington', 'quebec city'] } }),
    };
    expect(seasonRegionFor(p('USA', 'Washington State, USA'), t)).toBe('test-wa');
    expect(seasonRegionFor(p('United States', 'washington'), t)).toBe('test-wa');
    expect(seasonRegionFor(p('U.S.A.', '  WASHINGTON  '), t)).toBe('test-wa');
    expect(seasonRegionFor(p('United States of America', 'Québec City'), t)).toBe('test-wa');
    // Whole words only: "washingtonia" is not "washington".
    expect(seasonRegionFor(p('USA', 'Washingtonia'), t)).toBeNull();
    // Accents in the table's own phrases are stripped too.
    const accented: SeasonTable = { 'test-mx': region({ id: 'test-mx', match: { countries: ['México'], regions: ['Michoacán'] } }) };
    expect(seasonRegionFor(p('Mexico', 'michoacan'), accented)).toBe('test-mx');
  });

  test('seasonRegionFor: UK nations are distinct, with containment (Step 1 countryInScope)', () => {
    const uk: SeasonTable = { 'test-uk': region({ id: 'test-uk', match: { countries: ['United Kingdom'], regions: [] } }) };
    expect(seasonRegionFor(p('Scotland', null), uk)).toBe('test-uk');
    expect(seasonRegionFor(p('UK', null), uk)).toBe('test-uk');
    const scot: SeasonTable = { 'test-scot': region({ id: 'test-scot', match: { countries: ['Scotland'], regions: [] } }) };
    expect(seasonRegionFor(p('Scotland', null), scot)).toBe('test-scot');
    expect(seasonRegionFor(p('England', null), scot)).toBeNull();
    expect(seasonRegionFor(p('United Kingdom', null), scot)).toBeNull();
  });

  test('property: the result is null or a region whose countries take the player in, and the only one that does', () => {
    const countries = ['Canada', 'Sri Lanka', 'India', 'United States', 'Scotland', 'Kenya', null];
    const regions = ['test vale', 'vale of tests', 'east dale', 'dale', null, 'kerala', 'oaxaca'];
    fc.assert(
      fc.property(fc.constantFrom(...countries), fc.constantFrom(...regions), (c, r) => {
        const id = seasonRegionFor(p(c, r), WITH_CHILD);
        if (c === null) return id === null;
        if (id === null) return true;
        return WITH_CHILD[id].match.countries.includes(c);
      }),
    );
  });
});

describe('monthOf', () => {
  test('monthOf: 1–12 from YYYY-MM-DD; throws on a bad date', () => {
    expect(monthOf('2026-11-12')).toBe(11);
    expect(monthOf('2027-01-01')).toBe(1);
    expect(monthOf('2026-12-31')).toBe(12);
    for (const bad of ['2026-13-01', '2026-02-30', '2026-11', '12/11/2026', '', '2026-11-12T00:00:00Z']) expect(() => monthOf(bad), bad).toThrow();
  });
});

describe('seasonOf', () => {
  test('seasonOf: own id, then isA ancestor, then parent; month without entry → null; null region → null', () => {
    expect(seasonOf('cranberry', 'test-vale', 11, TABLE, graph)).toEqual({ category: 'now', label: NOW, isNow: true });
    expect(seasonOf('winter_squash', 'test-vale', 11, TABLE, graph)).toEqual({ category: 'stored', label: STORED, isNow: false });
    expect(seasonOf('strawberry', 'test-vale', 11, TABLE, graph)).toEqual({ category: 'travelled', label: TRAVELLED, isNow: false });
    // butternut isA winter_squash: the ancestor's category.
    expect(seasonOf('butternut', 'test-vale', 11, TABLE, graph)?.category).toBe('stored');
    // The child's own month first: winter squash is "now" in the East Vale in November.
    expect(seasonOf('winter_squash', 'test-east-vale', 11, WITH_CHILD, graph)?.category).toBe('now');
    // Not in the child's month 11: the parent's month 11.
    expect(seasonOf('cranberry', 'test-east-vale', 11, WITH_CHILD, graph)?.category).toBe('now');
    // The child has no month 12: the parent's.
    expect(seasonOf('cranberry', 'test-east-vale', 12, WITH_CHILD, graph)?.category).toBe('stored');
    // No month entry anywhere in the chain: no note.
    expect(seasonOf('cranberry', 'test-vale', 3, TABLE, graph)).toBeNull();
    expect(seasonOf('cranberry', 'test-east-vale', 3, WITH_CHILD, graph)).toBeNull();
    // An item the month doesn't list: no note.
    expect(seasonOf('onion', 'test-vale', 11, TABLE, graph)).toBeNull();
    expect(seasonOf('not_in_graph', 'test-vale', 11, TABLE, graph)).toBeNull();
    expect(seasonOf('cranberry', null, 11, TABLE, graph)).toBeNull();
    expect(seasonOf(null, 'test-vale', 11, TABLE, graph)).toBeNull();
    expect(seasonOf('cranberry', 'not-a-region', 11, TABLE, graph)).toBeNull();
  });

  test('seasonOf: own id beats an ancestor; ancestors breadth first', () => {
    const t: SeasonTable = { v: region({ id: 'v', months: { '5': { now: ['squash'], stored: ['butternut'], travelled: ['winter_squash'] } } }) };
    expect(seasonOf('butternut', 'v', 5, t, graph)?.category).toBe('stored');
    // winter_squash is nearer than squash.
    const t2: SeasonTable = { v: region({ id: 'v', months: { '5': { now: ['squash'], travelled: ['winter_squash'] } } }) };
    expect(seasonOf('butternut', 'v', 5, t2, graph)?.category).toBe('travelled');
  });

  test('seasonOf: a parent in another country is never followed, even if the data says so', () => {
    const t: SeasonTable = { ...TABLE, 'test-east-vale': { ...EAST_VALE, parent: 'test-coast' } };
    expect(seasonOf('jackfruit', 'test-east-vale', 11, t, graph)).toBeNull();
    // A parent cycle in unvalidated data ends, it doesn't loop.
    const loop: SeasonTable = { a: region({ id: 'a', parent: 'b' }), b: region({ id: 'b', parent: 'a' }) };
    expect(seasonOf('kale', 'a', 11, loop, graph)).toBeNull();
  });

  test('seasonOf: a month outside 1–12 throws (no default month)', () => {
    for (const m of [0, 13, 1.5, Number.NaN]) expect(() => seasonOf('kale', 'test-vale', m, TABLE, graph), String(m)).toThrow();
  });

  test('tropical fixture: its own categories (monsoon, all_year) are returned; no "stored" category exists for it', () => {
    expect(seasonOf('jackfruit', 'test-coast', 11, TABLE, graph)).toEqual({ category: 'now', label: NOW, isNow: true });
    expect(seasonOf('kale', 'test-coast', 11, TABLE, graph)).toEqual({ category: 'monsoon', label: MONSOON, isNow: false });
    expect(seasonOf('coconut', 'test-coast', 11, TABLE, graph)).toEqual({ category: 'all_year', label: ALL_YEAR, isNow: false });
    expect(COAST.categories.map((c) => c.id)).not.toContain('stored');
    // Winter squash is "stored" in the Vale; the Coast has no such word for anything.
    for (const id of ['winter_squash', 'butternut', 'cranberry', 'jackfruit', 'kale', 'coconut', 'strawberry']) {
      for (let m = 1; m <= 12; m++) {
        const s = seasonOf(id, 'test-coast', m, TABLE, graph);
        if (s !== null) {
          expect(s.category).not.toBe('stored');
          expect(s.label).not.toBe(STORED);
        }
      }
    }
  });
});

describe('seasonalQuestions', () => {
  test('seasonalQuestions: region/month entry; parent fallback only within the same country; else []', () => {
    expect(seasonalQuestions(WEN, 'test-vale', 11, TABLE).map((q) => q.id)).toEqual(['wen-vale-11-cranberry', 'wen-vale-11-squash', 'wen-vale-11-strawberry']);
    expect(seasonalQuestions(WEN, 'test-coast', 11, TABLE).map((q) => q.id)).toEqual(['wen-coast-11-jackfruit']);
    // The East Vale has no block of its own: the same-country parent's.
    expect(seasonalQuestions(WEN, 'test-east-vale', 12, WITH_CHILD).map((q) => q.id)).toEqual(['wen-vale-12-kale']);
    // No month entry anywhere: nothing.
    expect(seasonalQuestions(WEN, 'test-vale', 3, TABLE)).toEqual([]);
    expect(seasonalQuestions(WEN, 'test-coast', 12, TABLE)).toEqual([]);
    // No region, or a region the table doesn't have: nothing (never another region's).
    expect(seasonalQuestions(WEN, null, 11, TABLE)).toEqual([]);
    expect(seasonalQuestions(WEN, 'not-a-region', 11, TABLE)).toEqual([]);
    // A parent in another country is never followed.
    const cross: SeasonTable = { ...TABLE, 'test-east-vale': { ...EAST_VALE, parent: 'test-coast' } };
    expect(seasonalQuestions(WEN, 'test-east-vale', 11, cross)).toEqual([]);
    // A stall with no seasonal block.
    const plain: StallFile = { ...WEN, seasonal: undefined };
    expect(seasonalQuestions(plain, 'test-vale', 11, TABLE)).toEqual([]);
    expect(() => seasonalQuestions(WEN, 'test-vale', 13, TABLE)).toThrow();
  });

  test('seasonalQuestions feed stallBank, which rules-checks them: a strawberry allergy drops the strawberry question', () => {
    const qs = seasonalQuestions(WEN, 'test-vale', 11, TABLE);
    const c = marketCtx([avoid('strawberry')], { graph });
    const bank = stallBank(WEN, c, qs);
    expect(bank.questions.map((q) => q.id)).not.toContain('wen-vale-11-strawberry');
    expect(bank.questions.map((q) => q.id)).toContain('wen-vale-11-cranberry');
    // The caller's copy, not the stall file's own array.
    qs.pop();
    expect(seasonalQuestions(WEN, 'test-vale', 11, TABLE)).toHaveLength(3);
  });
});

describe('dishSeason', () => {
  test('dishSeason: ids in the first category only; [] for null region', () => {
    const d = dish(['cranberry', 'winter squash', 'strawberry', 'kale', 'onion', 'cranberry', 'mystery root']);
    expect(dishSeason(d, 'test-vale', 11, TABLE, graph)).toEqual(['cranberry', 'kale']);
    expect(dishSeason(d, 'test-vale', 6, TABLE, graph)).toEqual(['strawberry']);
    expect(dishSeason(d, 'test-vale', 3, TABLE, graph)).toEqual([]);
    expect(dishSeason(d, 'test-coast', 11, TABLE, graph)).toEqual([]);
    expect(dishSeason(dish(['jackfruit', 'kale']), 'test-coast', 11, TABLE, graph)).toEqual(['jackfruit']);
    expect(dishSeason(d, null, 11, TABLE, graph)).toEqual([]);
  });

  test('dishSeason: a sacred dish gets no note (§10)', () => {
    expect(dishSeason(dish(['cranberry', 'kale'], true), 'test-vale', 11, TABLE, graph)).toEqual([]);
  });
});

describe('validateSeasonTable', () => {
  const ok = (t: unknown) => validateSeasonTable(t, graph);
  const one = (r: SeasonRegion): SeasonTable => ({ [r.id]: r });
  const has = (problems: string[], re: RegExp) => expect(problems.some((s) => re.test(s)), problems.join('\n')).toBe(true);

  test('the fixtures pass', () => {
    expect(ok(TABLE)).toEqual([]);
    expect(ok(WITH_CHILD)).toEqual([]);
  });

  test('validateSeasonTable: each problem above, one fixture each', () => {
    has(ok({ Test_Vale: { ...clone(VALE), id: 'Test_Vale' } }), /Test_Vale.*kebab-case/);
    has(ok(one({ ...clone(VALE), sources: [] })), /test-vale.*no sources/);
    has(ok({ ...clone(TABLE), 'test-east-vale': { ...clone(EAST_VALE), parent: 'test-nowhere' } }), /test-east-vale.*parent "test-nowhere" is not in the table/);
    has(ok({ ...clone(TABLE), 'test-east-vale': { ...clone(EAST_VALE), parent: 'test-coast' } }), /test-east-vale.*parent "test-coast".*countries/);
    has(ok({ a: region({ id: 'a', parent: 'b', match: { countries: ['Canada'], regions: ['aa'] } }), b: region({ id: 'b', parent: 'a', match: { countries: ['Canada'], regions: ['bb'] } }) }), /parent cycle/);
    has(ok(one({ ...clone(VALE), categories: [{ id: 'now', label: NOW }], months: {} })), /test-vale.*2–5 categories/);
    has(
      ok(one({ ...clone(VALE), categories: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, label: id })), months: {} })),
      /test-vale.*2–5 categories/,
    );
    has(ok(one({ ...clone(VALE), months: { '13': { now: ['kale'] } } as SeasonRegion['months'] })), /test-vale.*month "13".*1–12/);
    has(ok(one({ ...clone(VALE), months: { '11': { stored_ish: ['kale'] } } })), /test-vale.*months\.11.*"stored_ish".*not declared/);
    has(ok(one({ ...clone(VALE), months: { '11': { now: ['dragonfruit'] } } })), /test-vale.*months\.11\.now.*"dragonfruit".*not in the ingredient graph/);
    has(ok(one({ ...clone(VALE), months: { '11': { now: ['kale'], travelled: ['kale'] } } })), /test-vale.*months\.11.*"kale".*two categories/);
    const overlap = ok({ ...clone(TABLE), 'test-vale-too': region({ id: 'test-vale-too', match: { countries: ['Canada'], regions: ['vale'] } }) });
    has(overlap, /test-vale.*test-vale-too.*both match/);
  });

  test('validateSeasonTable: overlaps between whole-country, phrase-combination and UK-nation matches are reported', () => {
    // A whole-country entry and a region entry in the same country both take a Vale player.
    has(ok({ ...clone(TABLE), 'test-canada': region({ id: 'test-canada', match: { countries: ['Canada'], regions: [] } }) }), /both match/);
    // "dale" inside another region's "east dale".
    has(
      ok({ n: region({ id: 'n', match: { countries: ['Canada'], regions: ['east dale'] } }), d: region({ id: 'd', match: { countries: ['Canada'], regions: ['dale'] } }) }),
      /both match/,
    );
    // A UK-wide entry and a Scotland entry both take a Scottish player.
    has(
      ok({ uk: region({ id: 'uk', match: { countries: ['United Kingdom'], regions: [] } }), sc: region({ id: 'sc', match: { countries: ['Scotland'], regions: [] } }) }),
      /both match/,
    );
    // Different countries with the same phrase: fine.
    expect(ok({ a: region({ id: 'a', match: { countries: ['Canada'], regions: ['vale'] } }), b: region({ id: 'b', match: { countries: ['India'], regions: ['vale'] } }) })).toEqual([]);
  });

  test('validateSeasonTable: shape problems are reported, not thrown', () => {
    expect(ok(null)).not.toEqual([]);
    expect(ok([])).not.toEqual([]);
    has(ok({ v: 'nope' }), /v.*not a map/);
    has(ok(one({ ...clone(VALE), status: 'final' as 'draft' })), /status/);
    has(ok(one({ ...clone(VALE), name: '' })), /name/);
    has(ok(one({ ...clone(VALE), match: { countries: [], regions: [] } })), /countries/);
    has(ok(one({ ...clone(VALE), match: { countries: ['Untied States'], regions: [] } })), /"Untied States" is not a known country/);
    has(ok(one({ ...clone(VALE), match: { countries: ['Canada'], regions: ['!!!'] } })), /region phrase/);
    has(ok(one({ ...clone(VALE), categories: [{ id: 'now', label: NOW }, { id: 'now', label: STORED }], months: {} })), /duplicate category/);
    has(ok(one({ ...clone(VALE), months: { '01': { now: ['kale'] } } as SeasonRegion['months'] })), /month "01"/);
    has(ok(one({ ...clone(VALE), months: { '11': { now: 'kale' } } as unknown as SeasonRegion['months'] })), /months\.11\.now.*not a list/);
  });
});

describe('seasonalAgrees', () => {
  test('the fixture Wen agrees with the fixture table', () => {
    expect(seasonalAgrees(WEN, TABLE)).toEqual([]);
  });

  test("seasonalAgrees: a seasonal question whose correct option disagrees with the table → problem naming the id", () => {
    const w = clone(WEN);
    w.seasonal!['test-vale']['11'][1] = seasonal('wen-vale-11-squash', 'winter_squash', [NOW, STORED, TRAVELLED], NOW);
    const problems = seasonalAgrees(w, TABLE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/wen-vale-11-squash/);
    expect(problems[0]).toContain(STORED);
  });

  test('seasonalAgrees: options must be the region\'s own labels; a declared "depends" category is allowed', () => {
    const w = clone(WEN);
    w.seasonal!['test-coast']['11'][0] = seasonal('wen-coast-11-jackfruit', 'jackfruit', [NOW, STORED, TRAVELLED], NOW);
    expect(seasonalAgrees(w, TABLE).join('\n')).toMatch(/wen-coast-11-jackfruit.*option "Local, stored from the autumn harvest".*test-coast/);

    const DEPENDS = 'Depends: ask the farmer';
    const withDepends: SeasonTable = { ...TABLE, 'test-vale': { ...clone(VALE), categories: [...VALE.categories, { id: 'depends', label: DEPENDS }] } };
    const w2 = clone(WEN);
    w2.seasonal!['test-vale']['11'][0] = seasonal('wen-vale-11-cranberry', 'cranberry', [NOW, STORED, TRAVELLED, DEPENDS], NOW);
    expect(seasonalAgrees(w2, withDepends)).toEqual([]);
    expect(seasonalAgrees(w2, TABLE).join('\n')).toMatch(/wen-vale-11-cranberry.*"Depends: ask the farmer"/);
  });

  test('seasonalAgrees: a region not in the table, a month the table leaves empty, or no contains → problem', () => {
    const w = clone(WEN);
    w.seasonal!['us-north'] = { '11': [seasonal('wen-usn-11-kale', 'kale', [NOW, STORED, TRAVELLED], NOW)] };
    expect(seasonalAgrees(w, TABLE).join('\n')).toMatch(/us-north.*not in the season table/);

    const w2 = clone(WEN);
    w2.seasonal!['test-vale']['3'] = [seasonal('wen-vale-3-kale', 'kale', [NOW, STORED, TRAVELLED], NOW)];
    expect(seasonalAgrees(w2, TABLE).join('\n')).toMatch(/wen-vale-3-kale.*no category/);

    const w3 = clone(WEN);
    delete w3.seasonal!['test-vale']['11'][0].contains;
    expect(seasonalAgrees(w3, TABLE).join('\n')).toMatch(/wen-vale-11-cranberry.*contains/);
  });

  test('seasonalAgrees: a stall with no seasonal block has nothing to disagree with', () => {
    expect(seasonalAgrees({ ...WEN, seasonal: undefined }, TABLE)).toEqual([]);
  });
});

describe('seasonNote and dishSeasonNote (fix round 1, I1): season text only for items the rules engine calls ✅', () => {
  const NOV = '2026-11-12';
  const c = (rules: Parameters<typeof marketCtx>[0] = [], date = NOV) => marketCtx(rules, { graph, date });
  const FRUCTAN = avoid('fodmap_fructan');

  test('a ✅ item gets the note, with the month from ctx.date', () => {
    expect(seasonNote('cranberry', 'test-vale', TABLE, c())).toEqual({ category: 'now', label: NOW, isNow: true });
    expect(seasonNote('cranberry', 'test-vale', TABLE, c([], '2026-12-03'))).toEqual({ category: 'stored', label: STORED, isNow: false });
    expect(seasonNote('cranberry', 'test-vale', TABLE, c([], '2026-03-03'))).toBeNull();
    expect(seasonNote('cranberry', 'test-vale', TABLE, c([avoid('kale')]))?.isNow).toBe(true);
    expect(seasonNote('cranberry', null, TABLE, c())).toBeNull();
    expect(seasonNote(null, 'test-vale', TABLE, c())).toBeNull();
    expect(() => seasonNote('cranberry', 'test-vale', TABLE, c([], '2026-13-01'))).toThrow();
  });

  test('a ⛔ item gets no note', () => {
    expect(seasonOf('cranberry', 'test-vale', 11, TABLE, graph)).not.toBeNull();
    expect(seasonNote('cranberry', 'test-vale', TABLE, c([avoid('cranberry')]))).toBeNull();
  });

  test('a ❓ item gets no note (winter squash could be butternut, which the rules avoid)', () => {
    const rules = [avoid('butternut')];
    expect(check(dish(['winter squash']), rules, graph, [], NOV).status).toBe('unverified');
    expect(seasonOf('winter_squash', 'test-vale', 11, TABLE, graph)).not.toBeNull();
    expect(seasonNote('winter_squash', 'test-vale', TABLE, c(rules))).toBeNull();
    // An id the graph doesn't know is ❓ too, even if unvalidated data lists it.
    const odd: SeasonTable = { 'test-vale': { ...clone(VALE), months: { '11': { now: ['not_in_graph'] } } } };
    expect(seasonOf('not_in_graph', 'test-vale', 11, odd, graph)).not.toBeNull();
    expect(seasonNote('not_in_graph', 'test-vale', odd, c())).toBeNull();
  });

  test('a 🔁 item gets no note: a recipe line could swap it, but the item itself is what the note names', () => {
    const ctx = c([FRUCTAN]);
    expect(check(dish(['garlic']), [FRUCTAN], graph, ctx.subs, NOV).status).toBe('swap');
    expect(seasonOf('garlic', 'test-vale', 11, TABLE, graph)?.isNow).toBe(true);
    expect(seasonNote('garlic', 'test-vale', TABLE, ctx)).toBeNull();
  });

  test('dishSeasonNote keeps only the ✅ now-ids of the dish', () => {
    const d = dish(['cranberry', 'garlic', 'kale', 'winter squash', 'onion']);
    expect(dishSeasonNote(d, 'test-vale', TABLE, c())).toEqual(['cranberry', 'garlic', 'kale']);
    expect(dishSeasonNote(d, 'test-vale', TABLE, c([FRUCTAN]))).toEqual(['cranberry', 'kale']);
    expect(dishSeasonNote(d, 'test-vale', TABLE, c([avoid('kale'), avoid('cranberry')]))).toEqual(['garlic']);
    expect(dishSeasonNote(d, 'test-vale', TABLE, c([], '2026-03-01'))).toEqual([]);
    expect(dishSeasonNote(d, null, TABLE, c())).toEqual([]);
    expect(dishSeasonNote(dish(['cranberry'], true), 'test-vale', TABLE, c())).toEqual([]);
  });
});

describe('fix round 1, M1: the mutants the review found alive', () => {
  test("seasonalAgrees: a child region's block is checked against its same-country parent's months", () => {
    const w = clone(WEN);
    // The East Vale has no month 12 of its own; the Vale has kale "now" in month 12.
    w.seasonal!['test-east-vale'] = { '12': [seasonal('wen-east-12-kale', 'kale', [NOW, STORED, TRAVELLED], NOW)] };
    expect(seasonalAgrees(w, WITH_CHILD)).toEqual([]);
    w.seasonal!['test-east-vale']['12'] = [seasonal('wen-east-12-kale', 'kale', [NOW, STORED, TRAVELLED], STORED)];
    expect(seasonalAgrees(w, WITH_CHILD).join('\n')).toMatch(/wen-east-12-kale.*correct option "Local, stored/);
  });

  test('seasonalAgrees: a seasonal question with no correct option is reported', () => {
    const w = clone(WEN);
    for (const o of w.seasonal!['test-vale']['11'][0].options) o.correct = false;
    expect(seasonalAgrees(w, TABLE).join('\n')).toMatch(/wen-vale-11-cranberry: no correct option/);
  });

  test('validateSeasonTable: an id that is not its own key, and a duplicate category label', () => {
    const problems = validateSeasonTable({ 'test-vale': { ...clone(VALE), id: 'test-dale' } }, graph);
    expect(problems.join('\n')).toMatch(/test-vale: id "test-dale" is not its key/);
    const labels = validateSeasonTable({ 'test-vale': { ...clone(VALE), categories: [{ id: 'now', label: NOW }, { id: 'stored', label: NOW }], months: {} } }, graph);
    expect(labels.join('\n')).toMatch(/duplicate category label/);
  });

  test("seasonRegionFor: apostrophes and full stops are dropped, not read as spaces (Hawai'i, St. John's)", () => {
    const t: SeasonTable = {
      'test-hi': region({ id: 'test-hi', match: { countries: ['United States'], regions: ['hawaii'] } }),
      'test-nl': region({ id: 'test-nl', match: { countries: ['Canada'], regions: ["st john's"] } }),
    };
    expect(seasonRegionFor(p('USA', "Hawai'i"), t)).toBe('test-hi');
    expect(seasonRegionFor(p('USA', 'Hawaiʻi'), t)).toBe('test-hi'); // the ʻokina (U+02BB) and ʼ (U+02BC) drop too
    expect(seasonRegionFor(p('USA', 'Hawaiʼi'), t)).toBe('test-hi');
    expect(seasonRegionFor(p('Canada', 'St. Johns'), t)).toBe('test-nl');
    expect(seasonRegionFor(p('Canada', 'st johns, nl'), t)).toBe('test-nl');
  });
});
