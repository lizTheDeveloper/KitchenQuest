// The Season's Table and the seasonal region (M6 Step 2, spec §3.5 and §17, Rulings 9 and 10). The table is curated
// (data/seasonality.yaml): one entry per region, each with its own categories, its sources and its months. Nothing
// here guesses. A player whose own profile names no region in the table, or more than one, has no season: no
// seasonal round and no note. There is no default region, month or hemisphere, and no other country's calendar.
// A region may name a broader `parent` only in the same country (Ruling 9), and only for its data.
//
// Information only (Ruling 10): these functions say what category an item is in. They never hide, lock or reorder
// anything. `seasonOf` and `dishSeason` are the raw lookups and do not check the player's rules. Player-facing season
// text comes ONLY from `seasonNote` and `dishSeasonNote` (fix round 1, I1), which take the player's MarketCtx and
// give a note only for an item the rules engine calls ✅, with no substitutions, as `stallBank` does ("can't verify
// is never safe"). Every seasonal question goes through `stallBank` too.
//
// Pure and browser-safe: no I/O, no recipe parser, no clock (the month comes from the player's local date).
import type { IngredientGraph } from '../ingredients/graph';
import type { ParsedRecipe } from '../recipe/types';
import { isValidDate } from '../rules/active';
import { namedStatus } from './bank';
import { countryInScope, isKnownCountry, normalizeCountry } from './country';
import type { MarketCtx, StallFile, StallQuestion } from './types';

type MonthKey = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | '11' | '12';

export interface SeasonRegion {
  /** kebab-case, e.g. "pnw-usa"; equals its key in the table. */
  id: string;
  /** Display name, e.g. "Pacific Northwest (US)". */
  name: string;
  status: 'draft' | 'reviewed';
  /** At least one citation. */
  sources: string[];
  /** Phrases compared after normalisation. `regions: []` means the whole country. */
  match: { countries: string[]; regions: string[] };
  /** Ruling 9: a declared SAME-COUNTRY broader region that is itself in the table. */
  parent?: string;
  /** The region's own categories, 2–5 of them. The first is "in season now". */
  categories: { id: string; label: string }[];
  /** Month 1–12 → category id → ingredient ids. A month left out means no note, never a guess. */
  months: Partial<Record<MonthKey, Record<string, string[]>>>;
}

export type SeasonTable = Readonly<Record<string, SeasonRegion>>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const own = <T>(rec: Readonly<Record<string, T>> | undefined, key: string): T | undefined =>
  rec !== undefined && Object.hasOwn(rec, key) ? rec[key] : undefined;

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATEGORY_ID = /^[a-z][a-z0-9_]*$/;
const MONTH_KEY = /^(?:[1-9]|1[0-2])$/;

/**
 * Fix round 1, M2 (never rule 5, "scarcity only mirrors real seasons"): a category label is player-facing copy, shown
 * as Wen's option and as the Season's Table note. Words that count down, hurry or call something scarce are rejected,
 * matched as whole words on the normalised label; so is an exclamation mark. Out of season is "well-travelled".
 */
// M6 Step 5: "not for long", "no longer", "almost", "nearly" added (a deadline said without a number).
const PRESSURE_WORDS = /\b(?:left|lasts?|hurry|rush|ends?|ending|gone|goes|only|limited|soon|fast|quick(?:ly)?|grab|miss|final|remaining|running out|before|scarce|rare|while|to go|days?|weeks?|hours?|(?:for|much|any|no) longer|for long|not long|last chance|almost|nearly)\b/;

/** Lower-cased, accents removed, apostrophes (and the ʻokina) and full stops dropped, other punctuation a space, spaces collapsed. */
function normalizePhrase(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’ʻʼ.]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Whether `phrase` equals `text` or is a run of whole words inside it (both already normalised). */
function wholeWordPart(phrase: string, text: string): boolean {
  return phrase !== '' && ` ${text} `.includes(` ${phrase} `);
}

/** Whether a region's `match` takes a player in this country (as written) and region (normalised, or null). */
function accepts(r: SeasonRegion, country: string | null, region: string | null): boolean {
  if (!countryInScope(r.match.countries, country)) return false;
  if (r.match.regions.length === 0) return true;
  return region !== null && r.match.regions.some((ph) => wholeWordPart(normalizePhrase(ph), region));
}

/**
 * The player's region id, or null. Normalise country and region (lowercase, strip accents and punctuation, collapse
 * spaces). A table region matches when its `countries` holds the country AND (its `regions` is [] OR one of its
 * `regions` phrases equals the region or is a whole-word part of it). Exactly one match → its id. Zero or more than one
 * → null. A null country → null. There is no default and no nearest guess.
 *
 * The country side is Step 1's `countryInScope`: aliases meet ("USA" = "United States"), and the UK's nations are
 * distinct, each inside the UK, so a Scottish player matches a UK-wide region but an English one never matches a
 * Scottish region.
 */
export function seasonRegionFor(profile: { country: string | null; region: string | null }, table: SeasonTable): string | null {
  if (normalizeCountry(profile.country) === null) return null;
  const region = profile.region === null ? null : normalizePhrase(profile.region) || null;
  const hits = Object.keys(table).filter((id) => accepts(table[id], profile.country, region));
  return hits.length === 1 ? hits[0] : null;
}

/** 1–12 from YYYY-MM-DD; throws on a bad date. */
export function monthOf(localDate: string): number {
  if (!isValidDate(localDate)) throw new Error(`monthOf: "${String(localDate)}" is not a YYYY-MM-DD date`);
  return Number(localDate.slice(5, 7));
}

function assertMonth(month: number, fn: string): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`${fn}: month ${String(month)} is not 1–12`);
}

/** The same country set, compared through `normalizeCountry`. */
function sameCountries(a: readonly string[], b: readonly string[]): boolean {
  const set = (l: readonly string[]) => [...new Set(l.map((c) => normalizeCountry(c) ?? ''))].sort().join('\n');
  return set(a) === set(b);
}

/**
 * The region, then its declared parents, each in the table and in the same country as the region asked for. A parent
 * in another country, missing from the table, or already seen (a cycle) ends the chain: never another country's data.
 */
function chainOf(regionId: string | null, table: SeasonTable): SeasonRegion[] {
  const first = regionId === null ? undefined : own(table, regionId);
  if (first === undefined) return [];
  const chain = [first];
  const seen = new Set([first.id]);
  for (let cur = first; cur.parent !== undefined; ) {
    const next = own(table, cur.parent);
    if (next === undefined || seen.has(next.id) || !sameCountries(next.match.countries, first.match.countries)) break;
    chain.push(next);
    seen.add(next.id);
    cur = next;
  }
  return chain;
}

/** The id and its isA ancestors, breadth first (as `stallFor`). An id the graph doesn't know is only itself. */
function selfAndKinds(id: string, graph: IngredientGraph): string[] {
  const out = [id];
  if (!graph.has(id)) return out;
  const queue = [...(graph.get(id).isA ?? [])];
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i];
    if (out.includes(cur)) continue;
    out.push(cur);
    if (graph.has(cur)) queue.push(...(graph.get(cur).isA ?? []));
  }
  return out;
}

type Season = { category: string; label: string; isNow: boolean };

/** The category this exact id is in for the region's month, in the region's declared order; null when none. */
function categoryIn(r: SeasonRegion, month: number, id: string): Season | null {
  const entry = own(r.months as Record<string, Record<string, string[]>>, String(month));
  if (entry === undefined) return null;
  for (const [i, c] of r.categories.entries()) {
    if (own(entry, c.id)?.includes(id)) return { category: c.id, label: c.label, isNow: i === 0 };
  }
  return null;
}

/**
 * The ingredient's category this month in this region: its own id first, then its isA ancestors breadth first (like
 * stallFor), then the region's `parent` the same way. null when the month has no entry or nothing matches: no note.
 * Throws on a month outside 1–12. Not a rules check: show the note only on an item the caller's `check` calls ✅.
 */
export function seasonOf(
  ingredientId: string | null,
  regionId: string | null,
  month: number,
  table: SeasonTable,
  graph: IngredientGraph,
): Season | null {
  assertMonth(month, 'seasonOf');
  if (ingredientId === null) return null;
  const ids = selfAndKinds(ingredientId, graph);
  for (const r of chainOf(regionId, table)) {
    for (const id of ids) {
      const hit = categoryIn(r, month, id);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * Wen's stall.seasonal[regionId][month], else the parent's, else []. Never another country's. A copy: the caller may
 * change it. These go to `stallBank` as its `seasonal` argument, which rules-checks each one like any question.
 */
export function seasonalQuestions(stall: StallFile, regionId: string | null, month: number, table: SeasonTable): StallQuestion[] {
  assertMonth(month, 'seasonalQuestions');
  for (const r of chainOf(regionId, table)) {
    const list = own(own(stall.seasonal, r.id), String(month));
    if (Array.isArray(list)) return [...list];
  }
  return [];
}

/**
 * The plan view's note: the dish's ingredient ids that are `isNow` this month, in recipe order. [] when no region.
 * Never a status: the caller still checks each id against the player's rules. A sacred dish gets no note (§10).
 */
export function dishSeason(recipe: ParsedRecipe, regionId: string | null, month: number, table: SeasonTable, graph: IngredientGraph): string[] {
  assertMonth(month, 'dishSeason');
  if (regionId === null || recipe.meta.sacred) return [];
  const out: string[] = [];
  for (const line of recipe.ingredients) {
    const id = graph.resolve(line.name);
    if (id !== null && !out.includes(id) && seasonOf(id, regionId, month, table, graph)?.isNow === true) out.push(id);
  }
  return out;
}

/**
 * The Season's Table note for one item, for the player: `seasonOf` for the month of ctx.date, but only when the item
 * itself is ✅ under ctx.rules (core `check`, no substitutions: an item a recipe could swap is still the item the
 * rules hit). ⛔, ❓ (including an id the graph doesn't know) and 🔁 items get null. Throws on a bad ctx.date.
 */
export function seasonNote(ingredientId: string | null, regionId: string | null, table: SeasonTable, ctx: MarketCtx): Season | null {
  const season = seasonOf(ingredientId, regionId, monthOf(ctx.date), table, ctx.graph);
  if (season === null || ingredientId === null) return null;
  return namedStatus([ingredientId], [], ctx) === 'ok' ? season : null;
}

/**
 * The plan view's note, for the player: `dishSeason` for the month of ctx.date, keeping only the ids that are ✅ under
 * ctx.rules (no substitutions). [] for no region or a sacred dish.
 */
export function dishSeasonNote(recipe: ParsedRecipe, regionId: string | null, table: SeasonTable, ctx: MarketCtx): string[] {
  return dishSeason(recipe, regionId, monthOf(ctx.date), table, ctx.graph).filter((id) => namedStatus([id], [], ctx) === 'ok');
}

/** A region as far as `accepts` needs it, when its match block has the right shape; else null. */
function matchable(r: unknown): SeasonRegion | null {
  if (!isObject(r) || !isObject(r.match)) return null;
  const { countries, regions } = r.match;
  if (!Array.isArray(countries) || !countries.every(isText) || !Array.isArray(regions) || !regions.every((x) => typeof x === 'string')) return null;
  return r as unknown as SeasonRegion;
}

/**
 * Every problem with a season table:
 * - an id not kebab-case (or not its own key);
 * - no sources;
 * - a `parent` not in the table or with a different `countries` list; a parent cycle;
 * - fewer than 2 or more than 5 categories;
 * - a month key outside 1–12;
 * - a category key the region doesn't declare;
 * - an ingredient id not in the graph;
 * - the same id in two categories of one month;
 * - two regions whose `match` both accept the same normalised (country, region) pair from a probe list built from all
 *   the table's own phrases (each phrase under each of the table's countries, plus no region at all). Two phrases
 *   joined ("washington oregon") are not probed: any two same-country regions would "overlap" on such a player.
 *   That would make `seasonRegionFor` null for those players. It is reported, never resolved by picking one;
 * - and the shape around them (status, name, an unknown country name, an empty region phrase, a duplicate category).
 */
export function validateSeasonTable(d: unknown, graph: IngredientGraph): string[] {
  if (!isObject(d)) return ['seasonality: not a map of regions'];
  const problems: string[] = [];

  for (const [key, r] of Object.entries(d)) {
    const say = (msg: string) => problems.push(`seasonality.${key}: ${msg}`);
    if (!isObject(r)) {
      say('not a map');
      continue;
    }
    if (!KEBAB.test(key)) say('id is not kebab-case');
    if (r.id !== key) say(`id "${String(r.id)}" is not its key`);
    if (!isText(r.name)) say('name is not a non-empty string');
    if (r.status !== 'draft' && r.status !== 'reviewed') say(`status "${String(r.status)}" is not draft or reviewed`);
    if (!Array.isArray(r.sources) || r.sources.length === 0) say('no sources');
    else if (!r.sources.every(isText)) say('sources: a source is not a non-empty string');

    if (!isObject(r.match)) say('match is not a map');
    else {
      const { countries, regions } = r.match;
      if (!Array.isArray(countries) || countries.length === 0) say('match.countries: no countries');
      else
        for (const c of countries) {
          if (!isText(c)) say('match.countries: not a non-empty string');
          else if (!isKnownCountry(c)) say(`match.countries: "${c}" is not a known country name`);
        }
      if (!Array.isArray(regions)) say('match.regions is not a list');
      else
        for (const ph of regions) {
          if (typeof ph !== 'string' || normalizePhrase(ph) === '') say(`match.regions: region phrase ${JSON.stringify(ph)} is empty once normalised`);
        }
    }

    if (r.parent !== undefined) {
      const parent = typeof r.parent === 'string' ? own(d, r.parent) : undefined;
      if (typeof r.parent !== 'string' || !isObject(parent)) say(`parent ${JSON.stringify(r.parent)} is not in the table`);
      else if (r.parent === key) say('parent is itself');
      else {
        const mine = matchable(r)?.match.countries;
        const theirs = matchable(parent)?.match.countries;
        if (mine === undefined || theirs === undefined || !sameCountries(mine, theirs))
          say(`parent "${r.parent}" has different countries (Ruling 9: a parent is the same country)`);
      }
    }

    const declared = new Set<string>();
    if (!Array.isArray(r.categories)) say('categories is not a list');
    else {
      if (r.categories.length < 2 || r.categories.length > 5) say(`has ${r.categories.length} categories; a region declares 2–5 categories`);
      const labels = new Set<string>();
      for (const c of r.categories as unknown[]) {
        if (!isObject(c) || typeof c.id !== 'string' || !CATEGORY_ID.test(c.id) || !isText(c.label)) {
          say(`categories: ${JSON.stringify(c)} is not { id: snake_case, label: text }`);
          continue;
        }
        if (declared.has(c.id)) say(`duplicate category id "${c.id}"`);
        if (labels.has(c.label)) say(`duplicate category label "${c.label}"`);
        if (c.label.includes('!') || PRESSURE_WORDS.test(normalizePhrase(c.label))) say(`category label "${c.label}" uses deadline or scarcity words`);
        declared.add(c.id);
        labels.add(c.label);
      }
    }

    if (!isObject(r.months)) say('months is not a map');
    else {
      for (const [m, entry] of Object.entries(r.months)) {
        if (!MONTH_KEY.test(m)) {
          say(`month "${m}" is not a month 1–12`);
          continue;
        }
        if (!isObject(entry)) {
          say(`months.${m}: not a map of categories`);
          continue;
        }
        const placed = new Map<string, string>();
        for (const [cat, ids] of Object.entries(entry)) {
          if (!declared.has(cat)) say(`months.${m}: category "${cat}" is not declared by the region`);
          if (!Array.isArray(ids)) {
            say(`months.${m}.${cat}: not a list of ingredient ids`);
            continue;
          }
          for (const id of ids as unknown[]) {
            if (typeof id !== 'string' || !graph.has(id)) {
              say(`months.${m}.${cat}: "${String(id)}" is not in the ingredient graph`);
              continue;
            }
            const before = placed.get(id);
            if (before !== undefined) say(`months.${m}: "${id}" is in two categories (${before}, ${cat})`);
            else placed.set(id, cat);
          }
        }
      }
    }
  }

  // Parent cycles, each reported once.
  const cycles = new Set<string>();
  for (const start of Object.keys(d)) {
    const path: string[] = [];
    for (let cur: string | undefined = start; cur !== undefined; ) {
      const at = path.indexOf(cur);
      if (at >= 0) {
        const loop = path.slice(at);
        const k = [...loop].sort().join(',');
        if (!cycles.has(k)) {
          cycles.add(k);
          problems.push(`seasonality: parent cycle ${[...loop, cur].join(' → ')}`);
        }
        break;
      }
      path.push(cur);
      const r: unknown = own(d, cur);
      cur = isObject(r) && typeof r.parent === 'string' ? r.parent : undefined;
    }
  }

  // Overlapping matches, probed with the table's own phrases.
  const regions = Object.entries(d)
    .map(([id, r]) => [id, matchable(r)] as const)
    .filter((e): e is readonly [string, SeasonRegion] => e[1] !== null);
  const phrases = [...new Set(regions.flatMap(([, r]) => r.match.regions.map(normalizePhrase)).filter((ph) => ph !== ''))];
  const probeRegions: (string | null)[] = [null, ...phrases];
  const countries = [...new Set(regions.flatMap(([, r]) => r.match.countries))];
  const reported = new Set<string>();
  for (const c of countries) {
    for (const ph of probeRegions) {
      const hits = regions.filter(([, r]) => accepts(r, c, ph)).map(([id]) => id);
      for (let i = 0; i < hits.length; i++) {
        for (let j = i + 1; j < hits.length; j++) {
          const pair = [hits[i], hits[j]].sort();
          const k = pair.join('\n');
          if (reported.has(k)) continue;
          reported.add(k);
          problems.push(
            `seasonality: regions ${pair[0]} and ${pair[1]} both match country "${c}", region ${ph === null ? '(none)' : `"${ph}"`}; ` +
              'such a player would get no season',
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Cross-check (Ruling 9): every seasonal question's correct option text equals the label of the category the table
 * gives its `contains[0]` for that region and month, and every option text is one of that region's category labels
 * (plus an optional "Depends: ask the farmer"-style label the region declares). Wen's seasonal blocks must name
 * regions that are in the table.
 *
 * The lookup is by the exact id (no graph here), in the region and then its same-country parents, as seasonOf. A
 * "depends" label is declared as one of the region's own categories. A non-month key under a region (Wen's old
 * `fallback:`) is `validateStallFile`'s to report, not this.
 */
export function seasonalAgrees(stall: StallFile, table: SeasonTable): string[] {
  const problems: string[] = [];
  for (const [regionId, months] of Object.entries(stall.seasonal ?? {})) {
    const at = `${stall.id}: seasonal.${regionId}`;
    const region = own(table, regionId);
    if (region === undefined) {
      problems.push(`${at}: region is not in the season table`);
      continue;
    }
    const labels = new Set(region.categories.map((c) => c.label));
    for (const [m, list] of Object.entries(months)) {
      if (!MONTH_KEY.test(m) || !Array.isArray(list)) continue;
      const month = Number(m);
      for (const q of list) {
        const where = `${at}.${m} ${q.id}`;
        for (const o of q.options) {
          if (!labels.has(o.text)) problems.push(`${where}: option "${o.text}" is not one of ${regionId}'s category labels`);
        }
        const first = q.contains?.[0];
        if (first === undefined) {
          problems.push(`${where}: names no ingredient (contains[0]) for the table to place`);
          continue;
        }
        let season: Season | null = null;
        for (const r of chainOf(regionId, table)) {
          season = categoryIn(r, month, first);
          if (season !== null) break;
        }
        if (season === null) {
          problems.push(`${where}: the table gives "${first}" no category in ${regionId} for month ${m}`);
          continue;
        }
        const correct = q.options.filter((o) => o.correct);
        if (correct.length === 0) problems.push(`${where}: no correct option`);
        for (const o of correct) {
          if (o.text !== season.label) problems.push(`${where}: correct option "${o.text}", but the table says "${season.label}" for "${first}"`);
        }
      }
    }
  }
  return problems;
}
