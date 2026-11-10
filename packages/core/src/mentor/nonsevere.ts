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
/** "and" / "or" join two terms of one stretch; anywhere else they are fillers (fix round 5). */
const TERM_SEPARATORS = ['and', 'or'];

/** Every character a consumed message may hold: lower-case Latin letters, spaces, apostrophes, list punctuation. */
const ALLOWED_CHARS = /^[a-z' ,.!;:&/+\-–—]*$/;
/**
 * Punctuation is a break in the shape: no phrase or term spans one ("no, allergy" is not "no
 * allergy"). `.` for a sentence end `[.!;]`, `,` for a list break `, : / + & – —` or a spaced
 * dash. A run of breaks is one break, a sentence end if it holds one (fix round 5).
 */
const BREAK_RUN = /(?:\s*(?:[,.!;:&/+–—]|(?:^|\s)-(?=\s|$)))+\s*/g;
const SENTENCE_END = /[.!;]/;
const WORD = /^[a-z]+(?:['-][a-z]+)*$/;
/** Allergy and anaphylaxis stems on letters-only text (ruling 4): misspellings included. */
export const ALLERGY_STEMS = /lerg|alerg|anaph|anaf[iy]l/;
const MAX_PHRASE = 4;

type Sym = 'term' | 'intol' | 'digest' | 'prefix' | 'avoid' | 'choice' | 'diet' | 'mod' | 'suffix' | 'sep' | 'neg' | 'fill';
type ShapeSym = Exclude<Sym, 'fill' | 'neg'> | 'stop' | 'comma';
const SYM_CHAR: Readonly<Record<ShapeSym, string>> = {
  term: 't', intol: 'i', digest: 'd', prefix: 'p', avoid: 'a', choice: 'b', diet: 'g', mod: 'm', suffix: 'w', sep: 's',
  stop: '.', comma: ',',
};
/** Terms before a keyword: joined by and/or only ("milk and egg intolerance", never "peanuts, milk intolerant"). */
const TERMS_BEFORE = 't(?:st)*';
/** Terms after a keyword: a list ("intolerant to milk, eggs or soy"). */
const TERMS_AFTER = 't(?:,?s?t)*';
const INTOLERANCE_GROUP = `(?:${TERMS_BEFORE},?i|i,?${TERMS_AFTER}|d${TERMS_AFTER})`;
const PREFERENCE_GROUP = `(?:p,?${TERMS_AFTER}|a${TERMS_AFTER}b|m?gw?)`;
/** The whole message: groups of one class, each pair split by a break. */
const INTOLERANCE_SHAPE = new RegExp(`^${INTOLERANCE_GROUP}(?:[,.]${INTOLERANCE_GROUP})*$`);
const PREFERENCE_SHAPE = new RegExp(`^${PREFERENCE_GROUP}(?:[,.]${PREFERENCE_GROUP})*$`);

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
  sym: Sym | 'stop' | 'comma';
  text: string;
}
const isBreak = (p: Piece | undefined): boolean => p !== undefined && (p.sym === 'stop' || p.sym === 'comma');

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
  let at = 0;
  const addStretch = (stretch: string): boolean => {
    const tokens = stretch.split(/\s+/).filter((w) => w !== '');
    if (!tokens.every((w) => WORD.test(w))) return false;
    const found = piecesOf(tokens, graph);
    if (found === null) return false;
    const kept = found.filter((p) => p.sym !== 'fill');
    // "and" / "or" separate two terms of this stretch; anywhere else they are fillers.
    kept.forEach((p, i) => {
      if (p.sym !== 'sep' || (kept[i - 1]?.sym === 'term' && kept[i + 1]?.sym === 'term')) pieces.push(p);
    });
    return true;
  };
  for (const m of t.matchAll(BREAK_RUN)) {
    if (!addStretch(t.slice(at, m.index))) return null;
    pieces.push({ sym: SENTENCE_END.test(m[0]) ? 'stop' : 'comma', text: m[0] });
    at = m.index + m[0].length;
  }
  if (!addStretch(t.slice(at))) return null;
  // One negation clause, first or last, set aside with the break that joins it.
  const words = pieces.filter((p) => !isBreak(p));
  const negs = words.filter((p) => p.sym === 'neg');
  if (negs.length > 1 || (negs.length === 1 && negs[0] !== words[0] && negs[0] !== words[words.length - 1])) return null;
  const body = pieces.filter((p) => p.sym !== 'neg');
  while (isBreak(body[0])) body.shift();
  while (isBreak(body[body.length - 1])) body.pop();
  if (body.length === 0) return null;
  for (let i = body.length - 1; i > 0; i--) if (isBreak(body[i]) && isBreak(body[i - 1])) body.splice(i, 1);
  if (ALLERGY_STEMS.test(body.map((p) => p.text).join('').replace(/[^a-z]+/g, ''))) return null;
  const shape = body.map((p) => SYM_CHAR[p.sym as ShapeSym]).join('');
  const terms = body.filter((p) => p.sym === 'term' || p.sym === 'diet').map((p) => p.text);
  if (INTOLERANCE_SHAPE.test(shape)) return { severity: 'intolerance', terms, stated: true };
  if (PREFERENCE_SHAPE.test(shape)) return { severity: 'preference', terms, stated: /[pa]/.test(shape) };
  return null;
}
