// Cooked for Someone (audit M-9, Ruling 10): who ate with you, as fixed choices only. A typed answer is read by code
// into a count and, optionally, one fixed word; names, free text and health words are dropped before anything is
// built, and the result can only ever hold the enum values below. Eating alone gets equal warmth, nothing here is a
// requirement for trust or progress, and nobody is compared or ranked.
import { canonicalText, foldConfusables } from '../mentor/intents';

export const COOKED_FOR_COUNTS = ['just_me', 'one', 'two_to_three', 'four_plus'] as const;
export const COOKED_FOR_WHO = ['partner', 'family', 'flatmate', 'friends', 'neighbours', 'colleagues', 'guests'] as const;
export type CookedForCount = (typeof COOKED_FOR_COUNTS)[number];
export type CookedForWho = (typeof COOKED_FOR_WHO)[number];

export interface CookedFor {
  count: CookedForCount;
  who: CookedForWho | null;
}

/** A Shared Table row (Step 7). */
export interface SharedEntry {
  cookedOn: string;
  recipe: string | null;
  frame: string | null;
  cookedFor: CookedFor;
}

/** Counts only, never a list of people (C21). */
export interface SharedTally {
  shared: number;
  byRecipe: Record<string, number>;
}

/** Person words → the fixed word; `plural` words stand for two or more people. */
const PEOPLE: readonly { words: readonly string[]; who: CookedForWho; plural?: true }[] = [
  { who: 'partner', words: ['partner', 'husband', 'wife', 'boyfriend', 'girlfriend', 'fiance', 'fiancee', 'spouse', 'other half', 'bf', 'gf'] },
  {
    who: 'family',
    words: ['mum', 'mom', 'mother', 'mam', 'mama', 'dad', 'father', 'papa', 'sister', 'brother', 'son', 'daughter', 'child', 'baby', 'kid',
      'gran', 'granny', 'grandma', 'grandmother', 'grandpa', 'grandad', 'granddad', 'grandfather', 'nan', 'nana', 'aunt', 'auntie', 'uncle',
      'cousin', 'niece', 'nephew', 'grandson', 'granddaughter', 'stepson', 'stepdaughter', 'mother-in-law', 'father-in-law'],
  },
  { who: 'family', plural: true, words: ['parents', 'kids', 'children', 'family', 'siblings', 'sisters', 'brothers', 'sons', 'daughters', 'cousins', 'in-laws', 'grandparents', 'grandkids', 'grandchildren', 'the folks', 'my folks'] },
  { who: 'flatmate', words: ['flatmate', 'roommate', 'housemate', 'roomie'] },
  { who: 'flatmate', plural: true, words: ['flatmates', 'roommates', 'housemates'] },
  { who: 'friends', words: ['friend', 'mate', 'pal', 'buddy', 'bestie', 'best friend'] },
  { who: 'friends', plural: true, words: ['friends', 'mates', 'pals', 'buddies', 'the gang', 'the girls', 'the lads', 'the boys'] },
  { who: 'neighbours', words: ['neighbour', 'neighbor'] },
  { who: 'neighbours', plural: true, words: ['neighbours', 'neighbors'] },
  { who: 'colleagues', words: ['colleague', 'coworker', 'co-worker', 'workmate', 'boss'] },
  { who: 'colleagues', plural: true, words: ['colleagues', 'coworkers', 'co-workers', 'workmates', 'the team', 'my team', 'the office'] },
  { who: 'guests', words: ['guest', 'visitor'] },
  { who: 'guests', plural: true, words: ['guests', 'visitors', 'dinner party', 'a party'] },
];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  couple: 2, 'a couple': 2, both: 2, few: 3, 'a few': 3, dozen: 12, 'a dozen': 12,
};
const JUST_ME = /\b(?:just me|only me|me only|just myself|myself|by myself|on my own|alone|solo|nobody|no one|no-one|just for me|for one|table for one)\b/;
/** "of us", "including me", "in total": the number counts the player too. */
const WITH_ME = /\b(?:of us|us|including me|incl\.? me|in total|altogether|all together|with me)\b/;
const NUMBER = new RegExp(`\\b(\\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')})\\b`);
const SPLIT = /\s*(?:,|&|\+|;|\/|\band\b|\bplus\b|\bwith\b|\balong with\b)\s*/i;
/** Words a name-only list item may not be. */
const NOT_NAMES = new Set(['yes', 'no', 'yeah', 'thanks', 'tonight', 'today', 'everybody', 'nobody', 'leftovers', 'myself', 'alone', 'i', 'me', 'my', 'we', 'us', 'the', 'a', 'an', 'it', 'dinner', 'lunch', 'breakfast', 'just', 'for', 'fed', 'cooked', 'made', 'ate', 'everyone', 'all']);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PEOPLE_RES = PEOPLE.map((p) => ({ ...p, re: new RegExp(`(?:^|[^\\p{L}'-])(?:${p.words.map(escape).join('|')})(?:'s)?(?=$|[^\\p{L}-])`, 'u') }));

function countOf(others: number): CookedForCount {
  if (others <= 0) return 'just_me';
  if (others === 1) return 'one';
  return others <= 3 ? 'two_to_three' : 'four_plus';
}

/** A list item that is a bare name: one or two capitalised words of letters ("Sam", "Aunt Rosa" is a person word). */
const looksLikeName = (item: string): boolean => {
  const words = item.trim().split(/\s+/);
  return words.length >= 1 && words.length <= 2 && words.every((w) => /^\p{Lu}[\p{Ll}'-]+$/u.test(w) && !NOT_NAMES.has(w.toLowerCase()));
};

/**
 * Who ate with you, read from a typed answer into fixed values only (Ruling 10):
 * - "just me" (and the like) → just_me, with no other people mentioned;
 * - a number wins ("fed 6 of us" → four_plus; "of us" counts the player, so others = n − 1);
 * - otherwise the people mentioned besides the player are counted, one per list item ("mum, dad and my sister" →
 *   two_to_three + family; "my flatmate Sam" is one item → one + flatmate, Sam dropped); a plural ("the kids") is two;
 * - `who` is the first person word's fixed word, or null.
 * Anything it can't read is null, and the UI offers the fixed chips. No name, free text or health word is ever
 * returned: the result is built from the enums alone.
 */
export function parseCookedFor(text: string): CookedFor | null {
  if (typeof text !== 'string') return null;
  const original = foldConfusables(canonicalText(text)).replace(/[‘’‛′]/g, "'").replace(/\s+/g, ' ').trim();
  const t = original.toLowerCase();
  if (t === '') return null;
  let who: CookedForWho | null = null;
  let firstAt = Infinity;
  for (const p of PEOPLE_RES) {
    const m = p.re.exec(t);
    if (m && m.index < firstAt) {
      firstAt = m.index;
      who = p.who;
    }
  }
  const numberIn = (x: string): number | null => {
    // "no one", "for one", "someone": the word "one" here is not a count.
    const n = NUMBER.exec(x.replace(/\b(?:no[ -]one|for one|some ?one|any ?one|every ?one)\b/g, ' '));
    if (!n) return null;
    const value = /^\d+$/.test(n[1]) ? Number(n[1]) : NUMBER_WORDS[n[1]];
    return Number.isInteger(value) && value >= 0 ? value : null;
  };
  // "6 of us", "the two of us": the number counts everyone, the player too.
  const total = WITH_ME.test(t) ? numberIn(t) : null;
  if (total !== null) return { count: countOf(total - 1), who: total <= 1 ? null : who };
  const stripped = original
    .replace(/^(?:i\s+)?(?:cooked|made it|made|fed|served|shared it|shared|ate|had dinner|had lunch)\b(?:\s+(?:for|with))?\s*/i, '')
    .replace(/^(?:for|with)\s+/i, '');
  const items = stripped
    .split(SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  // A capitalised word is read as a name only in a list, or after "cooked for" / "with": "Yes" or "Pasta" alone is not a person.
  const namesCount = items.length >= 2 || stripped !== original;
  let people = 0;
  for (const item of items) {
    const lower = item.toLowerCase();
    const n = numberIn(lower);
    const p = PEOPLE_RES.find((x) => x.re.test(lower));
    if (n !== null) people += n; // "3 kids": the number is the people in this item
    else if (p) people += p.plural ? 2 : 1;
    else if (namesCount && looksLikeName(item)) people += 1;
  }
  if (people === 0 && JUST_ME.test(t)) return { count: 'just_me', who: null };
  return people > 0 ? { count: countOf(people), who } : null;
}

const isCount = (v: unknown): v is CookedForCount => typeof v === 'string' && (COOKED_FOR_COUNTS as readonly string[]).includes(v);

/**
 * Meals shared (count other than just_me) in total and per recipe slug. A frame entry counts in `shared` only.
 * Counts only: no list of entries, people or dates, and nothing ranked (C21). Malformed rows count for nothing.
 */
export function shareTally(entries: readonly SharedEntry[]): SharedTally {
  let shared = 0;
  const byRecipe = new Map<string, number>();
  // Rows come from storage: read defensively.
  for (const e of entries as readonly (Partial<Record<keyof SharedEntry, unknown>> | null)[]) {
    const count = (e?.cookedFor as Partial<CookedFor> | null | undefined)?.count;
    if (!isCount(count) || count === 'just_me') continue;
    shared++;
    if (typeof e?.recipe === 'string' && e.recipe !== '' && (e.frame === null || e.frame === undefined)) byRecipe.set(e.recipe, (byRecipe.get(e.recipe) ?? 0) + 1);
  }
  return { shared, byRecipe: Object.fromEntries([...byRecipe].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
}
