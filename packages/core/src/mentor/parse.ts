import type { Severity } from '../rules/types';
import { normalizeTurn } from './intents';

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

/** British "half seven" is half past seven. Am/pm unknown, so the morning reading, except twelve. */
export const CLOCK_HALF = new RegExp(`\\b(half|quarter past|quarter to) ${HOUR_WORD}\\b`, 'g');
export const CLOCK_COLON = /\b(\d{1,2}):(\d{2})(?:\s*(am|pm)\b)?/g;
export const CLOCK_MERIDIEM = /\b(\d{1,2})\s*(?:ish)?\s*(am|pm)\b/g;
export const CLOCK_NAMED = /\b(noon|midday|midnight)\b/g;

function clockCandidates(t: string): { index: number; value: string | null }[] {
  const out: { index: number; value: string | null }[] = [];
  for (const m of t.matchAll(CLOCK_HALF)) {
    const h = hourOf(m[2]);
    let value: string | null = null;
    if (h !== null) {
      if (m[1] === 'half') value = hhmm(h, 30);
      else if (m[1] === 'quarter past') value = hhmm(h, 15);
      else value = hhmm(h === 1 ? 12 : h - 1, 45);
    }
    out.push({ index: m.index, value });
  }
  for (const m of t.matchAll(CLOCK_COLON)) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    let value: string | null = null;
    if (min <= 59) {
      if (m[3] !== undefined) value = h >= 1 && h <= 12 ? hhmm(to24(h, m[3]), min) : null;
      else value = h <= 23 ? hhmm(h, min) : null;
    }
    out.push({ index: m.index, value });
  }
  for (const m of t.matchAll(CLOCK_MERIDIEM)) {
    const h = Number(m[1]);
    out.push({ index: m.index, value: h >= 1 && h <= 12 ? hhmm(to24(h, m[2]), 0) : null });
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
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat|weekend)s?\b/g;

/** The weekday number(s) for one matched word: a name, an abbreviation or "weekend". */
export function weekdaysOf(word: string): number[] {
  if (word === 'weekend') return [0, 6];
  const i = WEEKDAY_NAMES.findIndex((n) => n === word || n.slice(0, 3) === word);
  return i < 0 ? [] : [i];
}

const sortedUnique = (ns: number[]): number[] => [...new Set(ns)].sort((a, b) => a - b);

export function parseWeekdays(text: string): number[] {
  const t = normalizeTurn(text);
  return sortedUnique([...t.matchAll(WEEKDAY_PATTERN)].flatMap((m) => weekdaysOf(m[1])));
}

export const COUNT_PATTERN = new RegExp(`\\b(\\d{1,2}|${NUMBER_WORDS.join('|')}|a couple|most nights)\\b`);

/** A count 0–42 in digits or zero…twenty; "a couple" is 2 and "most nights" is 5; else null. */
export function parseCount(text: string): number | null {
  const m = COUNT_PATTERN.exec(normalizeTurn(text));
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

/** Items the player has used up, lower-cased, in the order they were said. */
export function parsePantryRemovals(text: string): string[] {
  const t = normalizeTurn(text);
  const found: { index: number; item: string }[] = [];
  for (const pattern of PANTRY_REMOVAL_PATTERNS) {
    for (const m of t.matchAll(pattern)) {
      const item = m[m.length - 1].trim().replace(/ left$/, '');
      if (item !== '') found.push({ index: m.index, item });
    }
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map((f) => f.item))];
}

export const PANTRY_ADD_PATTERN =
  /\b(?:i'?ve got|i have got|i got|bought|picked up|add(?:ed)?)\s+([^.!?;]+?)(?:\s+to (?:the |my )?pantry)?\s*(?=[.!?;]|$)/g;
export const LIST_SPLIT = /\s*(?:,|&|\+|\band\b|\bn\b)\s*/;
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
      if (item === '' || /^(no|none|nothing)\b/.test(item) || /\bleft$/.test(item)) continue;
      if (!out.includes(item)) out.push(item);
    }
  }
  return out;
}

// Earlier patterns win.
export const SEVERITY_PATTERNS: readonly [RegExp, Severity][] = [
  [/anaphyla|epi-?pen|severe|deadly|hospital/, 'anaphylactic'],
  [/intoleran|not (like )?an allergy|sensitive|upsets? my|wrecks? my|rough after/, 'intolerance'],
  [/\ballerg/, 'allergy'],
  [/prefer|don'?t like|rather not|vegan|vegetarian|pescatarian|halal|kosher/, 'preference'],
];

export function severityFromText(text: string): Severity | null {
  const t = normalizeTurn(text);
  for (const [pattern, severity] of SEVERITY_PATTERNS) if (pattern.test(t)) return severity;
  return null;
}

// "no pork" is reached only as this whole phrase, never as a bare "no".
export const RULE_AFTER_PATTERN =
  /\b(?:allergic to|allergy to|anaphylactic to|intolerant to|intolerance to|sensitive to|can'?t eat|cannot eat|don'?t eat|avoid)\s+([^.!?;:()]+)/g;
export const RULE_BEFORE_PATTERN = /\b((?:[a-z-]+ ){0,3})(?:allergy|intolerance)\b/g;
export const DIET_WORD_PATTERN =
  /\b(vegetarian|veggie|vegan|plant-based|plant based|pescatarian|pescetarian|coeliac|celiac|gluten-free|gluten free|no pork|pork-free|pork free|halal|kosher|jain)\b/g;
/** Words that end the term list: "peanuts because they…" is just peanuts. */
const CLAUSE_END = /\b(because|but|so|since|as|like|which|if|when|though|although|just|please|thanks|and i|i'm|im|i)\b.*$/;
const LEADING_FILLER = /^((a|an|the|some|any|my|all|of|really|very|super|mildly|slightly|quite|bad|badly|mild|severe|severely|serious|seriously|deadly|real|proper|like|have|got|had|has|with|an?)\s+)+/;
const BEFORE_FILLER = new Set([
  'a', 'an', 'the', 'my', 'have', 'has', 'had', 'got', 'with', 'like', 'severe', 'mild', 'bad', 'slight', 'serious',
  'deadly', 'real', 'proper', 'big', 'small', 'minor', 'major', 'really', 'very', 'super', 'an', 'not', 'no', 'food',
  'i', "i'm", 'im', 'is', 'it', 'its', "it's", 'this', 'that', 'some', 'kind', 'of', 'sort', 'just',
]);

function cleanTerm(raw: string): string {
  return raw
    .replace(CLAUSE_END, '')
    .replace(/[\s.,!?;:'"-]+$/, '')
    .trim()
    .replace(LEADING_FILLER, '')
    .trim();
}

/**
 * The ingredient or diet terms in a rule statement, and the severity the words carry. Terms
 * come after "allergic to / intolerant to / can't eat / avoid …", before "allergy / intolerance",
 * or as a whole diet word. Null when there are none.
 */
export function parseRuleStatement(text: string): { terms: string[]; severity: Severity | null } | null {
  const t = normalizeTurn(text);
  const found: { index: number; term: string }[] = [];
  for (const m of t.matchAll(RULE_AFTER_PATTERN)) {
    for (const part of cleanTerm(m[1]).split(LIST_SPLIT)) {
      const term = cleanTerm(part);
      if (term !== '') found.push({ index: m.index, term });
    }
  }
  for (const m of t.matchAll(RULE_BEFORE_PATTERN)) {
    const words = m[1].trim().split(' ').filter((w) => w !== '');
    let start = words.length;
    while (start > 0 && !BEFORE_FILLER.has(words[start - 1])) start--;
    for (const part of words.slice(start).join(' ').split(LIST_SPLIT)) {
      const term = cleanTerm(part);
      if (term !== '') found.push({ index: m.index, term });
    }
  }
  for (const m of t.matchAll(DIET_WORD_PATTERN)) found.push({ index: m.index, term: m[1] });
  if (found.length === 0) return null;
  found.sort((a, b) => a.index - b.index);
  return { terms: [...new Set(found.map((f) => f.term))], severity: severityFromText(t) };
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
const NOT_A_MEAL = /\b(allerg\w*|intoleran\w*|anaphyla\w*)\b/;

/** "Had porridge with banana for breakfast." → the description, the slot named (if any), and the day. */
export function parseMealStatement(
  text: string,
): { description: string; slot: MealSlot | null; when: 'today' | 'yesterday' } | null {
  const t = normalizeTurn(text);
  if (NOT_A_MEAL.test(t)) return null;
  const sentence = t.split(/[.!?]/).find((s) => MEAL_VERB_PATTERN.test(s));
  if (sentence === undefined) return null;
  let slot: MealSlot | null = null;
  for (const m of sentence.matchAll(MEAL_SLOT_PATTERN)) {
    slot = SLOT_WORD[m[1]];
    break;
  }
  const m = MEAL_VERB_PATTERN.exec(sentence)!;
  const description = m[1]
    .replace(MEAL_SLOT_PATTERN, ' ')
    .replace(MEAL_WHEN_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,:-]+|[\s,:-]+$/g, '');
  if (description === '' || /^(to|no|nothing|a (severe|bad|mild)|an? allergy)\b/.test(description)) return null;
  return { description, slot, when: MEAL_YESTERDAY_PATTERN.test(t) ? 'yesterday' : 'today' };
}
