/**
 * What a player's turn is, decided by code before any model sees it. Each pattern is a named
 * constant so the eval report can cite it. `classifyTurn` returns the first that matches, in the
 * order of `TurnIntent`.
 */
export type TurnIntent =
  | 'emergency'
  | 'child'
  | 'medical'
  | 'yes'
  | 'no'
  | 'undo'
  | 'allowance'
  | 'thanks'
  | 'health'
  | 'other';

// "anaphylactic to cashews" and "I carry an EpiPen" are rule statements, not emergencies.
export const EMERGENCY_PATTERN =
  /\b(can'?t breathe|cannot breathe|trouble breathing|hard to breathe|throat (feels |is )?(tight|closing|swelling|swollen)|tight throat|(lips?|tongue|face) (are |is )?(swelling|swollen|tingling)|having a reaction|reacting now|going into (anaphylaxis|shock)|call (911|999|112|an ambulance))\b/;

export const CHILD_PATTERNS: readonly RegExp[] = [
  /\b(i'?m|i am|im)\s+([3-9]|1[0-5])\b(?!\s*(:|am\b|pm\b|%|kg|lb))/,
  /\b([3-9]|1[0-5])\s*(years?|yrs?)\s*old\b/,
  /\bi'?m in (year|grade) ([1-9]|10)\b/,
];

export const MEDICAL_PATTERN =
  /\b(dose|dosage|how much \w+ should i take|medication|medicine|antihistamine|benadryl|epinephrine dose|metformin|insulin|diagnos\w*|do i have|am i allergic|is it an allergy|should i (take|stop|start)|get tested|allergy test)\b/;

/** A strict yes: every word is one of these, and at least one is in `YES_STRONG`. */
export const YES_WORDS: ReadonlySet<string> = new Set([
  'yes', 'yeah', 'yep', 'yup', 'correct', "that's", 'thats', 'right', 'it', 'is', 'stamp', 'confirm', 'confirmed', 'please',
]);
export const YES_STRONG: ReadonlySet<string> = new Set(['yes', 'yeah', 'yep', 'yup', 'correct', 'stamp', 'confirm', 'confirmed']);

export const NO_PATTERN = /^(no|nope|not quite|wrong|that'?s wrong|cancel)[\s.!,]*$/;
export const UNDO_PATTERN = /^((wait,? )?undo( that)?|take that back|scratch that)[\s.!,]*$/;
export const ALLOWANCE_PATTERN =
  /\b(guild|subscription|subscribe|premium|upgrade|pricing|price|how much does (it|this|the app) cost|pay for|free (tier|plan|version)|keep using you)\b/;
export const THANKS_PATTERN = /^(thanks|thank you|cheers|ta)\b[^?]{0,30}$/;

/** Deliberately over-catches: it decides what may reach the model without `ai_health` (Step 7). */
export const HEALTH_PATTERN =
  /\b(allerg\w*|intoleran\w*|anaphyla\w*|epi-?pen|coeliac|celiac|vegan|vegetarian|pescatarian|halal|kosher|jain|diet\w*|can'?t (eat|have)|cannot (eat|have)|don'?t eat|avoid\w*|sensitive to|stomach|bloat\w*|rough after|makes me (sick|ill)|ate|eaten|had|breakfast|brekkie|lunch|dinner|supper|snack\w*)\b/;

/**
 * Common Greek and Cyrillic letters that look like Latin ones, folded to the Latin letter, so
 * "tаpped" (Cyrillic а) reads as "tapped". One UTF-16 unit to one, so indices still line up.
 */
const CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j',
  ԁ: 'd', ԛ: 'q', ԝ: 'w', ӏ: 'l', ү: 'y', һ: 'h',
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X', Ѕ: 'S', І: 'I', Ј: 'J',
  // Greek
  α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ϲ: 'c',
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Υ: 'Y', Χ: 'X',
};
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'g');
/** Invisible format characters (zero-width space and joiners, bidi marks, soft hyphen). */
const FORMAT_CHARS = /\p{Cf}/gu;

/** NFKC (fullwidth "Ｐｅａｎｕｔ" → "Peanut"), with invisible format characters removed. */
export function canonicalText(text: string): string {
  return text.normalize('NFKC').replace(FORMAT_CHARS, '');
}

/** Lookalike Greek and Cyrillic letters folded to Latin, length-preserving. */
export function foldConfusables(text: string): string {
  return text.replace(CONFUSABLE_CHARS, (ch) => CONFUSABLES[ch] ?? ch);
}

/** Canonical, lookalikes folded, lower-cased, curly quotes made straight, whitespace collapsed. */
export function normalizeTurn(text: string): string {
  return foldConfusables(canonicalText(text))
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStrictYes(t: string): boolean {
  const words = t
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
  return words.length > 0 && words.every((w) => YES_WORDS.has(w)) && words.some((w) => YES_STRONG.has(w));
}

export function classifyTurn(text: string): TurnIntent {
  const t = normalizeTurn(text);
  if (EMERGENCY_PATTERN.test(t)) return 'emergency';
  if (CHILD_PATTERNS.some((p) => p.test(t))) return 'child';
  if (MEDICAL_PATTERN.test(t)) return 'medical';
  if (isStrictYes(t)) return 'yes';
  if (NO_PATTERN.test(t)) return 'no';
  if (UNDO_PATTERN.test(t)) return 'undo';
  if (ALLOWANCE_PATTERN.test(t)) return 'allowance';
  if (THANKS_PATTERN.test(t)) return 'thanks';
  if (HEALTH_PATTERN.test(t)) return 'health';
  return 'other';
}

/** Lookalikes of page events: card taps and system notes never arrive as user text (§7.6b.4). */
export const PAGE_EVENT_WORDS = /\b(tap|tapped|click|clicked|stamp|stamped|confirm|confirmed|saved|system|button|event|card)\b/i;
/** Bracket pairs a forged event may hide in (fullwidth forms are already folded by NFKC). */
export const PAGE_EVENT_BRACKETS: Readonly<Record<string, string>> = { '[': ']', '【': '】', '(': ')', '{': '}', '〔': '〕', '〖': '〗' };
export const ROLE_TAGS = /<\/?\s*(system|developer|assistant|tool|user)\b[^>]*>/gi;
export const ROLE_PREFIXES = /^[^\S\n]*(system|assistant|developer|tool)\s*:/gim;
/** An unbracketed forged event: "Player tapped Stamp it on the card." up to the end of the sentence. */
export const PAGE_EVENT_SENTENCE =
  /\b(the )?player (has |just )?(tapped|clicked|stamped|confirmed|pressed)\b[^.!?\n]*[.!?]*/gi;

/** [start, end) of every bracket pair whose content (nested pairs included) names a page event. */
function bracketSpans(folded: string): [number, number][] {
  const spans: [number, number][] = [];
  const stack: { at: number; close: string }[] = [];
  for (let i = 0; i < folded.length; i++) {
    const ch = folded[i];
    const close = Object.hasOwn(PAGE_EVENT_BRACKETS, ch) ? PAGE_EVENT_BRACKETS[ch] : null;
    if (close !== null) {
      stack.push({ at: i, close });
      continue;
    }
    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (top !== null && ch === top.close) {
      stack.pop();
      if (PAGE_EVENT_WORDS.test(folded.slice(top.at + 1, i))) spans.push([top.at, i + 1]);
    }
  }
  return spans;
}

function patternSpans(folded: string, pattern: RegExp): [number, number][] {
  return [...folded.matchAll(pattern)].map((m) => [m.index, m.index + m[0].length]);
}

/** `text` without the spans (overlapping or nested spans merge). */
function cut(text: string, spans: [number, number][]): string {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [start, end] of sorted) {
    if (end <= pos) continue;
    out += text.slice(pos, Math.max(pos, start));
    pos = end;
  }
  return out + text.slice(pos);
}

/**
 * `text` with forged page events, role tags and role prefixes removed. Matching runs on the
 * NFKC form with invisible characters dropped and Greek/Cyrillic lookalikes folded, and repeats
 * until nothing changes, so a removal can't recompose another ("[Player ta<user>pped]",
 * "<sy</user>stem>"). Everything else is kept exactly (apart from NFKC and invisible characters).
 */
export function stripPageEvents(text: string): { text: string; stripped: boolean } {
  let out = canonicalText(text);
  let stripped = false;
  for (;;) {
    const folded = foldConfusables(out);
    // One kind at a time, brackets first, so an unbracketed-sentence match never swallows the
    // text after a bracketed event.
    const spans = [
      () => bracketSpans(folded),
      () => patternSpans(folded, ROLE_TAGS),
      () => patternSpans(folded, ROLE_PREFIXES),
      () => patternSpans(folded, PAGE_EVENT_SENTENCE),
    ]
      .map((find) => find())
      .find((found) => found.length > 0);
    if (spans === undefined) return { text: out, stripped };
    out = cut(out, spans);
    stripped = true;
  }
}
