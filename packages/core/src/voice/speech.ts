// M7 P2, Ruling 16: speech text and sentence chunks. The API alone runs these on scripted lines and read-backs before
// TTS; the voice service speaks chunks verbatim. Model text is never streamed or spoken (Ruling 16). Browser-safe.
import { stepPlainText } from '../recipe/steps';
import type { ParsedRecipe } from '../recipe/types';

/** Spelled letters: two or more single capitals joined by hyphens ("P-E-A-N-U-T"), as core `spell` writes them. */
const SPELLED = /(?<![\p{L}\p{N}-])\p{Lu}(?:-\p{Lu})+(?![\p{L}\p{N}-])/gu;
/** Emoji and their joiners, variation selectors, skin tones and keycaps. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu;

/**
 * Text as the Pan should say it: spelled letters spoken one by one ("P-E-A-N-U-T" → "P. E. A. N. U. T."), footnote
 * asterisks and emoji dropped, spacing tidied. Other words are unchanged.
 */
export function speechText(text: string): string {
  return text
    .replace(SPELLED, (m) => `${m.split('-').join('. ')}.`)
    .replace(/\*/g, '')
    .replace(EMOJI, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([.!?])[.]+/g, '$1')
    .trim();
}

/** Words before a full stop that never end a sentence: a single letter (spelled or an initial) and abbreviations. */
const NO_END = /(?:^|\s)(?:\p{L}|e\.g|i\.e|etc|mr|mrs|ms|dr|st|approx|tbsp|tsp|vs)\.$/iu;
const CLAUSE_BREAK = /[,;:]\s+|\s+[—–-]\s+/;
const FIRST_SENTENCE_MAX_WORDS = 6;

function sentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?]+(?=\s+|$)/g)) {
    const end = m.index + m[0].length;
    const piece = text.slice(start, end).trim();
    // "P. E. A." are one run: a letter-stop joins the next only when the next is a letter-stop too
    if (m[0] === '.' && NO_END.test(text.slice(start, end)) && /^\s+\p{L}\.(?:\s|$)/u.test(text.slice(end))) continue;
    if (piece !== '') out.push(piece);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest !== '') out.push(rest);
  return out;
}

/**
 * Speakable chunks: sentences, so the first can be voiced while the rest render. A first sentence over six words
 * splits once, at its first clause break (comma, semicolon, colon or dash), for a quicker first sound. "" → [].
 */
export function speechChunks(text: string): string[] {
  const all = sentences(text.replace(/\s+/g, ' ').trim());
  if (all.length === 0) return [];
  const [first, ...rest] = all;
  if (first.split(' ').length > FIRST_SENTENCE_MAX_WORDS) {
    const m = CLAUSE_BREAK.exec(first);
    if (m !== null) {
      const head = first.slice(0, m.index + m[0].trimEnd().length).trim();
      const tail = first.slice(m.index + m[0].length).trim();
      if (head !== '' && tail !== '' && /[\p{L}\p{N}]/u.test(head)) return [head, tail, ...rest];
    }
  }
  return all;
}

/** Step `step` (0-based, P12) of a recipe as plain text to speak; null when out of range. Canon only (Ruling 11). */
export function stepSpeech(recipe: ParsedRecipe, step: number): string | null {
  if (!Number.isInteger(step) || step < 0 || step >= recipe.steps.length) return null;
  return stepPlainText(recipe, recipe.steps[step]);
}
