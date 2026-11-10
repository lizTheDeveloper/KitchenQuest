import type { Severity } from '../rules/types';
import type { IngredientGraph } from '../ingredients/graph';
import { capText, normalizeTurn, REACTION_STEM } from './intents';
import { readNonSevere } from './nonsevere';

/**
 * Deterministic parsers for what players type. Each pattern is a named constant so the eval
 * report can cite it. None of them guesses: what they can't read comes back null or empty.
 */

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'other'; // = M2 MEAL_WINDOW_NAMES
export const MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack', 'other'];

const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty',
] as const;
const HOUR_WORD = `(${NUMBER_WORDS.slice(1, 13).join('|')}|1[0-2]|0?[1-9])`;

const pad = (n: number): string => String(n).padStart(2, '0');
const hhmm = (h: number, m: number): string => `${pad(h)}:${pad(m)}`;

/** An hour word or digits 1–12 as a number, else null. */
function hourOf(word: string): number | null {
  const i = (NUMBER_WORDS as readonly string[]).indexOf(word);
  const n = i >= 0 ? i : /^\d+$/.test(word) ? Number(word) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

/** 12-hour clock to 24-hour: 12 am is 00, 12 pm is 12. */
const to24 = (h: number, meridiem: string): number => (h % 12) + (meridiem === 'pm' ? 12 : 0);

/** British "half seven" is half past seven. Am/pm unknown: the morning reading (twelve stays noon). */
export const CLOCK_HALF = new RegExp(`\\b(half past|half|quarter past|quarter to) ${HOUR_WORD}\\b(?:\\s*(am|pm)\\b)?`, 'g');
/** "18:30", "6:30 pm", "7.30pm", "19.30". Never after a currency sign or inside a longer number. */
export const CLOCK_COLON = /(?<![£$€\d.,])\b(\d{1,2})([:.])(\d{2})(?![\d]|[.,]\d)(?:\s*(am|pm)\b)?/g;
export const CLOCK_MERIDIEM = /\b(\d{1,2})\s*(?:ish)?\s*(am|pm)\b/g;
export const CLOCK_OCLOCK = new RegExp(`\\b${HOUR_WORD} ?o'?clock\\b(?:\\s*(am|pm)\\b)?`, 'g');
export const CLOCK_NAMED = /\b(noon|midday|midnight)\b/g;

const DAY_MINUTES = 24 * 60;
/** Hour (1–12) plus an offset in minutes, as HH:MM. Without am/pm, the morning reading, except 12. */
function clockAt(hour: number, offset: number, meridiem: string | undefined): string {
  let total = (meridiem === undefined ? hour : to24(hour, meridiem)) * 60 + offset;
  if (meridiem === undefined && total < 60) total += 12 * 60; // "quarter to one" is 12:45
  total = (total + DAY_MINUTES) % DAY_MINUTES;
  return hhmm(Math.floor(total / 60), total % 60);
}

const HALF_OFFSETS: Readonly<Record<string, number>> = { 'half past': 30, half: 30, 'quarter past': 15, 'quarter to': -15 };

function clockCandidates(t: string): { index: number; value: string | null }[] {
  const out: { index: number; value: string | null }[] = [];
  for (const m of t.matchAll(CLOCK_HALF)) {
    const h = hourOf(m[2]);
    out.push({ index: m.index, value: h === null ? null : clockAt(h, HALF_OFFSETS[m[1]], m[3]) });
  }
  for (const m of t.matchAll(CLOCK_COLON)) {
    const h = Number(m[1]);
    const min = Number(m[3]);
    const meridiem = m[4] as string | undefined; // the optional group
    let value: string | null = null;
    if (min <= 59) {
      if (meridiem !== undefined) value = h >= 1 && h <= 12 ? hhmm(to24(h, meridiem), min) : null;
      // "7.30" alone could be a price or an amount; a dot needs am/pm or a 24-hour hour.
      else if (m[2] === ':' || h >= 13) value = h <= 23 ? hhmm(h, min) : null;
    }
    out.push({ index: m.index, value });
  }
  for (const m of t.matchAll(CLOCK_MERIDIEM)) {
    const h = Number(m[1]);
    out.push({ index: m.index, value: h >= 1 && h <= 12 ? hhmm(to24(h, m[2]), 0) : null });
  }
  for (const m of t.matchAll(CLOCK_OCLOCK)) {
    const h = hourOf(m[1]);
    out.push({ index: m.index, value: h === null ? null : clockAt(h, 0, m[2]) });
  }
  for (const m of t.matchAll(CLOCK_NAMED)) out.push({ index: m.index, value: m[1] === 'midnight' ? '00:00' : '12:00' });
  return out;
}

/** The first clock time in `text` as 24-hour 'HH:MM', or null ("7ish" alone: am/pm unknown). */
export function parseClock(text: string): string | null {
  const found = clockCandidates(normalizeTurn(text))
    .filter((c): c is { index: number; value: string } => c.value !== null)
    .sort((a, b) => a.index - b.index);
  return found.length > 0 ? found[0].value : null;
}

/** 'HH:MM' plus 60 minutes, capped at '23:59' (a window never runs past midnight). */
export function windowEnd(start: string): string {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(start);
  if (!m) throw new Error(`windowEnd: "${start}" is not HH:MM`);
  const minutes = Math.min(Number(m[1]) * 60 + Number(m[2]) + 60, 23 * 60 + 59);
  return hhmm(Math.floor(minutes / 60), minutes % 60);
}

/** Weekday names and three-letter abbreviations, 0 = Sunday. */
export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
export const WEEKDAY_PATTERN =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|weekend|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat)s?\b/g;
/** Words a short weekday answer may hold besides the days ("sat and sun", "every fri"). */
const WEEKDAY_ANSWER_WORDS = new Set(['and', 'or', 'n', 'on', 'every', 'the', 'both', 'usually', 'mostly']);
const LIST_PUNCT = /[,/&+]/;

/** The weekday number(s) for one matched word: a name, an abbreviation or "weekend". */
export function weekdaysOf(word: string): number[] {
  if (word === 'weekend') return [0, 6];
  const i = WEEKDAY_NAMES.findIndex((n) => n === word || (word.length >= 3 && n.startsWith(word) && word.length <= 5));
  return i < 0 ? [] : [i];
}

const sortedUnique = (ns: number[]): number[] => [...new Set(ns)].sort((a, b) => a - b);

/**
 * Weekday names (any case, plurals, "weekend(s)") anywhere. A three-letter abbreviation counts
 * only in a short answer made of days ("sat and sun") or next to list punctuation ("fri, sat"),
 * so "I sat down", "mon dieu" and "wed like" name no day.
 */
export function parseWeekdays(text: string): number[] {
  const t = normalizeTurn(text);
  const matches = [...t.matchAll(WEEKDAY_PATTERN)];
  const words = t.split(/[^a-z']+/).filter((w) => w !== '');
  const dayWords = new Set(matches.map((m) => m[0]));
  const shortAnswer = words.every((w) => dayWords.has(w) || WEEKDAY_ANSWER_WORDS.has(w));
  const nextToList = (m: RegExpExecArray | RegExpMatchArray): boolean => {
    const before = t.slice(0, m.index).trimEnd();
    const after = t.slice(m.index! + m[0].length).trimStart();
    return LIST_PUNCT.test(before.slice(-1)) || LIST_PUNCT.test(after.charAt(0));
  };
  return sortedUnique(
    matches
      .filter((m) => WEEKDAY_NAMES.some((n) => m[1] === n) || m[1] === 'weekend' || shortAnswer || nextToList(m))
      .flatMap((m) => weekdaysOf(m[1])),
  );
}

export const COUNT_PATTERN = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORDS.join('|')}|a couple|most nights)\\b`);
/** "5-6", "5 to 6", "five or six": a range is not one count. */
export const COUNT_RANGE = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORDS.join('|')})\\s*(-|–|to|or)\\s*(\\d{1,2}|${NUMBER_WORDS.join('|')})\\b`);

/** A count 0–42 in digits or zero…twenty; "a couple" is 2 and "most nights" is 5; a range or anything else is null. */
export function parseCount(text: string): number | null {
  const t = normalizeTurn(text);
  if (COUNT_RANGE.test(t)) return null;
  const m = COUNT_PATTERN.exec(t);
  if (!m) return null;
  const w = m[1];
  if (w === 'a couple') return 2;
  if (w === 'most nights') return 5;
  const i = (NUMBER_WORDS as readonly string[]).indexOf(w);
  const n = i >= 0 ? i : Number(w);
  return n <= 42 ? n : null;
}

// Never a bare "no" (pre-flight C15): "no wait, …" removes nothing.
export const PANTRY_REMOVAL_PATTERNS: readonly RegExp[] = [
  /\b(finished|used up|ran out of|run out of|out of|chucked|threw out|binned) (the |my |our |some |any )?([a-z][a-z ]{0,30}?)\b(?=[,.!?]|$| and )/g,
  /\bno (more )?([a-z][a-z ]{0,30}?) left\b/g,
  /\bno more ([a-z][a-z ]{0,30}?)\b(?=[,.!?]|$| and )/g,
];

/** More items after a removal: "finished the milk and eggs", "ran out of rice, lentils and the oats". */
export const PANTRY_REMOVAL_MORE = /(?:\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*)(the |my |our |some |any )?([a-z][a-z ]{0,30}?)\b(?=[,.!?]|$| and )/y;
/** A continuation that is a new clause, not another item ("…and I bought eggs"). */
const NOT_AN_ITEM = /^(i|i'm|we|you|he|she|they|it|then|also|so|but|now|got|bought|have|had|just|oh|no|finished|used|ran|run|out|chucked|threw|binned)\b/;

const PRONOUN_ITEM = /^(it|them|that|this|those|these|one|some|all|everything|the lot|lot|both|stuff|the rest|rest)$/;
/** "finished them off", "used it all up", "no more of that", "the last of the milk": the words around an item. */
const itemOf = (raw: string): string =>
  raw
    .trim()
    .replace(/ left$/, '')
    .replace(/( all)? (off|up)$/, '')
    .replace(/^((the )?last of |of )(the |my |our |some |any )?/, '')
    .trim();

/** Items the player has used up, lower-cased, in the order they were said. */
export function parsePantryRemovals(text: string): string[] {
  const t = normalizeTurn(text);
  const found: { index: number; item: string }[] = [];
  for (const pattern of PANTRY_REMOVAL_PATTERNS) {
    for (const m of t.matchAll(pattern)) {
      const item = itemOf(m[m.length - 1]);
      if (item !== '') found.push({ index: m.index, item });
      // "a, b and c" is a list; "coffee, sadly" is not: comma items count only before an "and".
      let end = m.index + m[0].length;
      const more: { index: number; item: string; and: boolean }[] = [];
      const moreAt = (at: number) => {
        PANTRY_REMOVAL_MORE.lastIndex = at;
        return PANTRY_REMOVAL_MORE.exec(t);
      };
      for (let next = moreAt(end); next; next = moreAt(end)) {
        const nextItem = itemOf(next[2]);
        if (NOT_AN_ITEM.test(nextItem)) break;
        more.push({ index: end, item: nextItem, and: /\band\b|&/.test(next[0].slice(0, next[0].length - next[2].length)) });
        end += next[0].length;
      }
      const lastAnd = more.map((x) => x.and).lastIndexOf(true);
      found.push(...more.slice(0, lastAnd + 1));
    }
  }
  found.sort((a, b) => a.index - b.index);
  // "we finished it": a pronoun names no item (fix round 2).
  // E3: a symptom is never a pantry item.
  return [...new Set(found.map((f) => f.item))].filter((item) => item !== '' && !PRONOUN_ITEM.test(item) && !REACTION_STEM.test(item));
}

export const PANTRY_ADD_PATTERN =
  /\b(?:i'?ve got|i have got|i got|bought|picked up|add(?:ed)?)\s+([^.!?;]+?)(?:\s+to (?:the |my )?pantry)?\s*(?=[.!?;]|$)/g;
export const LIST_SPLIT = /\s*(?:,|&|\+|\band\b|\bor\b|\bn\b)\s*/;
const COUNT_WORDS = `(?:a couple of|couple of|a few|lots of|loads of|a bit of|\\d+(?:\\.\\d+)?|${NUMBER_WORDS.join('|')}|a|an|some|few)`;
const UNIT_WORDS =
  '(?:tins?|cans?|bags?|packs?|packets?|jars?|bottles?|boxes|box|bunch(?:es)?|heads?|cartons?|loaf|loaves|kg|g|grams?|kilos?|lbs?|pounds?|litres?|liters?|l|ml|dozen|handfuls?|pieces?|cloves?|blocks?)';
const LEADING_COUNT = new RegExp(`^${COUNT_WORDS}\\s+(?:${UNIT_WORDS}\\s+)?(?:of\\s+)?`);
const LEADING_UNIT = new RegExp(`^${UNIT_WORDS}\\s+(?:of\\s+)?`);

/** Items the player says they've added: "bought 2 tins chickpeas n a bag of spinach" → chickpeas, spinach. */
export function parsePantryAdds(text: string): string[] {
  const t = normalizeTurn(text);
  const out: string[] = [];
  for (const m of t.matchAll(PANTRY_ADD_PATTERN)) {
    for (const raw of m[1].split(LIST_SPLIT)) {
      const item = raw.trim().replace(LEADING_COUNT, '').replace(LEADING_UNIT, '').trim();
      // "I've got no eggs left" is a removal, never an add.
      // E3: "I got a rash on my arm", "i've got a swollen lip": a symptom is never a pantry item.
      if (item === '' || /^(no|none|nothing)\b/.test(item) || /\bleft$/.test(item) || REACTION_STEM.test(item)) continue;
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

/** "Not an allergy": it never sets a severity, it only makes a stated allergy conflicting. */
export const NOT_AN_ALLERGY = /\bnot (like |really |exactly |quite )?an? allergy\b|\bisn'?t (like )?an? allergy\b/;
/** Anaphylaxis words, devices and signs: any one raises every term (but a preference diet) to anaphylactic. */
export const ANAPHYLACTIC_CUE =
  /anaphyla|epi[- ]?pen|\bsevere|deadly|hospital|life[- ]threatening|adrenalin|epinephrin|auto-?injector|\bjext\b|\banapen\b|\bemerade\b|\ba&e\b|\ber\b|emergency|ambulance|\bicu\b|(nearly|almost) died|kill(s|ed)? me|\bdying\b|lethal|swollen|fatal|\bshock|can'?t breath|cannot breath|throat (closes|swells|closing|swelling)|swell(s|ing)? up|\bhives\b|wheez/;
/** Phrases in which an allergy word states no allergy; removed before `SEVERITY_PATTERNS` run. */
export const ALLERGY_NEGATIONS =
  /\b(not an allergy|not allergic|isn'?t an allergy|no allergy|not like an allergy|rather than an allergy)\b/g;

/** Message-wide severe levels from explicit words, earlier patterns win. Non-severe levels come only from `readNonSevere`. */
export const SEVERITY_PATTERNS: readonly [RegExp, Severity][] = [
  [ANAPHYLACTIC_CUE, 'anaphylactic'],
  [/\ballerg/, 'allergy'],
];

/**
 * Message-wide severity. A severe level from explicit words (`SEVERITY_PATTERNS`, read with
 * the `ALLERGY_NEGATIONS` phrases removed); intolerance or preference only when the whole
 * message is consumed by the closed grammar (`readNonSevere`, fix round 4), and never from a
 * diet word alone; else null. Symptoms set nothing. A message cut at MAX_TEXT states nothing.
 */
export function severityFromText(text: string, graph?: IngredientGraph): Severity | null {
  if (capText(text) !== text) return null;
  const t = normalizeTurn(text).replace(ALLERGY_NEGATIONS, ' ');
  for (const [pattern, severity] of SEVERITY_PATTERNS) if (pattern.test(t)) return severity;
  const reading = readNonSevere(text, graph);
  return reading?.stated ? reading.severity : null;
}

/**
 * Phrases a term list follows, each with the severity it states (null: none stated). The bare
 * forms need a colon or dash ("Allergies: peanuts", "allergic - peanuts").
 */
export const RULE_TRIGGER_PATTERN =
  /\b(?:(allergic to|allergy to|anaphylactic to|reactions? to|reacts? (?:badly |severely |strongly )?to|intolerant to|intolerance to|sensitive to|can'?t eat|cannot eat|can'?t have|cannot have|don'?t eat|do not eat|avoid)\b\s*[:\-–—]?|(allergic|allergies|allergy|intolerances|intolerance|intolerant)\s*[:\-–—])\s*/g;
/** "no allergies apart from peanuts", "allergic to nothing except peanuts": the list after the exception. */
export const RULE_EXCEPTION_PATTERN =
  /\b(allergies|allergy|allergic to (?:nothing|none)|intolerances)\b[^.;!?()]{0,40}?\b(?:except(?: for)?|apart from|other than|besides|save for|but)\s+/g;
/** "allergic to peanuts but only mildly to milk": a second list under the first trigger (it states no severity). */
export const RULE_ELLIPSIS_PATTERN = /\bbut\s+(?:only\s+|just\s+)?(?:(?:very\s+|really\s+)?\w+ly\s+)?(?:to|with)\s+/g;
/** "peanut allergy", "nut allergies", "lactose intolerance", "gluten intolerant": the words before name the term. */
export const RULE_BEFORE_PATTERN = /\b(allergy|allergies|intolerance|intolerances|intolerant)\b(?!\s*(?:to\b|[:\-–—]))/g;
/** "peanuts - allergic": a short note, term first, at the start of a clause. */
export const RULE_TERM_FIRST_PATTERN =
  /(?:^|[,.;!?:]\s*)((?:[a-z']+ ){0,2}[a-z']+)\s*[-–—]\s*(allergic|allergy|allergies|intolerant|intolerance)\b(?!\s*to\b)/g;
// "no pork" is reached only as this whole phrase, never as a bare "no".
export const DIET_WORD_PATTERN =
  /\b(vegetarian|veggie|vegan|plant-based|plant based|pescatarian|pescetarian|coeliac|celiac|gluten-free|gluten free|no pork|pork-free|pork free|halal|kosher|jain)\b/g;
/** Diet words that are a preference by their own meaning; the rest (coeliac, no pork…) state none. */
const PREFERENCE_DIETS = new Set(['vegetarian', 'veggie', 'vegan', 'plant-based', 'plant based', 'pescatarian', 'pescetarian', 'halal', 'kosher']);
/** "veggie" is a diet only with a rule cue ("I'm veggie", "veggie diet"), never "a veggie burger". */
const VEGGIE_CUE_BEFORE = /\b(i'?m|i am|im|we'?re|we are)\s+((a|fully|strictly|strict|totally|mostly)\s+)?$/;
const VEGGIE_CUE_AFTER = /^\s+diet\b/;
/** A match is skipped when one of these is among the three words before it in its clause. */
export const RULE_NEGATION = /\b(not|never|no|don'?t|do not|doesn'?t|does not|haven'?t|isn'?t|aren'?t|wasn'?t|ain'?t)\b/;
/** How far back a match looks for negation or term words: bounded, so parsing stays linear. */
const LOOK_BACK = 120;
/** Where a term list stops: a sentence or clause end. */
const TERM_STOP = /[.!?;()]/;
/** "e.g." would end the sentence; it is blanked first (same length, so indices hold). */
const EXAMPLE_ABBREVIATIONS = /\b(?:e\.g|i\.e)\.?(?=\s|,|$)/g;
/** Inside a term list these list examples, like a comma: "tree nuts e.g. cashews", "nuts like cashews". */
const EXAMPLE_WORDS = /\b(?:eg|ie|such as|including|especially|like)\b/g;
/** A list part starting with a subject pronoun is a new clause, not a term. */
const CLAUSE_START = /^(they|it|it's|that|this|he|she|we|you|i|i'm|i've)\b/;
/** "tree nuts are fine": a verb ends the term; "… is fine / ok" means it is not a rule at all. */
const PART_VERB = /\b(is|are|was|were|says|said|seems?)\b(.*)$/;
const VERB_WORDS = new Set(['is', 'are', 'was', 'were', 'says', 'said', 'seem', 'seems', 'thinks', 'told', 'reckons']);
const PERSON_CLAUSE = /^(my|his|her|our|their|your)\b/;
const NOT_A_RULE_AFTER_VERB = /^\s*(fine|ok|okay|safe|alright|all right|totally fine|no problem|not a problem)\b/;
/** A negation or exception inside a term list ends it. */
const SPAN_EXCEPT = /\b(not|never|except|apart from|other than|but not|no)\b.*$/;
/** Words that end the term list: "peanuts because they…" is just peanuts. */
const CLAUSE_END = /\b(because|but|so|since|as|which|if|when|though|although|just|please|thanks|and i|i'm|im|i)\b.*$/;
/** Words that are never a term by themselves (pronouns, quantities, adverbs, severity words). */
const NOT_A_TERM = new Set([
  'a', 'an', 'the', 'my', 'some', 'any', 'all', 'of', 'have', 'has', 'had', 'got', 'with', 'like', 'severe', 'severely',
  'mild', 'mildly', 'bad', 'badly', 'slight', 'slightly', 'serious', 'seriously', 'deadly', 'real', 'really', 'proper',
  'big', 'small', 'minor', 'major', 'very', 'super', 'quite', 'too', 'also', 'well', 'much', 'anymore', 'either', 'ever',
  'not', 'no', 'food', 'foods', 'i', "i'm", 'im', 'is', 'it', "it's", 'its', 'this', 'that', 'these', 'those', 'them',
  'they', 'anything', 'everything', 'something', 'nothing', 'none', 'stuff', 'things', 'thing', 'kind', 'sort', 'just',
  'at', 'eat', 'eating', 'allergy', 'allergies', 'allergic', 'intolerance', 'intolerant', 'sensitive', 'now', 'maybe',
  'actually', 'fine', 'ok', 'okay', 'only', 'though', 'lol', 'tbh', 'sadly', 'unfortunately', 'apparently', 'probably',
  'both', 'same', 'yes', 'ish', 'either', 'neither', 'af', 'smh', 'x',
]);
/** Words at the start of a term that are dropped ("the eggs", "a severe peanut"). */
const LEADING_FILLER = new Set([
  'a', 'an', 'the', 'my', 'some', 'any', 'all', 'of', 'really', 'very', 'super', 'mild', 'mildly', 'slightly', 'quite',
  'bad', 'badly', 'severe', 'severely', 'serious', 'seriously', 'deadly', 'real', 'proper', 'like', 'have', 'got', 'had',
  'has', 'with', 'big', 'small', 'minor', 'major', 'slight', 'food', 'not', 'no', 'i', "i'm", 'im', 'is', 'it', 'its',
  "it's", 'this', 'that', 'kind', 'sort', 'just', 'only', 'also', 'actually', 'maybe', 'now',
]);

function cleanTerm(raw: string): string {
  const words = raw
    .replace(CLAUSE_END, '')
    .replace(/[^a-z0-9' -]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ''))
    .filter((w) => w !== '');
  let start = 0;
  while (start < words.length && LEADING_FILLER.has(words[start])) start++;
  let end = words.length;
  while (end > start && NOT_A_TERM.has(words[end - 1])) end--; // "peanuts maybe", "tree nuts too"
  const kept = words.slice(start, end);
  return kept.every((w) => NOT_A_TERM.has(w)) ? '' : kept.join(' ');
}

/** The (up to) three words before `index` in its clause, looking back at most LOOK_BACK characters. */
function wordsBefore(t: string, index: number): string {
  const clause = t.slice(Math.max(0, index - LOOK_BACK), index).split(/[,.;!?:\n()]/).pop()!;
  return clause.trim().split(/\s+/).slice(-3).join(' ');
}
const negated = (t: string, index: number): boolean => RULE_NEGATION.test(wordsBefore(t, index));

/** The first value in sorted `xs` that is >= x, else `fallback` (binary search). */
function firstAtLeast(xs: readonly number[], x: number, fallback: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < xs.length ? xs[lo] : fallback;
}

/** The severity a trigger phrase states. */
function triggerSeverity(phrase: string): Severity | null {
  if (phrase.startsWith('anaphylactic')) return 'anaphylactic';
  if (phrase.startsWith('allerg') || phrase.startsWith('react')) return 'allergy'; // "reaction to" is severe-ish
  if (phrase.startsWith('intoleran')) return 'intolerance'; // "sensitive to" states none
  return null;
}

interface FoundTerm {
  index: number;
  term: string;
  severity: Severity | null;
  diet: boolean;
}

/** A place a term list starts: `keyword` is where its trigger word is, `from` where the list begins. */
interface ListStart {
  keyword: number;
  from: number;
  severity: Severity | null;
  negatable: boolean;
}

/**
 * Message-wide cues may keep or raise a stated severity, never lower it: an anaphylactic cue
 * raises every term but a preference diet. "Not an allergy" sets nothing; it makes a stated
 * allergy conflicting (null, so the card asks). Symptoms set nothing. Non-severe severities
 * are then voided (`parseRuleStatement`) unless the closed grammar consumed the message.
 */
function applyCues(items: FoundTerm[], t: string): void {
  const notAnAllergy = NOT_AN_ALLERGY.test(t);
  const anaphylactic = ANAPHYLACTIC_CUE.test(t);
  for (const item of items) {
    if (item.diet && item.severity === 'preference') continue;
    if (anaphylactic) item.severity = notAnAllergy ? null : 'anaphylactic';
    else if (notAnAllergy && (item.severity === 'allergy' || item.severity === 'anaphylactic')) item.severity = null;
  }
}

/** The terms in one list span, split and cleaned. */
function termsInSpan(span: string): string[] {
  const out: string[] = [];
  for (const raw of span.replace(CLAUSE_END, '').replace(EXAMPLE_WORDS, ',').split(LIST_SPLIT)) {
    let part = raw.trim();
    if (CLAUSE_START.test(part)) break; // ", they make me feel sick" is a new clause
    const verb = PART_VERB.exec(part);
    if (verb) {
      if (NOT_A_RULE_AFTER_VERB.test(verb[2])) continue; // "tree nuts are fine" is not a rule
      if (PERSON_CLAUSE.test(part)) break; // "my son is …", "my allergist says …": a new clause
      part = part.slice(0, verb.index);
    }
    const term = cleanTerm(part);
    if (term !== '') out.push(term);
  }
  return out;
}

/**
 * The ingredient or diet terms in a rule statement, each with the severity its own words state,
 * and the one severity they all share (null when they differ or none is stated: the card asks).
 * Terms come after "allergic to / intolerant to / can't eat / avoid …", after an exception
 * ("no allergies apart from …"), before "allergy / intolerance / intolerant", in a short note
 * ("peanuts - allergic"), or as a whole diet word. A negated match ("I don't have a peanut
 * allergy", "I'm not vegan") is skipped. Null when there are no terms. Linear in the input,
 * which is capped at MAX_TEXT.
 */
export function parseRuleStatement(
  text: string,
  graph?: IngredientGraph,
): { terms: string[]; severity: Severity | null; items: { term: string; severity: Severity | null }[] } | null {
  const capped = capText(text);
  const truncated = capped !== text;
  const t = normalizeTurn(capped.replace(/\r?\n/g, ' ; ')).replace(EXAMPLE_ABBREVIATIONS, (m) => ','.padEnd(m.length));
  const lists: ListStart[] = [];
  for (const m of t.matchAll(RULE_TRIGGER_PATTERN)) {
    const phrase: string | undefined = m[1]; // one of the two groups matched
    lists.push({ keyword: m.index, from: m.index + m[0].length, severity: triggerSeverity(phrase ?? m[2]), negatable: true });
  }
  for (const m of t.matchAll(RULE_EXCEPTION_PATTERN)) {
    lists.push({ keyword: m.index, from: m.index + m[0].length, severity: triggerSeverity(m[1]), negatable: false });
  }
  for (const m of t.matchAll(RULE_ELLIPSIS_PATTERN)) {
    lists.push({ keyword: m.index, from: m.index + m[0].length, severity: null, negatable: false });
  }
  const diets = [...t.matchAll(DIET_WORD_PATTERN)];
  const starts = [...lists.map((l) => l.keyword), ...diets.map((m) => m.index)].sort((a, b) => a - b);
  const found: FoundTerm[] = [];
  const add = (index: number, terms: string[], severity: Severity | null) => {
    for (const term of terms) found.push({ index, term, severity, diet: false });
  };

  for (const l of lists) {
    if (l.negatable && negated(t, l.keyword)) continue;
    const nextStart = firstAtLeast(starts, l.from, t.length);
    const stop = t.slice(l.from, nextStart).search(TERM_STOP);
    // "allergic to peanuts, not tree nuts": a negation or exception ends the list.
    const span = t.slice(l.from, stop < 0 ? nextStart : l.from + stop).replace(SPAN_EXCEPT, '');
    add(l.keyword, termsInSpan(span), l.severity);
  }

  for (const m of t.matchAll(RULE_BEFORE_PATTERN)) {
    const before = /((?:[a-z'-]+ ){0,3})$/.exec(t.slice(Math.max(0, m.index - LOOK_BACK), m.index))![1];
    const allWords = before.trim().split(' ').filter((w) => w !== '');
    // "my doctor said allergy": the words before a verb are not the term.
    let verbAt = -1;
    allWords.forEach((w, i) => {
      if (VERB_WORDS.has(w)) verbAt = i;
    });
    const words = allWords.slice(verbAt + 1);
    let start = words.length;
    while (start > 0 && !LEADING_FILLER.has(words[start - 1])) start--;
    const termWords = words.slice(start);
    if (termWords.length === 0) continue;
    const index = m.index - before.trimStart().length + allWords.slice(0, verbAt + 1 + start).join(' ').length + (verbAt + 1 + start > 0 ? 1 : 0);
    if (negated(t, index)) continue;
    const terms = termWords.join(' ').split(LIST_SPLIT).map(cleanTerm).filter((x) => x !== '');
    add(index, terms, m[1].startsWith('allerg') ? 'allergy' : 'intolerance');
  }

  for (const m of t.matchAll(RULE_TERM_FIRST_PATTERN)) {
    const keyword = m.index + m[0].length - m[2].length;
    const index = keyword - m[0].length + m[0].indexOf(m[1]);
    if (negated(t, index)) continue;
    const term = cleanTerm(m[1]);
    add(index, term === '' ? [] : [term], m[2].startsWith('allerg') ? 'allergy' : 'intolerance');
  }

  for (const m of diets) {
    const word = m[1];
    if (negated(t, m.index)) continue;
    if (word === 'veggie') {
      const before = t.slice(Math.max(0, m.index - LOOK_BACK), m.index);
      if (!VEGGIE_CUE_BEFORE.test(before) && !VEGGIE_CUE_AFTER.test(t.slice(m.index + word.length))) continue;
    }
    found.push({ index: m.index, term: word, severity: PREFERENCE_DIETS.has(word) ? 'preference' : null, diet: true });
  }

  applyCues(found, t);
  // Fix round 4: intolerance and preference only from the closed grammar, which consumed the
  // whole message; then its terms are the items. Anything else said non-severely is asked.
  const reading = truncated || ANAPHYLACTIC_CUE.test(t) ? null : readNonSevere(capped, graph);
  if (reading !== null) {
    found.length = 0;
    reading.terms.forEach((term, index) => found.push({ index, term, severity: reading.severity, diet: false }));
  }
  for (const f of found) if (reading === null && (f.severity === 'intolerance' || f.severity === 'preference')) f.severity = null;
  found.sort((a, b) => a.index - b.index);
  // A message cut at MAX_TEXT: the last term may be cut ("pea" of "peanuts") and the words
  // that set a severity may be lost, so the last term goes and every severity is asked.
  if (truncated) {
    found.pop();
    for (const f of found) f.severity = null;
  }
  if (found.length === 0) return null;
  // Items naming one ingredient ("milk" and "dairy") merge; said two ways, the severity is asked.
  const byKey = new Map<string, { term: string; severity: Severity | null }>();
  for (const f of found) {
    const key = graph?.resolve(f.term) ?? f.term;
    const same = byKey.get(key);
    if (!same) byKey.set(key, { term: f.term, severity: f.severity });
    else if (same.severity !== f.severity) same.severity = null; // said two ways: ask
  }
  const items = [...byKey.values()];
  const shared = new Set(items.map((i) => i.severity));
  return { terms: items.map((i) => i.term), severity: shared.size === 1 ? items[0].severity : null, items };
}

/** Breakfast before 11:00, lunch before 15:00, snack before 17:00, dinner before 22:00, else snack. */
export function slotForTime(hhmmText: string): MealSlot {
  if (hhmmText < '11:00') return 'breakfast';
  if (hhmmText < '15:00') return 'lunch';
  if (hhmmText < '17:00') return 'snack';
  if (hhmmText < '22:00') return 'dinner';
  return 'snack';
}

export const MEAL_VERB_PATTERN = /\b(?:had|ate|eaten)\b\s*:?\s*([^.!?]*)/;
export const MEAL_SLOT_PATTERN = /\b(?:for |at |with )?(?:my |a )?(breakfast|brekkie|lunch|dinner|supper|snack)\b\s*:?/g;
export const MEAL_YESTERDAY_PATTERN = /\b(yesterday|last night)\b/;
const MEAL_WHEN_WORDS = /\b(yesterday|last night|today|this morning|tonight|earlier|just now)\b/g;
const SLOT_WORD: Record<string, MealSlot> = {
  breakfast: 'breakfast', brekkie: 'breakfast', lunch: 'lunch', dinner: 'dinner', supper: 'dinner', snack: 'snack',
};
/** A new clause with its own subject: "… and also I'm allergic to kiwi", "… but my son had chips". */
export const MEAL_CLAUSE_SPLIT = /\s*,?\s+(?:(?:and|but|so|then|oh|also|now)\s+)+(?=(?:i|i'm|im|i've|ive|my|we|we're|we've)\b)/;
/** "I had pancakes, finished the milk": a pantry removal after the meal ends its description (fix round 3). */
const MEAL_REMOVAL_TAIL = /(?:\s*,\s*|\s+and\s+|\s+)(?:i\s+|we\s+|also\s+)?(?:finished|used up|ran out of|run out of|out of|chucked|threw out|binned|no more)\b.*$/;
const NOT_A_MEAL = /\b(allerg\w*|intoleran\w*|anaphyla\w*)\b/;
/** "had enough", "had a long day", "had a go": the verb, not a meal. */
export const NOT_FOOD =
  /^(?:to|no|nothing|none|enough|it|that|this|them|fun|time|trouble|an? allergy|(?:an? )?(?:allergic |bad |severe |mild |nasty )?reactions?|hives|(?:a )?rash|(?:some )?swelling|anaphyla\w*|a (severe|bad|mild)\b|a (go|look|think|chat|word|break|nap|rest|bath|shower|laugh|cry|feeling|try|sleep|lie-in|lie in|day off)\b|a (good|great|nice|long|rough|hard|busy|lovely|bad|quiet|tough) (day|time|night|week|morning|evening|sleep|chat|one))\b/;

/** "Had porridge with banana for breakfast." → the description, the slot named (if any), and the day. */
export function parseMealStatement(
  text: string,
): { description: string; slot: MealSlot | null; when: 'today' | 'yesterday' } | null {
  const t = normalizeTurn(text);
  const sentence = t.split(/[.!?]/).find((s) => MEAL_VERB_PATTERN.test(s));
  if (sentence === undefined) return null;
  // Step 9 (T11): "I had toast for breakfast and also I'm allergic to kiwi" is two statements; the
  // meal is read from its own clause, and an allergy word in that clause means it is no meal.
  const clause = sentence.split(MEAL_CLAUSE_SPLIT).find((c) => MEAL_VERB_PATTERN.test(c))!;
  if (NOT_A_MEAL.test(clause)) return null;
  let slot: MealSlot | null = null;
  for (const m of [...clause.matchAll(MEAL_SLOT_PATTERN), ...sentence.matchAll(MEAL_SLOT_PATTERN)]) {
    slot = SLOT_WORD[m[1]];
    break;
  }
  const m = MEAL_VERB_PATTERN.exec(clause)!;
  const description = m[1]
    .replace(MEAL_REMOVAL_TAIL, '')
    .replace(MEAL_SLOT_PATTERN, ' ')
    .replace(MEAL_WHEN_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '');
  // Fix round 2 (E3): a reaction or symptom word anywhere in the message means it is no meal ("toast, then my lips swelled").
  if (description === '' || NOT_FOOD.test(description) || REACTION_STEM.test(t)) return null;
  return { description, slot, when: MEAL_YESTERDAY_PATTERN.test(t) ? 'yesterday' : 'today' };
}
