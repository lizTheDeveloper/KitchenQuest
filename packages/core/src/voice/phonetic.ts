// M7 Ruling 4: phonetic keys and sound-alikes, so a heard card can offer the food a misheard word sounds like
// ("selfish" → shellfish, "pea cans" → pecan). Browser-safe: no I/O.
import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { isMajorAllergen } from '../mentor/route';
import type { RuleTerm } from '../mentor/rule-terms';
import { MAX_ALTERNATIVES } from './constants';

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);
const isVowel = (ch: string | undefined): boolean => ch !== undefined && VOWELS.has(ch);
const COMBINING_MARKS = /\p{M}+/gu;

/** NFKD, marks dropped, lower-cased, letters a–z only. */
function letters(word: string): string {
  return word.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/[^a-z]+/g, '');
}

/**
 * A Metaphone-style key: consonant sounds, with a vowel kept only as a leading 'A'. Two words that sound alike get
 * keys within one edit ("mussels" MSLS / "muscles" MSKLS, "celery" / "salary" SLR). Spaces are ignored, so a split
 * word keys like the whole one ("pea cans" / "pecans" PKNS).
 */
export function phoneticKey(word: string): string {
  let w = letters(word);
  if (w === '') return '';
  if (/^(kn|gn|pn|wr|ps)/.test(w)) w = w.slice(1);
  else if (w.startsWith('x')) w = `s${w.slice(1)}`;
  else if (w.startsWith('wh')) w = `w${w.slice(2)}`;
  let out = '';
  const push = (code: string): void => {
    if (!out.endsWith(code)) out += code;
  };
  for (let i = 0; i < w.length; i++) {
    const c = w[i];
    const prev = w[i - 1];
    const next = w[i + 1];
    const after = w[i + 2];
    // Doubled letters sound once (cc in "accent" excepted, which is rare in food words).
    if (c === prev && c !== 'c') continue;
    switch (c) {
      case 'a':
      case 'e':
      case 'i':
      case 'o':
      case 'u':
        if (i === 0) push('A');
        break;
      case 'b':
        if (!(prev === 'm' && i === w.length - 1)) push('P');
        break;
      case 'c':
        if (next === 'i' && after === 'a') push('X');
        else if (next === 'h') {
          push(prev === 's' ? 'K' : 'X');
          i++;
        } else if (next === 'i' || next === 'e' || next === 'y') push('S');
        else if (next === 'k') {
          push('K');
          i++;
        } else push('K');
        break;
      case 'd':
        if (next === 'g' && (after === 'e' || after === 'i' || after === 'y')) {
          push('J');
          i++;
        } else push('T');
        break;
      case 'g':
        if (next === 'h' && !isVowel(after) && i + 2 < w.length) i++;
        else if (next === 'h' && i + 2 >= w.length) i++;
        else if (next === 'n' && (i + 2 === w.length || w.slice(i + 2) === 'ed')) break;
        else if (next === 'e' || next === 'i' || next === 'y') push('J');
        else push('K');
        break;
      case 'h':
        if (isVowel(next) && !(i > 0 && 'csptg'.includes(prev))) push('H');
        break;
      case 'k':
        if (prev !== 'c') push('K');
        break;
      case 'p':
        if (next === 'h') {
          push('F');
          i++;
        } else push('P');
        break;
      case 'q':
        push('K');
        break;
      case 's':
        if (next === 'h') {
          push('X');
          i++;
        } else if (next === 'i' && (after === 'o' || after === 'a')) push('X');
        else push('S');
        break;
      case 't':
        if (next === 'i' && (after === 'o' || after === 'a')) push('X');
        else if (next === 'h') {
          push('0');
          i++;
        } else if (!(next === 'c' && after === 'h')) push('T');
        break;
      case 'v':
        push('F');
        break;
      case 'w':
      case 'y':
        if (isVowel(next)) push(c.toUpperCase());
        break;
      case 'x':
        push('K');
        out += 'S';
        break;
      case 'z':
        push('S');
        break;
      default:
        push(c.toUpperCase());
    }
  }
  return out;
}

/** Levenshtein distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next.push(Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}

/**
 * Mishearings phonetic keys miss, each always offered for its heard word (D2). Each cites the spike or covers at
 * least two non-holdout rows of the mishearing set, and none matches a holdout row (tested).
 */
export const KNOWN_CONFUSIONS: readonly { heard: string; id: string; cite: string | null }[] = Object.freeze([
  { heard: 'episodes', id: 'epazote', cite: 'spike §2' },
  { heard: 'episode', id: 'epazote', cite: 'spike §2' },
  { heard: 'peas', id: 'pecan', cite: null },
  { heard: 'lemons', id: 'lentil', cite: null },
]);

/** A sound-alike candidate: a graph id (or a rule term, as `term:<name>`) with its display name. */
interface Candidate {
  id: string;
  name: string;
  label: string;
  key: string;
}

const graphCandidates = new WeakMap<IngredientGraph, Candidate[]>();
const termCandidates = new WeakMap<readonly RuleTerm[], Candidate[]>();

const TERM_PREFIX = 'term:';
/** The id a rule term goes by in a heard card (`term:<name>`): it names no single graph ingredient. Internal. */
export const termId = (term: RuleTerm): string => `${TERM_PREFIX}${term.name}`;
/** A heard-card id that names a rule term, not a graph ingredient: never pass it to `IngredientGraph.get` (M5). */
export const isRuleTermId = (id: string): boolean => id.startsWith(TERM_PREFIX);

/**
 * Graph ids a heard card treats as allergens (fix round 1, I1): core `isMajorAllergen` (the EU's 14 and the US's 9,
 * their kinds and what contains them), plus bean.
 */
const allergenCache = new WeakMap<IngredientGraph, ReadonlySet<string>>();
function allergenIds(graph: IngredientGraph): ReadonlySet<string> {
  let s = allergenCache.get(graph);
  if (s === undefined) {
    const ids = new Set<string>();
    for (const label of graph.labels()) {
      const id = graph.resolve(label)!;
      if (id === 'bean' || isMajorAllergen(id, graph)) ids.add(id);
    }
    allergenCache.set(graph, (s = ids));
  }
  return s;
}

function candidatesOf(graph: IngredientGraph, terms: readonly RuleTerm[]): Candidate[] {
  let g = graphCandidates.get(graph);
  if (g === undefined) {
    g = graph.labels().map((label) => {
      const id = graph.resolve(label)!;
      return { id, name: graph.get(id).name, label, key: phoneticKey(label) };
    });
    graphCandidates.set(graph, g);
  }
  let t = termCandidates.get(terms);
  if (t === undefined) {
    t = terms.flatMap((term) => term.phrases.map((p) => ({ id: termId(term), name: term.name, label: normalizeName(p), key: phoneticKey(p) })));
    termCandidates.set(terms, t);
  }
  return [...g, ...t];
}

/** The word and, for a plural, its singular forms ("nots" → "not", "peaches" → "peach"). */
function forms(word: string): string[] {
  const out = [word];
  if (word.endsWith('ies') && word.length > 4) out.push(`${word.slice(0, -3)}y`);
  if (word.endsWith('es') && word.length > 3) out.push(word.slice(0, -2));
  if (word.endsWith('s') && !word.endsWith('ss') && word.length > 3) out.push(word.slice(0, -1));
  return out;
}

/** One ranked sound-alike: lower `rank` is closer. Known confusions rank first. */
export interface SoundAlike {
  id: string;
  name: string;
  /** Phonetic edit distance (−1 for a known confusion). */
  distance: number;
  /** Spelling distance over the longer length, to order equal phonetic distances. */
  spelling: number;
  /**
   * A major allergen the word is a phonetic neighbour of (fix round 1, I1): a known confusion, the same key, or one
   * edit for a word of four letters or more. These rank first after known confusions, and keep a stop word a term.
   */
  allergen: boolean;
}

/** Every sound-alike of `word`, ranked, each id once, the word's own resolution left out. Internal to heard.ts. */
export function rankSoundAlikes(word: string, graph: IngredientGraph, terms: readonly RuleTerm[]): SoundAlike[] {
  const w = normalizeName(word);
  if (letters(w).length < 3) return [];
  const own = new Set<string>();
  const resolved = graph.resolve(w);
  if (resolved !== null) own.add(resolved);
  for (const term of terms) if (term.phrases.some((p) => normalizeName(p) === w)) own.add(termId(term));

  const best = new Map<string, SoundAlike>();
  const allergens = allergenIds(graph);
  const long = letters(w).length >= 4;
  const offer = (s: SoundAlike): void => {
    if (own.has(s.id)) return;
    s.allergen = allergens.has(s.id) && (s.distance <= 0 || (s.distance === 1 && long));
    const cur = best.get(s.id);
    if (cur === undefined || s.distance < cur.distance || (s.distance === cur.distance && s.spelling < cur.spelling)) best.set(s.id, s);
  };
  const wordForms = forms(w);
  for (const c of KNOWN_CONFUSIONS) {
    if (wordForms.includes(c.heard) && graph.has(c.id)) offer({ id: c.id, name: graph.get(c.id).name, distance: -1, spelling: 0, allergen: false });
  }
  const keys = [...new Set(wordForms.map((f) => phoneticKey(f)))].filter((k) => k !== '');
  const joined = letters(w);
  for (const cand of candidatesOf(graph, terms)) {
    if (cand.key === '') continue;
    let distance = Infinity;
    for (const k of keys) {
      // A one-letter key matches only exactly: one edit from it reaches nearly anything.
      const d = Math.min(k.length, cand.key.length) <= 1 ? (k === cand.key ? 0 : Infinity) : editDistance(k, cand.key);
      distance = Math.min(distance, d);
    }
    if (distance > 1) continue;
    const label = letters(cand.label);
    offer({ id: cand.id, name: cand.name, distance, spelling: editDistance(joined, label) / Math.max(joined.length, label.length), allergen: false });
  }
  const tier = (s: SoundAlike): number => (s.distance < 0 ? 0 : s.allergen ? 1 : 2);
  return [...best.values()].sort((a, b) => tier(a) - tier(b) || a.distance - b.distance || a.spelling - b.spelling || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
}

/**
 * Major allergens whose name or alias (no digits) has exactly the phonetic key of `word`, for a word of any length
 * ("so" / soy, "it" / oat, "ok" / egg, "we" / whey): the short-word fail-safe (fix round 2, N2). Closest spelling first.
 */
export function allergenEchoes(word: string, graph: IngredientGraph): { id: string; name: string }[] {
  const key = phoneticKey(word);
  if (key === '') return [];
  const allergens = allergenIds(graph);
  const w = letters(word);
  const hits = new Map<string, number>();
  for (const label of graph.labels()) {
    if (/\d/.test(label) || phoneticKey(label) !== key) continue;
    const id = graph.resolve(label)!;
    if (!allergens.has(id)) continue;
    const l = letters(label);
    const d = editDistance(w, l) / Math.max(w.length, l.length);
    if (!hits.has(id) || d < hits.get(id)!) hits.set(id, d);
  }
  return [...hits]
    .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => ({ id, name: graph.get(id).name }));
}

/**
 * Foods (and rule terms) `word` sounds like, closest first, at most `max`: known confusions, then major allergens it
 * is a phonetic neighbour of, then the rest whose phonetic key is within one edit of the word's (or its singular's).
 * A rule term comes as `term:<name>` (`isRuleTermId`), not a graph id. The word's own food is never offered. A word under three
 * letters has none.
 */
export function soundAlikes(word: string, graph: IngredientGraph, terms: readonly RuleTerm[], max: number = MAX_ALTERNATIVES): { id: string; name: string }[] {
  return rankSoundAlikes(word, graph, terms)
    .slice(0, Math.max(0, max))
    .map(({ id, name }) => ({ id, name }));
}
