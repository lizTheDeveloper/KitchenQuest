import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { SEVERE, type Severity } from '../rules/types';
import type { LineRef } from './cards';
import { canonicalText, capText, classifyTurn, foldConfusables, normalizeTurn, stripPageEvents, type TurnIntent } from './intents';
import {
  PANTRY_ADD_PATTERN,
  PANTRY_REMOVAL_PATTERNS,
  parseClock,
  parseMealStatement,
  parsePantryAdds,
  parsePantryRemovals,
  parseRuleStatement,
  parseWeekdays,
  severityFromText,
  WEEKDAY_NAMES,
  weekdaysOf,
  type MealSlot,
} from './parse';
import type { NavTarget } from './protocol';
import type { RuleTerm } from './rule-terms';

/**
 * Decisions the server agent and the client's scripted engine share, so neither writes its own
 * (pre-flight C14).
 */

const line = (trigger: string, vars: Record<string, string> = {}): LineRef => ({ trigger, vars });

const PRE_ROUTES: Partial<Record<TurnIntent, string>> = {
  emergency: 'rule.emergency',
  child: 'child.grownup',
  medical: 'rule.medical_deflect',
  // M5 final I2: weight loss and calorie counting get a fixed, plain deflection; the model never sees them.
  weight: 'rule.weight_deflect',
  allowance: 'allowance.explain',
  thanks: 'thanks',
};

/** The fixed line for an intent code answers by itself, else null. */
export function preRoute(intent: TurnIntent): LineRef | null {
  const trigger = PRE_ROUTES[intent];
  return trigger === undefined ? null : line(trigger);
}

export interface OpenCardRef {
  ref: string;
  severe: boolean;
  ingredient: string | null;
  issuedTurn: number;
}
export type ShortReply =
  | { kind: 'confirm'; ref: string }
  | { kind: 'reject'; ref: string }
  | { kind: 'undo' }
  | { kind: 'line'; line: LineRef }
  | { kind: 'none' };

/**
 * What a typed "yes", "no" or "undo" points at. Only cards issued in the previous Pan turn count.
 * A typed yes never confirms a severe card (§7.6) and never guesses between two cards.
 */
export function shortReplyTarget(intent: TurnIntent, openCards: readonly OpenCardRef[], currentTurn: number): ShortReply {
  if (intent === 'undo') return { kind: 'undo' };
  if (intent !== 'yes' && intent !== 'no') return { kind: 'none' };
  const recent = openCards.filter((c) => c.issuedTurn === currentTurn - 1);
  if (recent.length === 0) return { kind: 'none' };
  if (recent.length > 1) return { kind: 'line', line: line('confirm.tap_card') };
  const card = recent[0];
  if (intent === 'no') return { kind: 'reject', ref: card.ref };
  if (card.severe) return { kind: 'line', line: line('rule.tap_needed', { ingredient: card.ingredient ?? '' }) };
  return { kind: 'confirm', ref: card.ref };
}

/** Meals whose description or dish is a removed pantry item are dropped (T05: "finished the milk"). */
export function dropMealsMatchingRemovals<T extends { description: string | null; dish: string | null }>(
  meals: T[],
  removals: string[],
): T[] {
  const removed = new Set(removals.map(normalizeName));
  const hit = (s: string | null) => s !== null && removed.has(normalizeName(s));
  return meals.filter((m) => !hit(m.description) && !hit(m.dish));
}

/** Weekday numbers (0 = Sunday) for names like 'Saturday', 'sat' or 'saturdays'; unknown names dropped. */
export function weekdayNumbers(names: readonly string[]): number[] {
  const out = names.flatMap((n) => {
    const key = normalizeName(capText(n)).replace(/s$/, '');
    return key === 'weekend' ? [] : weekdaysOf(key);
  });
  return [...new Set(out)].sort((a, b) => a - b);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const occursAsWord = (text: string, phrase: string): boolean =>
  phrase !== '' && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(phrase)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);

/**
 * The recipe the text names: the whole text is a slug or a slug's last segment, or a slug's last
 * segment or a title (with or without its bracketed gloss) occurs in it as whole words, case
 * insensitive. The longest match wins; anything else is null. No fuzzy guesses (T07/T13).
 */
export function matchDish(
  text: string,
  recipes: readonly { slug: string; title: string }[],
): { slug: string; title: string } | null {
  const t = normalizeName(capText(text));
  if (t === '') return null;
  for (const r of recipes) {
    const slug = normalizeName(r.slug);
    if (t === slug || t === slug.slice(slug.lastIndexOf('/') + 1)) return r;
  }
  let best: { recipe: { slug: string; title: string }; length: number } | null = null;
  for (const r of recipes) {
    const slug = normalizeName(r.slug);
    const title = normalizeName(r.title);
    const forms = [title, normalizeName(title.replace(/\s*\([^)]*\)\s*$/, '')), slug.slice(slug.lastIndexOf('/') + 1)];
    for (const form of forms) {
      if (occursAsWord(t, form) && (best === null || form.length > best.length)) best = { recipe: r, length: form.length };
    }
  }
  return best?.recipe ?? null;
}

const MAX_NAME_WORDS = 5;
/** The shortest name found inside a compound word ("peanutbutter"); shorter ones over-match ("nutrition"). */
const COMPOUND_MIN = 4;

/** Runs of 3+ single letters joined into one word: "p e a n u t" → "peanut". */
function joinLetterRuns(words: readonly string[]): string[] {
  const out: string[] = [];
  let run = '';
  const flush = () => {
    if (run.length >= 3) out.push(run);
    else out.push(...run);
    run = '';
  };
  for (const w of words) {
    if ([...w].length === 1) run += w;
    else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out;
}

/** The plural strips `resolve` uses, applied to rule-term phrases too ("vegans", "celiacs"). */
const pluralForms = (g: string): string[] => [g, ...(g.endsWith('es') ? [g.slice(0, -2)] : []), ...(g.endsWith('s') ? [g.slice(0, -1)] : [])];

/**
 * Health words beyond the graph (Step 7 fix round 1, I3): allergy and its misspellings,
 * conditions, symptoms and medicines. Over-catches on purpose.
 */
export const HEALTH_WORDS =
  /\b(al+erg|intoleran|diabet|coeliac|celiac|migraine|ibs|crohn|pregnan|epi-?pen|anaphyla|hives|reaction|symptom|medic|tablet|pill|dose|mg|rash|itch|sick|ill|throw(n|s|ing)? up|threw up|vomit|nause|stomach|tumm(y|ies)|hurt|swell|swollen|wheez|cramp|bloat|diarrh|gout|cholesterol|blood[ -]?(pressure|sugar|glucose)|bp\b|hypertens|hypotens|kidney|renal|ckd\b|dialys|anaemi|anemi|iron[ -]deficien|low[ -]iron|breast-?fe|type[ -]?(1|2|one|two)\b|phenylketon|pku\b|colitis|reflux|gerd\b|heartburn|ulcer|gastritis|gastroenteritis|histamine|lactose|fructose|fodmap|g6pd|favism|pcos|thyroid|chemo|asthma|eczema|glucose|hypoglyc|hyperglyc|dizz|head ?ache|lighthead|light-head|shaky|shakiness|the shakes|faint|queas|unwell|scratchy|sore throat|palpitat|jitter|indigest|constipat|gassy|flatulen|heart (condition|disease|problem)|liver (disease|problem))\w*/i;

/** The allergen labels short enough that only a substitution or swap counts as a slip ("egs", "soi", "milc"). */
const SHORT_ALLERGENS: readonly string[] = ['egg', 'soy', 'nut', 'fish', 'milk', 'oat'];
/** Common words a slip away from a health label; never read as one ("not", "eat", "what" for wheat). */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  'ego', 'boy', 'joy', 'toy', 'coy', 'say', 'sly', 'spy', 'son', 'sow', 'sod', 'but', 'cut', 'gut', 'hut', 'jut', 'put', 'rut', 'not', 'net',
  'nit', 'nun', 'nub', 'dish', 'wish', 'fist', 'mild', 'mile', 'mill', 'mink', 'silk', 'bilk', 'out', 'eat', 'cat', 'bat', 'fat', 'hat',
  'mat', 'pat', 'rat', 'sat', 'vat', 'oak', 'oar', 'oaf', 'opt', 'oft', 'buts', 'cuts', 'guts', 'huts', 'puts', 'nets', 'nits', 'eats',
  'cats', 'bats', 'hats', 'mats', 'pats', 'rats', 'oaks', 'oars', 'outs', 'boys', 'toys', 'says', 'sons', 'dishes', 'wishes', 'fists',
  'miles', 'mills', 'nuns', 'what', 'whats', 'meant', 'money', 'later', 'wheel', 'honest', 'shall', 'union', 'unions', 'salty',
  // Two edits from the EU/US allergen members (tahini, walnut, celery, oyster, lupine, barley, almond, cashew, mussel, ...).
  'think', 'thinks', 'thing', 'things', 'thin', 'want', 'wants', 'every', 'system', 'systems', 'line', 'lines', 'early', 'almost',
  'taking', 'along', 'among', 'alone', 'spent', 'sister', 'sisters', 'master', 'masters', 'cash', 'missed', 'valley',
  'faster', 'marine', 'monster', 'monsters', 'mystery', 'badly', 'rarely', 'foster',
  'filter', 'vessel', 'vessels', 'outer', 'nail', 'poster', 'bare', 'suite', 'barrel', 'wallet', 'easter',
]);
/**
 * M6 Step 4 fix round 1 (ruling C1): everyday English words that are one or two edits from a market ingredient name
 * ("dinner" from ginger, "love" from clove, "until" from lentil, "checked" from chicken, "Oregon" from oregano). They
 * never count as a SLIP of a name: the near-miss check skips them. A closed list, each word checked not to be a graph
 * label itself; an exact name or alias still always counts, and so does a compound ("chilling" holds "chilli").
 */
const EVERYDAY_WORDS: ReadonlySet<string> = new Set([
  'dinner', 'dinners', 'longer', 'winter', 'finger', 'fingers', 'linger', 'lingers', 'gender', 'grinder', 'finer', 'bigger', 'danger',
  'infer', 'hinge', 'love', 'loves', 'close', 'closes', 'glove', 'gloves', 'clone', 'until', 'pencil', 'mental', 'paper', 'papers',
  'panel', 'panels', 'planner', 'planners', 'career', 'careers', 'banner', 'manner', 'manners', 'payers', 'parser', 'parsers', 'oregon',
  'checked', 'checkin', 'checker', 'clicked', 'thicken', 'thickens', 'thicker', 'chucked', 'feel', 'feels', 'funnel', 'child', 'chilled',
  'chill', 'apply', 'applies', 'temp', 'temper', 'tamper', 'carry', 'carries', 'cannot', 'narrow', 'narrows', 'arrow',
  'carton', 'worries', 'retries', 'series', 'little', 'gentle', 'kettle', 'settle', 'pestle', 'neatly', 'rattle', 'seattle', 'damage',
  'damages', 'rotate', 'motto', 'parsing', 'colander', 'garbage', 'balances', 'canada', 'terry',
]);
/**
 * M6 Step 5 fix round 1 (Task 5 ruling 1): market names added so stall lines can be rules-checked, which are a slip
 * away from very common words ("chuck"/"check", "squash"/"square", "tortilla"/"gorilla", "legume"/"league") or start
 * them ("plumber", "chuckle", "squashed", "ricer"). They count only as exact whole words: never as a near miss, never
 * as part of a compound. An exact "chuck", "rice" or "plums" is still always health.
 */
const EXACT_ONLY: ReadonlySet<string> = new Set(['chuck', 'squash', 'rice', 'tortilla', 'plum', 'legume']);

/** The shortest word checked against the longer labels; shorter ones over-match too much. */
const FUZZY_MIN = 4;
/** Labels this long or longer allow two edits ("pnuts" for peanuts). */
const TWO_EDIT_MIN = 6;

/** One-word graph names, aliases and rule-term phrases of 5+ letters. */
function fuzzyLabels(graph: IngredientGraph, phrases: ReadonlySet<string>): string[] {
  const labels = new Set<string>();
  for (const p of phrases) if (!p.includes(' ') && p.length >= 5) labels.add(p);
  for (const label of graph.labels()) if (!label.includes(' ') && label.length >= 5 && !EXACT_ONLY.has(label)) labels.add(label);
  return [...labels];
}

/** Optimal-string-alignment distance (insert, delete, substitute, swap neighbours), stopping above `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Same length, one letter changed or two neighbours swapped. */
function oneSubstitution(a: string, b: string): boolean {
  return a.length === b.length && a !== b && editDistance(a, b, 1) === 1;
}

/**
 * A word (or its plural strip) that is a slip of a health label: one edit from a
 * label of 5 letters, two from one of 6+ ("penuts", "pnuts", "sesmae"), or one
 * substitution or swap from a short allergen ("egs", "soi", "milc", "mlik")
 * unless it is a common word. Over-catches on purpose (fix round 2, N5).
 */
function nearMiss(word: string, labels: readonly string[]): boolean {
  // Only the whole word is checked against COMMON_WORDS: "nots" is a slip of "nuts" though "not" is common.
  const forms = pluralForms(word);
  if (forms.some((w) => w.length >= 3 && SHORT_ALLERGENS.some((l) => oneSubstitution(w, l)))) return true;
  if (word.length < FUZZY_MIN) return false;
  return forms.some(
    (w) => w.length >= FUZZY_MIN && labels.some((l) => editDistance(w, l, l.length >= TWO_EDIT_MIN ? 2 : 1) <= (l.length >= TWO_EDIT_MIN ? 2 : 1)),
  );
}

/**
 * True when the text names any ingredient (graph name or alias, plurals as `resolve` strips
 * them) or any rule-term phrase, as whole words. The text is NFKC-normalised with invisible
 * characters dropped and lookalikes folded, and read three ways: as written ("peanut-free",
 * "gluten-free"), split at hyphens and apostrophes ("peanut", "free"; "peanut", "s"), and with
 * them removed ("pea-nut" → "peanut"), with letter-spaced runs joined ("p e a n u t"), and
 * each word checked for a name of 4+ letters at its start or end ("peanutbutter",
 * "glutenfree"; exact names only, so "minutes" is not "nut"). It over-catches on purpose: it is
 * half of Step 7's consent gate (pre-flight C1). The input is capped at MAX_TEXT.
 */
export function mentionsHealthTerm(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const clean = normalizeName(foldConfusables(canonicalText(text)).replace(/[‘’‛]/g, "'"));
  if (HEALTH_WORDS.test(clean)) return true;
  const asWritten = clean
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w !== '');
  const joined = asWritten.map((w) => w.replace(/['-]/g, ''));
  const readings = [
    asWritten,
    asWritten.flatMap((w) => w.split(/['-]/)).filter((w) => w !== ''),
    joined,
    joinLetterRuns(asWritten),
  ];
  const phrases = new Set(
    terms.flatMap((t) => t.phrases.map(normalizeName)).flatMap((p) => [p, p.replace(/-/g, ' '), p.replace(/-/g, '')]),
  );
  const isExactName = (part: string): boolean => {
    if (phrases.has(part)) return true;
    // Only the compound check calls this: an exact-only name is never part of a longer word.
    if (pluralForms(part).some((f) => EXACT_ONLY.has(f))) return false;
    const id = graph.resolve(part);
    if (id === null) return false;
    const node = graph.get(id);
    return [node.name, ...(node.aliases ?? [])].some((label) => normalizeName(label) === part);
  };
  const fuzzyNames = fuzzyLabels(graph, phrases);
  for (const word of new Set(joined)) {
    if (COMMON_WORDS.has(word)) continue; // "salty", "union", "shall": never a slip or a compound
    if (!EVERYDAY_WORDS.has(word) && nearMiss(word, fuzzyNames)) return true; // an everyday word is never a slip (M6 C1)
    for (let k = COMPOUND_MIN; k <= word.length - 1; k++) {
      if (isExactName(word.slice(0, k))) return true;
      if (word.length - k >= COMPOUND_MIN && isExactName(word.slice(k))) return true;
    }
  }
  for (const words of readings) {
    for (let i = 0; i < words.length; i++) {
      for (let n = 1; n <= MAX_NAME_WORDS && i + n <= words.length; n++) {
        const gram = words.slice(i, i + n).join(' ');
        if (graph.resolve(gram) !== null) return true;
        if (pluralForms(gram).some((g) => phrases.has(g))) return true;
      }
    }
  }
  return false;
}

/**
 * Text after this is not the player's own words (S19 and the spike's injection cases): an
 * instruction to the AI, any "the user …" (third person about the player: a pasted note, Step 7 fix round 1), a system/developer/tool/assistant role label anywhere, a user label at
 * the start of a line or after a sentence end, or a role tag. Matched on NFKC text with
 * lookalikes folded ("ＳＹＳＴＥＭ:", "ѕystem:").
 */
export const INJECTION_MARKER =
  /note to (the )?(ai|assistant)|\b(assistant|system|developer|tool)\s*:|\bthe user\b|ignore (all |the )?previous|developer override|do not mention this|(^|[.!?])[^\S\n]*user\s*:|<\/?\s*(system|developer|assistant|tool|user)\b/im;

/** A pasted block starts at a line beginning with -, * or a digit, or a line in capitals of 6+ letters. */
function isPastedLine(l: string): boolean {
  const trimmed = l.trim();
  if (/^[-*\d]/.test(trimmed)) return true;
  const letters = trimmed.replace(/[^\p{L}]/gu, '');
  return letters.length >= 6 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * The player's own words: the text (NFKC, lookalikes folded) cut at the first injection marker
 * and the first pasted block. Call it on the RAW turn text, before `stripPageEvents` (see
 * `ruleTermsInPlayerWords`). Step 7's post-checks read severity and the parsers from it.
 */
export function playerOwnWords(text: string): string {
  let own = foldConfusables(canonicalText(text));
  const marker = INJECTION_MARKER.exec(own);
  if (marker) own = own.slice(0, marker.index);
  const lines = own.split('\n');
  const pasted = lines.findIndex((l, i) => i > 0 && isPastedLine(l));
  if (pasted > 0) own = lines.slice(0, pasted).join('\n');
  return own;
}

/**
 * The rule terms in the player's own words only, cut at the first injection marker and the
 * first pasted block. Step 7 drops any model `propose_rule` whose term isn't here (C4).
 * Step 7 must call this on the RAW turn text, before `stripPageEvents`: stripping removes the
 * role prefixes and tags this cuts at, which would turn injected text into the player's own.
 * A message longer than MAX_TEXT loses its last term.
 */
export function ruleTermsInPlayerWords(text: string): string[] {
  const terms = parseRuleStatement(playerOwnWords(text))?.terms ?? [];
  // Cut at MAX_TEXT: the last term may be cut ("pea" of "peanuts"), so it never counts.
  return capText(text) !== text ? terms.slice(0, -1) : terms;
}

/** The player's own words, cut at injected or pasted text, with page events stripped. */
const ownWords = (raw: string): string => stripPageEvents(playerOwnWords(raw)).text;
const isSevere = (s: Severity | null): s is Severity => s !== null && SEVERE.has(s);

/** Ingredient ids named in the text, longest match first at each word (up to three words). */
function namedIngredients(text: string, graph: IngredientGraph): string[] {
  const words = normalizeName(text)
    .split(/[^\p{L}\p{N}'-]+/u)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w !== '');
  const ids: string[] = [];
  for (let i = 0; i < words.length; ) {
    let step = 1;
    for (let n = Math.min(3, words.length - i); n >= 1; n--) {
      const id = graph.resolve(words.slice(i, i + n).join(' '));
      if (id !== null) {
        ids.push(id);
        step = n;
        break;
      }
    }
    i += step;
  }
  return ids;
}

/** Words after which, in the same clause, a named ingredient is allowed rather than to avoid ("but not tree nuts"). */
const EXCLUSION = /\b(not|never|except|apart from|other than|besides|fine with|ok with|okay with)\b/;
const CLAUSE_BREAK = /[,;.!?()/]|\band\b|\bbut\b(?! not)/;

/**
 * M4 Step 11 fix round 2 (structural, "every named allergen gets a card or an ask"): the graph names in the player's
 * own words (RAW turn text) that no produced card covers. `coveredIds` are the cards' target ids; their isA kinds
 * count as covered too ("vegan and milk" leaves nothing). A name said after an exclusion in its clause ("peanuts but
 * not tree nuts") is never a card: it is in `excluded`. Each list holds ledger names, in order, each once. Shared
 * by the client's intake and (Step 12 carry) the server turn's ask.
 */
export function leftoverNamedIngredients(
  playerText: string,
  coveredIds: readonly string[],
  graph: IngredientGraph,
): { left: string[]; excluded: string[] } {
  const covered = new Set(coveredIds.flatMap((id) => (graph.has(id) ? [id, ...graph.descendants(id)] : [])));
  const left: string[] = [];
  const excluded: string[] = [];
  for (const clause of normalizeName(ownWords(playerText)).split(CLAUSE_BREAK)) {
    const ex = EXCLUSION.exec(clause);
    const at = ex ? ex.index : clause.length;
    for (const [part, list] of [[clause.slice(0, at), left], [clause.slice(at), excluded]] as const) {
      for (const id of namedIngredients(part, graph)) {
        const name = graph.get(id).name;
        if (covered.has(id) || left.includes(name) || excluded.includes(name)) continue;
        list.push(name);
      }
    }
  }
  return { left, excluded: excluded.filter((n) => !left.includes(n)) };
}

/**
 * The broad categories ("herbs", C1 ruling) a which-kind ask has offered kinds of: every `broad` isA ancestor of the
 * offered ids. A turn that asked "which herb?" has answered the player's "herbs", so `leftoverNamedIngredients`
 * mustn't ask about it again. Sorted, each once.
 */
export function broadKindsAsked(offeredIds: readonly string[], graph: IngredientGraph): string[] {
  const out = new Set<string>();
  for (const id of offeredIds) if (graph.has(id)) for (const a of graph.ancestors(id)) if (graph.get(a).broad === true) out.add(a);
  return [...out].sort();
}

/**
 * The major allergens (the EU's 14 and the US's 9) as ledger nodes: an ingredient that is one, a kind of one, or
 * contains one is a major allergen (M4 final, C1 over-ask).
 */
export const ALLERGEN_ROOTS: ReadonlySet<string> = new Set([
  'nut', 'tree_nut', 'peanut', 'milk', 'egg', 'gluten', 'wheat', 'barley', 'rye', 'oats', 'spelt', 'kamut', 'soy', 'fish',
  'shellfish', 'crustacean', 'mollusc', 'sesame', 'mustard', 'celery', 'lupin', 'sulphites',
]);

/** `id` is a major allergen: one of ALLERGEN_ROOTS, a kind of one, or contains one. Unknown ids count (can't verify). */
export function isMajorAllergen(id: string, graph: IngredientGraph, seen: Set<string> = new Set()): boolean {
  if (!graph.has(id)) return true;
  if (seen.has(id)) return false;
  seen.add(id);
  if (ALLERGEN_ROOTS.has(id) || graph.ancestors(id).some((a) => ALLERGEN_ROOTS.has(a))) return true;
  return (graph.get(id).contains ?? []).some((c) => isMajorAllergen(c, graph, seen));
}

/**
 * The ingredients a meal or pantry card names that are NOT major allergens: on a rule turn they count as accounted
 * for, so "had rice with onion … allergic to kiwi" asks about kiwi only (C1 over-ask). A major allergen a meal or
 * pantry card names is never covered by it (fix round 1 C1 ruling): "peanut butter toast … allergic to peanuts" still asks.
 */
export function nonAllergenNamedIds(text: string, graph: IngredientGraph): string[] {
  return namedIngredients(text, graph).filter((id) => !isMajorAllergen(id, graph));
}

/**
 * Step 1 carry and Step 7 fix round 1 I5: the player's own words (`playerText` is the RAW turn
 * text) state a severe allergy but name an ingredient that no kept rule term covers (whether or
 * not the grammar parsed it) ("i'm vegetarian, peanuts nearly killed me"). Returns that
 * ingredient's name, or null. Over-asks on purpose.
 */
export function severeTermsLeftOut(playerText: string, keptRuleTerms: readonly string[], graph: IngredientGraph): string | null {
  const own = ownWords(playerText);
  if (!isSevere(severityFromText(own, graph))) return null;
  // Only the turn's rule terms cover a term: a term the grammar parsed but no card was made for is still missed.
  const covered = new Set(keptRuleTerms.map((t) => graph.resolve(t)).filter((id) => id !== null));
  const missed = namedIngredients(own, graph).find((id) => !covered.has(id));
  return missed === undefined ? null : graph.get(missed).name;
}

/** The player's own words (RAW turn text) state a severe allergy (I5: a severe turn with no rule outcome always asks). */
export function statesSevere(playerText: string, graph: IngredientGraph): boolean {
  return isSevere(severityFromText(ownWords(playerText), graph));
}

/**
 * The ask-for-dropped-terms rule (Step 7, "Carry from Step 1"; the client's scripted engine and
 * intake answers use it too): `rule.ask_what_else`, naming the missed ingredient when code knows
 * it, when a severe statement left a named ingredient out or produced no rule outcome at all.
 * `hasRuleOutcome`: the reply already holds a rule card or a rule line. Null when nothing is missed.
 */
export function askForDroppedTerms(
  playerText: string,
  keptRuleTerms: readonly string[],
  hasRuleOutcome: boolean,
  graph: IngredientGraph,
): LineRef | null {
  const missed = severeTermsLeftOut(playerText, keptRuleTerms, graph);
  if (missed === null && !(statesSevere(playerText, graph) && !hasRuleOutcome)) return null;
  return line('rule.ask_what_else', missed === null ? {} : { term: missed });
}

const SLOT_WORDS: Readonly<Record<MealSlot, RegExp | null>> = {
  breakfast: /\b(breakfast|brekkie)\b/i,
  lunch: /\blunch\b/i,
  dinner: /\b(dinner|supper)\b/i,
  snack: /\bsnacks?\b/i,
  other: null,
};
const CLAUSE_SPLIT = /[,;.!?]|\band\b|\bthen\b/i;

/** The first clause of `text` naming `slot` ("lunch at half twelve and dinner at 7" → lunch's clause), or null. */
export function slotClause(text: string, slot: MealSlot): string | null {
  const word = SLOT_WORDS[slot];
  if (word === null) return null;
  return text.split(CLAUSE_SPLIT).find((c) => word.test(c)) ?? null;
}

/** The clock time in the first clause naming `slot`, or null (T04: "lunch at half twelve" is 12:30). */
export function clockForSlot(text: string, slot: MealSlot): string | null {
  const clause = slotClause(text, slot);
  return clause === null ? null : parseClock(clause);
}

/**
 * Which pantry items a removal names: `removeNames` match case-insensitively (normalizeName), or
 * by ingredient id when the name resolves in the graph; `removeIds` match exactly. The one
 * matching rule for the API's pantry service and the client's device pantry.
 */
export function pantryMatcher(
  removeNames: readonly string[],
  removeIds: readonly string[],
  graph: IngredientGraph,
): (item: { id: string; name: string; ingredientId: string | null }) => boolean {
  const names = new Set(removeNames.map(normalizeName).filter((n) => n !== ''));
  const resolved = new Set(removeNames.map((n) => graph.resolve(n)).filter((id): id is string => id !== null));
  const ids = new Set(removeIds.map((id) => id.toLowerCase()));
  return (i) => ids.has(i.id) || names.has(normalizeName(i.name)) || (i.ingredientId !== null && resolved.has(i.ingredientId));
}

/**
 * The health predicate on text alone (pre-flight C1, Step 7 fix round 1 R1), shared by the API's gate and the
 * client's scripted engine: a health, emergency or medical intent, any graph name, alias, rule-term phrase or
 * health word, any severity, or any rule statement. Over-catches on purpose.
 */
export function isHealthText(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const intent = classifyTurn(text);
  return (
    intent === 'health' ||
    intent === 'emergency' ||
    intent === 'medical' ||
    intent === 'weight' ||
    mentionsHealthTerm(text, graph, terms) ||
    severityFromText(text, graph) !== null ||
    parseRuleStatement(text, graph) !== null ||
    dietCue(text)
  );
}

/** M4's bare meal-time words (HEALTH_PATTERN's meal slots and eating verbs): the only part of it code cards set aside. */
const MEAL_TIME_WORDS = /\b(?:breakfast|brekkie|lunch|dinner|supper|snack\w*|ate|eaten|had)\b/g;

/**
 * Fix round 4 (N11): the player's words (`own`, already cut at injected or pasted text) hold health for a code-built
 * card: all of M4's health gate (`isHealthText`) on the text with only the bare meal-time words masked out, plus
 * every check on the text as written (a graph name, health word, severity, rule statement or diet cue). A reminder
 * clause ("remind me to eat dinner at 6pm") is health in M4's gate only through its meal word, so it can still make
 * its card; "i'm on a diet", "i don't eat pork" or "rough after" cannot.
 */
export function codeCardHealth(own: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const masked = normalizeTurn(own).replace(MEAL_TIME_WORDS, ' ');
  return (
    isHealthText(masked, graph, terms) ||
    mentionsHealthTerm(own, graph, terms) ||
    severityFromText(own, graph) !== null ||
    parseRuleStatement(own, graph) !== null ||
    dietCue(own)
  );
}

/**
 * M4 Step 9 fix round 2 (E2): an emergency turn whose player words (RAW turn text) also state a rule, or name
 * any ingredient (the symptom is the severity cue) ("I'm allergic to peanuts, I had anaphylaxis once"). The emergency line comes first; the
 * allergy is then never dropped: the rule path (a card, or the ask) follows.
 */
export function emergencyStatesRule(playerText: string, graph: IngredientGraph): boolean {
  const own = ownWords(playerText);
  if (parseRuleStatement(own, graph) !== null) return true;
  // On an emergency turn the symptom is itself the severity cue: any ingredient named is offered for a card (fix round 3).
  return namedIngredients(own, graph).length > 0;
}

/**
 * Fix round 3 (E2 on emergency turns), widened in M4 Step 12 fix round 1 (I2): the asks after the emergency
 * line. The symptom is the severity cue, so EVERY named ingredient no kept (severe) rule card covers is asked
 * for by name, in order (`leftoverNamedIngredients`), and a name said as fine gets `rule.exclusion_not_kept`.
 * With nothing named or kept, the plain ask. Empty when the kept cards cover everything named. Server and
 * engine both use it.
 */
export function emergencyRuleAsks(playerText: string, keptRuleTerms: readonly string[], graph: IngredientGraph): LineRef[] {
  const covered = keptRuleTerms.flatMap((t) => graph.resolve(t) ?? []);
  const { left, excluded } = leftoverNamedIngredients(playerText, covered, graph);
  const asks = [
    ...left.map((term) => line('rule.ask_what_else', { term })),
    ...excluded.map((term) => line('rule.exclusion_not_kept', { term })),
  ];
  return left.length === 0 && keptRuleTerms.length === 0 ? [...asks, line('rule.ask_keep_off')] : asks;
}

// ---- M5 Step 8: the plan and navigation intents (code only, shared by the server turn and the scripted engine) ----
//
// Fix round 2 (structural ruling, as M4's nonsevere.ts): a code-built plan clause, meal-time reminder or market day
// comes only from a closed grammar that consumes the WHOLE clause. A word left over (minus, hold, easy, low, keto,
// sometimes, a person, a past-tense verb, a second weekday …) means no code card for that clause: it falls to the
// model's checked proposal (verbatim and screened, R5) or to nothing. Never a guess.

/** Intents that win over any plan or navigation reading: the safety pre-routes (emergency, medical, child). */
const SAFETY_INTENTS: ReadonlySet<TurnIntent> = new Set(['emergency', 'medical', 'child']);

/**
 * A hard-week phrase in the player's words ("it's a rough week", "hard week"). Core's one list: a model's
 * `hard_week: true` is kept only when the player's own words match it (Step 8 post-check).
 */
const HARD_WORDS = '(?:hard|rough|tough|busy|stressful|exhausting|tiring|difficult|heavy|mad|crazy)\\s+week';
export const HARD_WEEK_PATTERN = new RegExp(`\\b${HARD_WORDS}\\b`);

/**
 * A diet or restriction cue (fix round 2; widened in fix round 4, N7: when in doubt, health): the message goes down
 * M4's health path first (it is part of `isHealthText`), and code builds no card from it. Diets and religious
 * restrictions ("keto", "halal", "fasting", "ramadan", "lent", "low sugar", "less spicy", "plant based"), restriction
 * forms on any word ("no beef", "beef free", "sesame-free", "without …", "sin …", "zero sugar", "minus the …", "hold
 * the …", "go easy on …", "not too …", "cut out …"), spice words, and food, symptom or medicine emoji.
 */
const DIET_CUE =
  /\b(keto|paleo|vegan|vegetarian|pescatarian|plant[- ]based|halal|haram|kosher|jain|sattvic|satvik|fasting|fast day|ramadan|ramzan|iftar|suhoor|suhur|sehri|lent|lenten|passover|navratri|ekadashi|yom kippur|teetotal\w*|sober|alcohol\w*|spic(?:e|es|y|ier|iest|iness)|(?:low|lower|reduced|less|zero|high)[- ](?:carb|carbs|fat|fats|sugar|sugars|salt|sodium|cal\w*|fodmap|gi|spice|protein|cholesterol|iron|purine|potassium|phosphorus|lactose|gluten|residue|fibre|fiber|histamine|oxalate)|less (?:salt|salty|sugar|sugary|spicy|spice|fat|fatty|oil|oily|meat|dairy|sweet|carbs?)|minus|without|hold the|go easy on|easy on the|light on|reduced|free of|no added|cut(?:ting)? (?:out|down on|back on)|giv(?:e|ing) up|gave up|given up|\w+-free)\b/;
/** The negated verbs of the restriction cue "can't / won't / don't … X" (M5 final I2). */
const NEGATED_VERB = "(?:won'?t|will not|wouldn'?t|would not|can'?t|cannot|can not|don'?t|do not|never)";
/**
 * M6 Step 8 (N2, Ruling 19): what "can't do / manage / handle" may be followed by and still be a plan, not a
 * restriction: a weekday (`(mon|tues|wednes|thurs|fri|satur|sun)days?`), "tonight", "the weekend", "that day", or a
 * clock in letters ("noon", "midday", "midnight"; a clock in digits never starts the cue's word). A closed list.
 */
const SCHEDULING_OBJECT = '(?:(?:mon|tues|wednes|thurs|fri|satur|sun)days?|tonight|the weekend|that day|noon|midday|midnight)\\b';
/**
 * Restriction forms on any word (N7): "no X", "X free", "sin X", "zero X", "not too X". The only exceptions are words
 * that are never food: "no thanks", "no problem", "no idea", "no money" (M4's "I have no money, what can I cook"),
 * "no time", "no wait" (adjudication B: a correction, not a restriction); and "free" after a person, a verb or an adverb ("i'm free", "feel free", "for free").
 */
const RESTRICTION_CUES: readonly RegExp[] = [
  /\bno\s+(?!(?:thanks?|thank you|thx|problems?|probs|worries|worry|idea|clue|rush|money|cash|time|wait)\b)\p{L}/u,
  /(?<![\p{L}\p{N}'-])(?!(?:feel|for|i'?m|im|am|is|are|was|were|be|been|being|get|got|set|you|me|we|they|he|she|it'?s|it|totally|completely|so|very|pretty|really|break|toll|tax|duty|scot|hands|fancy|stay|keep|run|roam|home|walk)\s+free\b)\p{L}[\p{L}'-]*\s+free\b/u,
  /\b(?:sin|sans|ohne|senza|zonder|zero)\s+\p{L}/u,
  /\bnot too \p{L}/u,
  // M5 final I2 (when in doubt, health): the restriction verbs and negators the N7 lists missed, on any word.
  // "i'm off sugar" (not "off to", "off out", "off work" …), "X doesn't agree with me", "stay away from X", "steer
  // clear of X", "won't touch X", "nothing with X", and non-English "pas de", "keine", "kein", "sem", "bez", "geen".
  // M6 Step 8 (N2, Ruling 19): "off to / on / camping / work / out / away" is a plan, never a restriction ("off camping").
  /\b(?:i'?m|im|i am|we'?re|we are|i'?ve gone|i went|been|i'?ll be|going)\s+off\s+(?!(?:to|out|now|home|for|on|work|today|tonight|tomorrow|soon|then|again|sick|shopping|duty|camping|away)\b)\p{L}/u,
  /\b(?:do|does|did)(?:n'?t| not)\s+agree\s+with\s+(?:me|us|him|her|them|my)\b/u,
  /\b(?:stay|stays|staying|stayed|keep|keeps|keeping|kept|steer|steers|steering|steered)\s+(?:well\s+)?(?:away\s+from|clear\s+of)\s+\p{L}/u,
  new RegExp(`\\b${NEGATED_VERB}\\s+(?:touch|go near|stomach|tolerate|digest)\\s+\\p{L}`, 'u'),
  // M6 Step 8 (N2, Ruling 19): "can't do / manage / handle" stays a restriction ("can't do dairy", "don't do gluten")
  // except right before a scheduling object: a weekday, "tonight", "the weekend", "that day" or a clock ("can't do
  // monday", "won't manage tonight"). Only those; a weekday carries no food word, so no rule is lost.
  new RegExp(`\\b${NEGATED_VERB}\\s+(?:do|handle|manage)\\s+(?!${SCHEDULING_OBJECT})\\p{L}`, 'u'),
  /\b(?:nothing|none|never)\s+(?:with|of|any|containing)\s+\p{L}/u,
  /\b(?:pas de|keine|kein|keinen|sem|bez|geen)\s+\p{L}|\bpas d'\p{L}/u,
];
/**
 * M5 final I2: cutting or lowering a nutrient ("cutting carbs", "fewer carbs", "less bread"), and advice from a
 * clinician ("my doctor said …", "the dietitian says").
 */
const NUTRIENT = '(?:carbs?|carbohydrates?|sugars?|sweets?|salt|sodium|fats?|calories?|cals?|protein|dairy|gluten|meat|red meat|bread|starch\\w*|alcohol|booze|caffeine|coffee|sweet things|junk|snacks?|portions?)';
const NUTRIENT_CUE = new RegExp(`\\b(?:cut|cuts|cutting|reduce|reducing|reduced|lower|lowering|fewer|less|limit|limiting|restrict\\w*|ditch\\w*|quit\\w*|stop(?:ped|ping)? eating)\\s+(?:(?:the|my|on|down|back|out|down on|back on)\\s+)*${NUTRIENT}\\b`);
const CLINICIAN_CUE = /\b(?:doctors?|dr|gp|dietitians?|dieticians?|nutritionists?|consultants?|nurses?|specialists?|cardiologists?|endocrinologists?|physicians?|midwife|midwives)(?:'s)?\s+(?:said|says|say|told|tells|wants|wanted|advised|advises|recommended|recommends|suggested|suggests|put me|has me|ordered)\b/;
/** Food and drink, food animals, plants, symptom faces, medicine and "no entry" emoji (N7: "put parippu on monday. 🥜"). */
const HEALTH_EMOJI =
  /[\u{1F330}-\u{1F37F}\u{1F950}-\u{1F96F}\u{1F9C0}-\u{1F9CB}\u{1FAD0}-\u{1FADF}\u{1F980}\u{1F990}\u{1F991}\u{1F99E}\u{1F9AA}\u{1F419}\u{1F41F}-\u{1F421}\u{1F402}-\u{1F404}\u{1F40F}-\u{1F411}\u{1F413}\u{1F414}\u{1F416}\u{1F437}\u{1F42E}\u{1F983}\u{1F986}\u{1F41D}\u{2615}\u{1F922}\u{1F92E}\u{1F927}\u{1F912}\u{1F915}\u{1F974}\u{1F637}\u{1F48A}\u{1F489}\u{1FA7A}\u{1FA79}\u{1F6AB}\u{26D4}]/u;
export function dietCue(text: string): boolean {
  const t = normalizeTurn(text);
  return DIET_CUE.test(t) || RESTRICTION_CUES.some((r) => r.test(t)) || NUTRIENT_CUE.test(t) || CLINICIAN_CUE.test(t) || HEALTH_EMOJI.test(t);
}

/** Words that make an ingredient named in a plan clause a rule, not a dish ("no peanuts", "peanut free"). */
const AVOID_CUE = /\b(no|not|nothing|none|without|free|avoid\w*|allerg\w*|except|skip\w*|never)\b|-free\b/;

/**
 * Fix round 1 I1: a plan clause's dish words state a health rule ("no peanuts", "nothing with nuts", "peanut free",
 * "i'm allergic to eggs"): a rule statement, a severity or health word, or an avoid cue with an ingredient or rule
 * term named. Such words are never a dish: the turn takes M4's health path for them. A dish that only names an
 * ingredient ("your eggs") is still a dish.
 */
export function planClauseHasHealth(phrase: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const t = normalizeTurn(phrase);
  if (HEALTH_WORDS.test(t) || severityFromText(t, graph) !== null || parseRuleStatement(t, graph) !== null) return true;
  return AVOID_CUE.test(t) && mentionsHealthTerm(t, graph, terms);
}

/** One weekday as a closed form: a name or its usual abbreviation, with an optional plural "s". */
const WD = '(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat)s?';
const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const NUMBER = `(\\d|${Object.keys(NUMBER_WORDS).join('|')})`;
/** Clause boundaries: punctuation and joining words only; a boundary is never a leftover word. */
const SEP = /\s*(?:[,;.!?\n]+|\band\b|\balso\b|\bthen\b|\bso\b|\bbut\b)\s*/;
const LEAD = /^(?:plan|sort) (?:my|the|this) week\s*(?::|,|-|$)\s*/;
/**
 * `pick N( dishes)?( for this week)?( after <weekday>)?`, with one optional "more" before or after the noun (M5 final
 * I1: "pick two more", "pick 2 more dishes", "pick 2 dinners more"). N is the number of NEW picks: `resolvePlanRequest`
 * runs `suggestPlan` after the named days, so "more" reads exactly as the bare form does.
 */
const PICK_NOUN = '(?:dishes|dinners|meals|things)';
const PICK_CLAUSE = new RegExp(
  `^(?:pick|choose) ${NUMBER}(?: more(?: ${PICK_NOUN})?| ${PICK_NOUN}(?: more)?)?(?: for (?:this|the|my) week)?(?: after ${WD})?$`,
);
const HARD_CLAUSE = /^(?:it'?s |it is )?(?:a )?(?:hard|busy|rough|tough) week$/;
const DISH_DAY = new RegExp(`^(put )?(?:the )?(.+?) (?:on )?${WD}$`);
const DAY_DISH = new RegExp(`^(?:on )?${WD}:? (?:the )?(.+)$`);

/** The exact names code accepts for a dish: its title, its title without the bracketed gloss, its slug's last segment. */
function dishForms(dishes: readonly { slug: string; title: string }[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const d of dishes) {
    const title = normalizeTurn(d.title);
    const last = d.slug.slice(d.slug.lastIndexOf('/') + 1);
    for (const f of [title, title.replace(/\s*\([^)]*\)\s*$/, '').trim(), last, last.replace(/-/g, ' ')]) if (f !== '') out.add(f);
  }
  return out;
}

const pickOf = (word: string): number => (/^\d$/.test(word) ? Number(word) : NUMBER_WORDS[word]);
const dayOf = (word: string): string => {
  const w = word.replace(/s$/, '');
  return WEEKDAY_NAMES.find((n) => n === w || (w.length >= 3 && n.startsWith(w))) ?? w;
};

/**
 * The player's own words, normalised, or null for a safety turn or text cut by the injection marker or a paste.
 * Exported for the check-off grammar (M6 Step 8), which reads the whole message the same way (5a).
 */
export function ownClauseText(text: string): string | null {
  const whole = stripPageEvents(text).text;
  if (SAFETY_INTENTS.has(classifyTurn(whole))) return null;
  const own = normalizeTurn(ownWords(text));
  if (own === '' || own !== normalizeTurn(whole)) return null;
  return own;
}

type ClosedPlan = { days: { weekday: string; dish: string }[] | null; pick: number | null; hard: boolean | null; after: string | null };

/**
 * A plan request read by code alone (§7.5: planning works with the AI off), from a closed grammar over the WHOLE
 * message: an optional lead ("plan my week:"), then clauses that are each exactly one of
 * `(put )?(the )?<dish> (on )?<weekday>`, `(on )?<weekday> (the )?<dish>` (with the lead), `pick N( dishes)?( for
 * this week)?( after <weekday>)?`, or `(it's )?a hard week`. `<dish>` is an exact canon dish name (its title, the
 * title without its gloss, or its slug's last segment). Without the lead a dish clause needs "put". One clause that
 * is not exactly one of these, and code plans nothing (null): the model's checked proposal, or the scripted
 * engine, takes the message. Null for a safety turn and for injected or pasted text.
 */
export function planIntent(text: string, dishes: readonly { slug: string; title: string }[]): ClosedPlan | null {
  const own = ownClauseText(text);
  const forms = dishForms(dishes);
  if (own === null || correctionIn(own, forms)) return null;
  const s = own.replace(/[.!?]+$/, '');
  const lead = LEAD.exec(s);
  const clauses = closedSplit(lead ? s.slice(lead[0].length) : s);
  if (clauses.length === 0) return null;
  const days: { weekday: string; dish: string }[] = [];
  let pick: number | null = null;
  let hard: boolean | null = null;
  let after: string | null = null;
  let closed = false;
  for (const c of clauses) {
    let m: RegExpExecArray | null;
    closed = true;
    if (HARD_CLAUSE.test(c)) hard = true;
    else if ((m = PICK_CLAUSE.exec(c)) !== null && pick === null) {
      pick = pickOf(m[1]);
      const a = m.at(2);
      if (a !== undefined) after = dayOf(a);
    } else if ((m = DISH_DAY.exec(c)) !== null && (lead !== null || m.at(1) !== undefined) && forms.has(m[2])) {
      days.push({ weekday: dayOf(m[3]), dish: m[2] });
    } else if (lead !== null && (m = DAY_DISH.exec(c)) !== null && forms.has(m[2])) {
      days.push({ weekday: dayOf(m[1]), dish: m[2] });
    } else return null;
  }
  if (!closed || (pick !== null && (pick < 1 || pick > 7))) return null;
  return { days: days.length > 0 ? days : null, pick, hard, after };
}

/**
 * Fix round 5 (5a ruling): the closed neutral fillers: ok, please, thanks (also, and and so already break clauses,
 * SEP). They break a clause like punctuation and are no clause of their own; nothing else is a filler. M5 final
 * (parked m6): "idk" and "lol" are not fillers: they signal doubt, as "maybe" does, so a message with one gets no
 * code card.
 */
export const FILLER = /\s*\b(?:ok|okay|please|pls|thanks|thank you)\b\s*/;
/** The clauses of the player's words for the closed readers: split at SEP and at the fillers, empty ones dropped. */
const closedSplit = (own: string): string[] =>
  own
    .split(SEP)
    .flatMap((c) => c.split(FILLER))
    .map((c) => c.trim())
    .filter((c) => c !== '');

/**
 * Fix round 5 (5c ruling): a correction cue in the player's words ("no wait", "actually", "instead", "scratch that",
 * "i mean"). Code builds no plan or profile card from such a message, and the model's are dropped too: the ask
 * (`correctionAsks`) instead. Over-catches on purpose ("I actually like Mondays").
 */
const CORRECTION_CUE = /\b(?:no,? wait|wait,? no|instead|scratch that|i mean|i meant)\b/;
/**
 * Adjudication B: "actually" is a cue only when a time, a weekday or a dish follows within 3 words, with only
 * connecting words between ("actually 7", "actually make it tuesday", "actually, the onigiri"); "I actually like
 * parippu" is no correction.
 */
const ACTUALLY_CONNECTOR = /^(?:make|it|its|it's|to|on|at|for|the|a|put|have|do|i|mean|no|wait|that|then|um|er|erm|uh)$/;
const TIME_TOKEN = /^(?:\d{1,2}(?:[:.]\d{2})?(?:am|pm|ish)?|am|pm|noon|midday|midnight|half|quarter|o'?clock)$/;
const WEEKDAY_TOKEN = new RegExp(`^${WD}$`);
/** The player's words as tokens with their offsets in `own` (punctuation made spaces, one for one). */
function tokensOf(own: string): { w: string; at: number }[] {
  // M5 final (parked m3): a token's trailing ":" (or "," "-", already spaces) is punctuation, so "actually:" is "actually".
  const clean = own.replace(/[^\p{L}\p{N}':.\s]/gu, ' ').replace(/[.:](?=[.:]*(?:\s|$))/g, ' ');
  return [...clean.matchAll(/\S+/g)].map((m) => ({ w: m[0], at: m.index }));
}

/** M5 final m6: a count after "actually" ("pick 2, actually three") is a cue in a message with a pick clause. */
const COUNT_TOKEN = new RegExp(`^(?:\\d|${Object.keys(NUMBER_WORDS).join('|')})$`);
const PICK_WORD = /\b(?:pick|choose)\b/;

/** The offsets of each "actually" that is a cue (adjudication B; a count too beside a pick, m6). */
function actuallyAt(own: string, forms: ReadonlySet<string>): number[] {
  const tokens = tokensOf(own);
  const words = tokens.map((t) => t.w);
  const picks = PICK_WORD.test(own);
  const out: number[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== 'actually') continue;
    for (let k = i + 1; k <= i + 3 && k < words.length; k++) {
      const w = words[k];
      if (TIME_TOKEN.test(w) || WEEKDAY_TOKEN.test(w) || (picks && COUNT_TOKEN.test(w))) { out.push(tokens[i].at); break; }
      const rest = words.slice(k).join(' ');
      if ([...forms].some((f) => rest === f || rest.startsWith(`${f} `))) { out.push(tokens[i].at); break; }
      if (!ACTUALLY_CONNECTOR.test(w)) break;
    }
  }
  return out;
}
const actuallyCue = (own: string, forms: ReadonlySet<string>): boolean => actuallyAt(own, forms).length > 0;
/** A correction cue in the player's own words (normalised `own`), with the canon dish forms for "actually". */
const correctionIn = (own: string, forms: ReadonlySet<string>): boolean => CORRECTION_CUE.test(own) || actuallyCue(own, forms);
export function correctionCue(text: string, dishes: readonly { slug: string; title: string }[] = []): boolean {
  return correctionIn(normalizeTurn(ownWords(text)), dishForms(dishes));
}

/** A part of a plan or profile card a correction may touch: a dish's day, the pick count, a meal's time, the market day. */
export type CorrectedPart = 'day' | 'pick' | 'meal' | 'market';
export interface CorrectionScope {
  /**
   * The part named by `phrase` (a dish as the player wrote it, "pick", a meal slot, "market") is corrected: its clause,
   * or the clause after it, holds a cue, or the correction names its kind (a weekday corrects days and the market day;
   * a time corrects meal times; a count, the pick; a dish, the days). A correction that names none of these corrects
   * everything, and a part not found in the player's words is corrected: never kept by guess.
   */
  corrected(part: CorrectedPart, phrase: string): boolean;
}

/** The clauses of `own` (split at SEP, as the closed readers split it) with their start and end offsets. */
function clauseSpans(own: string): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  let pos = 0;
  for (const m of own.matchAll(new RegExp(SEP.source, 'g'))) {
    if (m[0] === '') continue;
    out.push({ text: own.slice(pos, m.index), start: pos, end: m.index });
    pos = m.index + m[0].length;
  }
  out.push({ text: own.slice(pos), start: pos, end: own.length });
  return out;
}

/**
 * M5 final m5: the 5c ruling clause by clause. Null when the player's words hold no correction cue. Only the parts
 * the correction touches are dropped (with their asks); the rest of the message's cards stand.
 */
export function correctionScope(text: string, dishes: readonly { slug: string; title: string }[]): CorrectionScope | null {
  const own = normalizeTurn(ownWords(text));
  const forms = dishForms(dishes);
  const cues = [...[...own.matchAll(new RegExp(CORRECTION_CUE.source, 'g'))].map((m) => m.index), ...actuallyAt(own, forms)];
  if (cues.length === 0) return null;
  const spans = clauseSpans(own);
  const clauseAt = (at: number): number => Math.max(0, spans.findIndex((c) => at < c.end || c === spans[spans.length - 1]));
  const positional = new Set<number>();
  const kinds = new Set<CorrectedPart>();
  for (const at of cues) {
    const k = clauseAt(at);
    positional.add(k);
    if (k > 0) positional.add(k - 1);
    // What the correction says: from the cue to the end of the clause after it.
    const said = own.slice(at, spans[Math.min(k + 1, spans.length - 1)].end);
    const words = tokensOf(said).map((t) => t.w);
    const named: CorrectedPart[] = [];
    if (words.some((w) => WEEKDAY_TOKEN.test(w))) named.push('day', 'market');
    if (words.some((w) => TIME_TOKEN.test(w)) || parseClock(said) !== null) named.push('meal');
    if (words.some((w) => COUNT_TOKEN.test(w) || /^\d{1,2}$/.test(w))) named.push('pick');
    if ([...forms].some((f) => occursAsWord(said, f))) named.push('day');
    for (const n of named.length > 0 ? named : (['day', 'pick', 'meal', 'market'] as const)) kinds.add(n);
  }
  const phrasesOf = (part: CorrectedPart, phrase: string): string[] => {
    if (part === 'meal') return Object.entries(SLOT_FORMS).filter(([, slot]) => slot === phrase).map(([w]) => w);
    if (part === 'pick') return ['pick', 'choose'];
    return [normalizeTurn(phrase)];
  };
  return {
    corrected(part, phrase) {
      if (kinds.has(part)) return true;
      const found = spans.flatMap((c, i) => (phrasesOf(part, phrase).some((p) => p !== '' && occursAsWord(c.text, p)) ? [i] : []));
      return found.length === 0 || found.some((i) => positional.has(i));
    },
  };
}
/** The which-time ask after a corrected meal time (5c): a required, `ai: never` line naming the meal. */
export const CORRECTION_TIME_TRIGGER = 'profile.which_time';
/** The how-many ask after a corrected pick count (M5 final m6): a required, `ai: never` line. */
export const CORRECTION_COUNT_TRIGGER = 'plan.which_count';

const SLOT_FORMS: Readonly<Record<string, MealSlot>> = { breakfast: 'breakfast', brekkie: 'breakfast', lunch: 'lunch', dinner: 'dinner', supper: 'dinner', snack: 'snack' };
const REMINDER = new RegExp(
  `^(?:(?:please )?remind me (?:to |about |of )?)?(?:i )?(?:(?:eat|have) )?(?:my )?(${Object.keys(SLOT_FORMS).join('|')}) (?:is )?(?:at|around|about) (.+?)(?: please)?$`,
);
/** The words a clock may be written in ("like half twelve", "7ish pm", "6:30 pm"); any other word is left over. */
const CLOCK_WORD = /^(?:\d{1,2}(?:[:.]\d{2})?(?:am|pm|ish)?|am|pm|a\.m|p\.m|ish|like|half|quarter|past|to|noon|midday|o'?clock|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|thirty|forty-five)$/;
const MARKET = new RegExp(`^(?:my )?market(?: day)?(?:'s| is)(?: on)? ${WD}$`);

/** A clock's anchor: its hour (digits, an hour word) or noon. Two in one clause is two clocks (M5 final, parked m4). */
const CLOCK_ANCHOR = /^(?:\d{1,2}(?:[:.]\d{2})?(?:am|pm|ish)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|noon|midday)$/;

/** One meal-time reminder clause, read whole: the meal and its ONE clock, or null ("at 6pm 7pm" is a doubt: no card). */
function reminderClause(c: string): { name: MealSlot; start: string } | null {
  const m = REMINDER.exec(c);
  if (m === null) return null;
  const words = m[2].split(/\s+/);
  if (!words.every((w) => CLOCK_WORD.test(w)) || words.filter((w) => CLOCK_ANCHOR.test(w)).length !== 1) return null;
  const clock = parseClock(c);
  return clock === null ? null : { name: SLOT_FORMS[m[1]], start: clock };
}

type CodeClause =
  | { kind: 'day'; weekday: string; dish: string }
  | { kind: 'pick'; pick: number }
  | { kind: 'reminder'; name: MealSlot; start: string }
  | { kind: 'market'; day: number }
  | { kind: 'consumed' };

/** One clause, read whole by a closed form code builds a card from, or null. */
function codeClause(c: string, forms: ReadonlySet<string>, graph: IngredientGraph | null): CodeClause | null {
  let m: RegExpExecArray | null;
  if ((m = DISH_DAY.exec(c)) !== null && m.at(1) !== undefined && forms.has(m[2])) return { kind: 'day', weekday: dayOf(m[3]), dish: m[2] };
  if ((m = PICK_CLAUSE.exec(c)) !== null) {
    const pick = pickOf(m[1]);
    return m.at(2) === undefined && pick >= 1 && pick <= 7 ? { kind: 'pick', pick } : null;
  }
  const timed = reminderClause(c);
  if (timed !== null) return { kind: 'reminder', ...timed };
  if ((m = MARKET.exec(c)) !== null) return { kind: 'market', day: WEEKDAY_NAMES.indexOf(dayOf(m[1]) as (typeof WEEKDAY_NAMES)[number]) };
  if (mealLogClause(c) || pantryClause(c, graph)) return { kind: 'consumed' };
  return null;
}

/** Fix round 5 (5a): a clause M4's meal-log parser reads whole: the player's own "(i )?had|ate …" that it reads as a meal. */
const MEAL_LOG_CLAUSE = /^(?:i )?(?:had|ate)\b/;
const mealLogClause = (c: string): boolean => MEAL_LOG_CLAUSE.test(c) && parseMealStatement(c) !== null;
/**
 * Fix round 5 (5a): a clause M4's pantry parser reads whole: one of its own removal or add patterns from the start
 * of the clause (after the player as subject: "i", "we", "i've got") to its end, naming an item it reads.
 */
const PANTRY_SUBJECT = "(?:(?:i|we)(?:'ve| have)? (?:just )?(?:got )?)?";
const PANTRY_CLAUSES: readonly RegExp[] = [...PANTRY_REMOVAL_PATTERNS, PANTRY_ADD_PATTERN].map((p) => new RegExp(`^${PANTRY_SUBJECT}(?:${p.source})$`));
/**
 * M5 final (parked m5): and every item it names is a food the ingredient graph resolves ("ran out of rice"), so "ran
 * out of patience" or "i got my brother" is no pantry clause. Without the graph, no clause is consumed this way.
 */
function pantryClause(c: string, graph: IngredientGraph | null): boolean {
  if (graph === null || !PANTRY_CLAUSES.some((p) => p.test(c))) return false;
  const items = [...parsePantryRemovals(c), ...parsePantryAdds(c)];
  return items.length > 0 && items.every((i) => knownFood(i, graph));
}

/** A food the graph knows: a name or alias it resolves, or a whole word run inside one ("rice" in "short-grain white rice"). */
function knownFood(item: string, graph: IngredientGraph): boolean {
  if (graph.resolve(item) !== null) return true;
  const q = normalizeName(item);
  if (q === '') return false;
  const runs = [q, q.replace(/(?:es|s)$/, '')].filter((r) => r.length >= 3).map((r) => ` ${r} `);
  return graph.search(q.replace(/(?:es|s)$/, ''), 50).some((h) => runs.some((r) => ` ${normalizeName(h.matched)} `.includes(r) || ` ${normalizeName(h.name)} `.includes(r)));
}

/**
 * Fix round 4 (N6 ruling): the message read whole for code-built cards. Every clause must be exactly one closed form
 * (`put (the )?<dish> (on )?<weekday>`, `pick N( dishes)?( for this week)?`, a meal-time reminder, a stated market
 * day) or a closed neutral clause (please, thanks, ok, a greeting); one other clause anywhere ("no wait, 7pm", "for
 * my brother", "actually tuesday", "bitte") and code builds no card from the message. A second pick, or a second
 * time for one meal, is a doubt: no card either. Null too for a safety turn and outside the player's own words.
 */
function codeClauses(text: string, dishes: readonly { slug: string; title: string }[], graph: IngredientGraph | null): { own: string; clauses: CodeClause[] } | null {
  const own = ownClauseText(text);
  const forms = dishForms(dishes);
  if (own === null || correctionIn(own, forms)) return null;
  const clauses: CodeClause[] = [];
  for (const c of closedSplit(own)) {
    const read = codeClause(c, forms, graph);
    if (read === null) return null;
    clauses.push(read);
  }
  const picks = clauses.filter((c) => c.kind === 'pick');
  const meals = clauses.flatMap((c) => (c.kind === 'reminder' ? [c.name] : []));
  if (picks.length > 1 || new Set(meals).size !== meals.length) return null;
  return { own, clauses };
}

/**
 * The closed plan clauses of a message whose every clause is closed (`codeClauses`, N6): `put (the )?<dish> (on
 * )?<weekday>` and `pick N( dishes)?( for this week)?`. The server proposes them when the model made no plan call.
 * Null when there are none, when any clause is not closed, for a safety turn, and outside the player's own words.
 */
export function planWordsIn(
  text: string,
  dishes: readonly { slug: string; title: string }[],
  graph: IngredientGraph | null = null,
): { days: { weekday: string; dish: string }[] | null; pick: number | null; hard: null; after: null } | null {
  const read = codeClauses(text, dishes, graph);
  if (read === null) return null;
  const days = read.clauses.flatMap((c) => (c.kind === 'day' ? [{ weekday: c.weekday, dish: c.dish }] : []));
  const pick = read.clauses.flatMap((c) => (c.kind === 'pick' ? [c.pick] : [])).at(0) ?? null;
  if (days.length === 0 && pick === null) return null;
  return { days: days.length > 0 ? days : null, pick, hard: null, after: null };
}

/** A symptom, condition or diet word anywhere in the message: code builds no reminder or market card from it. */
const symptomOrDiet = (own: string): boolean => HEALTH_WORDS.test(own) || dietCue(own);

/**
 * Meal-time reminders the player sets for themself, for a code-built profile card: each clause exactly
 * `(remind me (to|about) )?(i )?(eat|have )?(my )?<meal> (is )?(at|around|about) <clock>`, the clock in clock words
 * only and read by M4's clock parser, in a message whose every clause is closed (`codeClauses`, N6; pass the canon
 * `dishes` so a closed plan clause counts as closed). None in a message with a symptom, condition or diet word, from
 * a safety turn, or outside the player's own words.
 */
export function reminderSlots(text: string, dishes: readonly { slug: string; title: string }[] = [], graph: IngredientGraph | null = null): { name: MealSlot; start: string }[] {
  const read = codeClauses(text, dishes, graph);
  if (read === null || symptomOrDiet(read.own)) return [];
  return read.clauses.flatMap((c) => (c.kind === 'reminder' ? [{ name: c.name, start: c.start }] : []));
}

/**
 * The meal-time reminder clauses inside a longer message, clause by clause (fix round 2's reader): only for the
 * windows a model's own `propose_profile` call left out (Step 8 ruling b, T13), never for a card code builds itself.
 * For each meal, the first such clause. None with a symptom, condition or diet word, from a safety turn, or outside
 * the player's own words.
 */
export function reminderClauses(text: string): { name: MealSlot; start: string }[] {
  const own = ownClauseText(text);
  if (own === null || symptomOrDiet(own)) return [];
  const out: { name: MealSlot; start: string }[] = [];
  for (const c of own.split(SEP).filter((x) => x !== '')) {
    const timed = reminderClause(c);
    if (timed !== null && !out.some((o) => o.name === timed.name)) out.push(timed);
  }
  return out;
}

/**
 * The market day the player states for themself: a clause that is exactly `my market( day)? is (on )?<weekday>` or
 * `market( day)?('s| is) (on )?<weekday>`, in a message whose every clause is closed (`codeClauses`, N6), naming
 * exactly one weekday, with no symptom, condition or diet word. The weekday (0 = Sunday), or null.
 */
export function marketDayStated(text: string, dishes: readonly { slug: string; title: string }[] = [], graph: IngredientGraph | null = null): number | null {
  const read = codeClauses(text, dishes, graph);
  if (read === null || symptomOrDiet(read.own) || parseWeekdays(read.own).length !== 1) return null;
  return read.clauses.flatMap((c) => (c.kind === 'market' ? [c.day] : [])).at(0) ?? null;
}

/**
 * Fix round 5 (5c): the asks for a corrected message, in the player's own words: `profile.which_time` for each meal
 * the message times ("dinner at 6pm, no wait, 7pm"), `plan.which_day` for each canon dish it names with a weekday
 * ("put parippu on monday, actually tuesday"; the dish as the player wrote it), the market-day ask for a market
 * day it states, and `plan.which_count` for a pick count (M5 final m6). Only for the parts the correction touches
 * (`correctionScope`, M5 final m5). Empty without a correction cue. The server adds these after dropping those parts.
 */
export function correctionAsks(text: string, dishes: readonly { slug: string; title: string }[]): LineRef[] {
  const own = normalizeTurn(ownWords(text));
  const scope = correctionScope(text, dishes);
  if (scope === null) return [];
  const asks: LineRef[] = [];
  // A time M4's clock parser reads, or a bare hour ("dinner at 6, actually 7"): the ask only, never a card.
  if (parseClock(own) !== null || /\b\d{1,2}(?:[:.]\d{2})?\b/.test(own)) {
    for (const [word, slot] of Object.entries(SLOT_FORMS)) {
      if (new RegExp(`\\b${word}\\b`).test(own) && scope.corrected('meal', slot) && !asks.some((a) => a.vars.meal === slot)) asks.push(line(CORRECTION_TIME_TRIGGER, { meal: slot }));
    }
  }
  if (parseWeekdays(own).length > 0) {
    const named = [...dishForms(dishes)].filter((f) => occursAsWord(own, f));
    // The longest form only ("parippu curry", not also "parippu").
    for (const f of named.filter((f) => !named.some((g) => g !== f && g.includes(f)))) if (scope.corrected('day', f)) asks.push(line('plan.which_day', { dish: f }));
    if (/\bmarket\b/.test(own) && scope.corrected('market', 'market')) asks.push(line('intake.market_day.ask'));
  }
  // M5 final m6: a corrected pick count ("pick 2, actually 3") asks how many; nothing is picked.
  if (PICK_WORD.test(own) && scope.corrected('pick', 'pick')) asks.push(line(CORRECTION_COUNT_TRIGGER));
  return asks;
}

const NAV_PLACES: Readonly<Record<string, 'kitchen' | 'map' | 'plan' | 'market' | 'book'>> = {
  kitchen: 'kitchen',
  map: 'map',
  'world map': 'map',
  plan: 'plan',
  'week plan': 'plan',
  "week's plan": 'plan',
  'weekly plan': 'plan',
  'meal plan': 'plan',
  'plan for the week': 'plan',
  market: 'market',
  'market list': 'market',
  'shopping list': 'market',
  'market run': 'market',
  book: 'book',
  'recipe book': 'book',
};
const NAV_VERB =
  /^(?:(?:please|pls|can you|could you|can we|let'?s)\s+)?(?:take me|bring me|go|get me|head|show me|open|open up|visit|go see|see)(?:\s+back)?(?:\s+(?:to|into))?\s+(?:the\s+|my\s+)?(.+?)(?:\s+please)?$/;
const kebab = (s: string): string => s.replace(/-/g, ' ');

/**
 * Where a "take me to the market" / "open my recipe book" / "visit Haruka" / "open the parippu recipe" turn asks
 * to go (Ruling 15), read by code: a fixed place, a known cook id or a canon slug (the whole slug or its last
 * segment, hyphens read as spaces). Anything else is null; a navigation is never guessed. The result is only ever
 * a chip the player taps (`go` part): nothing moves by itself. Null for a safety turn (emergency, medical, child).
 */
export function navIntent(text: string, ids: { cooks: ReadonlySet<string>; slugs: ReadonlySet<string> }): NavTarget | null {
  const whole = stripPageEvents(text).text;
  if (SAFETY_INTENTS.has(classifyTurn(whole))) return null;
  const own = normalizeTurn(ownWords(text));
  if (own === '' || own !== normalizeTurn(whole)) return null;
  const m = NAV_VERB.exec(own.replace(/[.!?]+$/, '').trim());
  if (m === null) return null;
  const place = m[1].trim();
  if (Object.hasOwn(NAV_PLACES, place)) return { to: NAV_PLACES[place] };
  const who = place.replace(/'s(?:\s+(?:kitchen|place|house|home))?$/, '').trim();
  const words = who.split(/\s+/);
  if (words.length <= 3) {
    for (const cook of [...ids.cooks].sort()) {
      if (who === kebab(cook) || words[words.length - 1] === kebab(cook)) return { to: 'visit', cook };
    }
  }
  const dish = place.replace(/\s+(?:recipe|recipe card|card)$/, '').trim();
  for (const slug of [...ids.slugs].sort()) {
    const last = slug.slice(slug.lastIndexOf('/') + 1);
    if (dish === slug || dish === last || dish === kebab(last)) return { to: 'recipe', slug };
  }
  return null;
}

/** The `{place}` of a chip's `nav.offer` line; `name` is the cook's, the dish's or the stall keeper's display name for those targets. */
export function navPlace(target: NavTarget, name: string | null): string {
  switch (target.to) {
    case 'kitchen':
      return 'the kitchen';
    case 'map':
      return 'the map';
    case 'plan':
      return "the week's plan";
    case 'market':
      return 'the market list';
    case 'book':
      return 'your Recipe Book';
    case 'visit':
      return `${name ?? target.cook}'s kitchen`;
    case 'recipe':
      return name ?? 'the recipe';
    case 'stalls':
      return 'the market stalls';
    case 'stall':
      return name === null ? 'the stall' : `${name}'s stall`;
  }
}
