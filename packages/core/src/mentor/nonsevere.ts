import type { IngredientGraph } from '../ingredients/graph';
import { capText, normalizeTurn } from './intents';

/**
 * The closed grammar for non-severe severities (controller ruling, fix round 4). Intolerance
 * and preference are read only when the ENTIRE message is consumed by the templates below,
 * fillers and one exact negation clause aside. Any other word, a "?", a digit, any character
 * outside plain Latin letters and list punctuation, or an allergy stem anywhere → null.
 * Can't verify is never safe: a real intolerance said any other way is asked once.
 */

/** Words (and two-word fillers) that may appear anywhere and are ignored. */
export const NON_SEVERE_FILLERS: ReadonlySet<string> = new Set([
  'i', "i'm", 'im', 'i am', 'am', 'just', 'so', 'and', 'but', 'also', 'a', 'an', 'my', "it's", 'its', 'to', 'with', 'of',
  'the', 'have', 'got', 'quite', 'very', 'mildly', 'slightly', 'a bit',
]);
/**
 * The only negation clauses, matched token for token, at most one, first or last. None is a
 * one-word insertion into another ("not like an allergy", "is not an allergy" are not listed).
 */
export const NEGATION_CLAUSES: readonly string[] = [
  'not an allergy', 'not allergic', "isn't an allergy", 'isnt an allergy', 'no allergy', 'rather than an allergy',
];
/** Intolerance words: "<terms> intolerant", "intolerant to <terms>", "<terms> intolerance", … */
const INTOLERANCE_WORDS = ['intolerant', 'intolerance', 'intolerances'];
const DIGEST_WORDS = ["can't digest", 'cant digest', 'cannot digest', 'can not digest'];
/** "I don't like <terms>", "I prefer not to eat <terms>", … */
const PREFERENCE_PREFIXES = [
  "don't like", 'dont like', 'do not like', 'dislike', 'prefer not to eat', 'prefer not to have', 'prefer to avoid',
  "i'd rather not eat", "i'd rather not have", 'id rather not eat', 'id rather not have', 'would rather not eat',
  'would rather not have', 'not a fan of',
];
const AVOID = 'avoid';
const BY_CHOICE = 'by choice';
/** Diet words that are a preference by their own meaning ("I'm vegetarian", "vegan diet", "I keep halal"). */
const PREFERENCE_DIET_WORDS = ['vegetarian', 'veggie', 'vegan', 'plant-based', 'plant based', 'pescatarian', 'pescetarian', 'halal', 'kosher'];
const DIET_MODIFIERS = ['strict', 'strictly', 'fully', 'totally', 'keep'];
const DIET_SUFFIX = 'diet';
/** "or" joins terms only; "and" is a filler. */
const TERM_SEPARATORS = ['or'];

/** Every character a consumed message may hold: lower-case Latin letters, spaces, apostrophes, list punctuation. */
const ALLOWED_CHARS = /^[a-z' ,.!;:&/+\-–—]*$/;
/** Punctuation that ends a phrase: no fixed phrase or term spans it ("no, allergy" is not "no allergy"). */
const PHRASE_BREAK = /[,.!;:&/+–—]|\s-\s|^-\s|\s-$/;
const SEGMENT_SPLIT = new RegExp(PHRASE_BREAK.source, 'g');
const WORD = /^[a-z]+(?:['-][a-z]+)*$/;
/** Allergy and anaphylaxis stems on letters-only text (ruling 4): misspellings included. */
export const ALLERGY_STEMS = /lerg|alerg|anaph|anaf[iy]l/;
const MAX_PHRASE = 4;

type Sym = 'term' | 'intol' | 'digest' | 'prefix' | 'avoid' | 'choice' | 'diet' | 'mod' | 'suffix' | 'sep' | 'neg' | 'fill';
const SYM_CHAR: Readonly<Record<Exclude<Sym, 'fill' | 'neg'>, string>> = {
  term: 't', intol: 'i', digest: 'd', prefix: 'p', avoid: 'a', choice: 'b', diet: 'g', mod: 'm', suffix: 'w', sep: 's',
};
const TERMS = 't(?:s?t)*';
const INTOLERANCE_SHAPE = new RegExp(`^(?:${TERMS}i|i${TERMS}|d${TERMS})+$`);
const PREFERENCE_SHAPE = new RegExp(`^(?:p${TERMS}|a${TERMS}b|m?gw?)+$`);

/** Fixed phrases by symbol; tried longest first, then in this order. */
const PHRASES: readonly [Sym, readonly string[]][] = [
  ['neg', NEGATION_CLAUSES],
  ['intol', INTOLERANCE_WORDS],
  ['digest', DIGEST_WORDS],
  ['prefix', PREFERENCE_PREFIXES],
  ['avoid', [AVOID]],
  ['choice', [BY_CHOICE]],
  ['diet', PREFERENCE_DIET_WORDS],
  ['mod', DIET_MODIFIERS],
  ['suffix', [DIET_SUFFIX]],
  ['sep', TERM_SEPARATORS],
];

interface Piece {
  sym: Sym;
  text: string;
}

/** One punctuation-free stretch as pieces, longest phrase first at each token; null on any token no piece covers. */
function piecesOf(tokens: readonly string[], graph: IngredientGraph | undefined): Piece[] | null {
  const out: Piece[] = [];
  let i = 0;
  while (i < tokens.length) {
    let best: { sym: Sym; len: number } | null = null;
    for (let len = Math.min(MAX_PHRASE, tokens.length - i); len >= 1 && best === null; len--) {
      const phrase = tokens.slice(i, i + len).join(' ');
      const fixed = PHRASES.find(([, list]) => list.includes(phrase));
      if (fixed) best = { sym: fixed[0], len };
      else if (graph !== undefined && graph.resolve(phrase) !== null) best = { sym: 'term', len };
      else if (NON_SEVERE_FILLERS.has(phrase)) best = { sym: 'fill', len };
    }
    if (best === null) return null; // a leftover token
    out.push({ sym: best.sym, text: tokens.slice(i, i + best.len).join(' ') });
    i += best.len;
  }
  return out;
}

export interface NonSevereReading {
  severity: 'intolerance' | 'preference';
  /** Each term and diet word, as said, in order. */
  terms: string[];
  /** Whether a template other than a diet word matched (a diet word is not a severity word). */
  stated: boolean;
}

/**
 * The non-severe severity the whole message states, or null. `graph` recognises the terms;
 * without it only a diet word can be read. A message cut at MAX_TEXT is never consumed.
 */
export function readNonSevere(text: string, graph?: IngredientGraph): NonSevereReading | null {
  if (capText(text) !== text) return null;
  const t = normalizeTurn(text);
  if (!ALLOWED_CHARS.test(t)) return null; // "?", digits, accents, other scripts, emoji, brackets
  const pieces: Piece[] = [];
  for (const segment of t.split(SEGMENT_SPLIT)) {
    const tokens = segment.split(/\s+/).filter((w) => w !== '');
    if (!tokens.every((w) => WORD.test(w))) return null;
    const found = piecesOf(tokens, graph);
    if (found === null) return null;
    pieces.push(...found.filter((p) => p.sym !== 'fill'));
  }
  if (pieces.length === 0) return null;
  const negs = pieces.flatMap((p, i) => (p.sym === 'neg' ? [i] : []));
  if (negs.length > 1 || (negs.length === 1 && negs[0] !== 0 && negs[0] !== pieces.length - 1)) return null;
  const body = pieces.filter((p) => p.sym !== 'neg');
  if (ALLERGY_STEMS.test(body.map((p) => p.text).join('').replace(/[^a-z]+/g, ''))) return null;
  const shape = body.map((p) => SYM_CHAR[p.sym as keyof typeof SYM_CHAR]).join('');
  const terms = body.filter((p) => p.sym === 'term' || p.sym === 'diet').map((p) => p.text);
  if (INTOLERANCE_SHAPE.test(shape)) return { severity: 'intolerance', terms, stated: true };
  if (PREFERENCE_SHAPE.test(shape)) return { severity: 'preference', terms, stated: /[pa]/.test(shape) };
  return null;
}
