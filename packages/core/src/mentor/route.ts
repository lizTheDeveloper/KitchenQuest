import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { SEVERE, type Severity } from '../rules/types';
import type { LineRef } from './cards';
import { canonicalText, capText, classifyTurn, foldConfusables, normalizeTurn, stripPageEvents, type TurnIntent } from './intents';
import { parseClock, parseRuleStatement, severityFromText, weekdaysOf, type MealSlot } from './parse';
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
  /\b(al+erg|intoleran|diabet|coeliac|celiac|migraine|ibs|crohn|pregnan|epi-?pen|anaphyla|hives|reaction|symptom|medic|tablet|pill|dose|mg|rash|itch|sick|ill|throw(n|s|ing)? up|threw up|vomit|nause|stomach|tumm(y|ies)|hurt|swell|swollen|wheez|cramp|bloat|diarrh)\w*/i;

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
/** The shortest word checked against the longer labels; shorter ones over-match too much. */
const FUZZY_MIN = 4;
/** Labels this long or longer allow two edits ("pnuts" for peanuts). */
const TWO_EDIT_MIN = 6;

/** One-word graph names, aliases and rule-term phrases of 5+ letters. */
function fuzzyLabels(graph: IngredientGraph, phrases: ReadonlySet<string>): string[] {
  const labels = new Set<string>();
  for (const p of phrases) if (!p.includes(' ') && p.length >= 5) labels.add(p);
  for (const label of graph.labels()) if (!label.includes(' ') && label.length >= 5) labels.add(label);
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
    const id = graph.resolve(part);
    if (id === null) return false;
    const node = graph.get(id);
    return [node.name, ...(node.aliases ?? [])].some((label) => normalizeName(label) === part);
  };
  const fuzzyNames = fuzzyLabels(graph, phrases);
  for (const word of new Set(joined)) {
    if (COMMON_WORDS.has(word)) continue; // "salty", "union", "shall": never a slip or a compound
    if (nearMiss(word, fuzzyNames)) return true;
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

/** Words that say a meal was already eaten: its clock time is when, never a reminder. */
const EATEN = /\b(had|ate|eaten|eating|was|were)\b/i;
/** Reminder or habit words (fix round 1, I2): "remind me … at 6:30 pm", "dinner around 7", "usually at 12". */
const REMINDER_CUE = /\b(remind\w*|reminders?|usually|normally|every ?day|daily|around|about|ish)\b|\d(ish)\b/i;
/** Another person as the subject or the one fed: their meal times are never the player's reminder (I2). */
const THIRD_PARTY =
  /\b(my|our|his|her|their|the) (kids?|child(ren)?|son|sons|daughters?|mum|mom|mother|dad|father|parents?|partner|wife|husband|gran|grandma|grandpa|nan|friends?|flatmates?|baby|boyfriend|girlfriend|family|team|guests?)\b|\b(he|she|they|him|them)\b|\bfor (my|our|the) \w+/i;
/** Words a bare "lunch at half twelve" clause may hold besides its slot word and its time. */
const BARE_WORDS = new Set([
  'at', 'by', 'is', 'my', 'and', 'also', 'then', 'oh', 'please', 'pls', 'like', 'half', 'quarter', 'past', 'to', 'pm', 'am', 'p.m', 'a.m',
  "o'clock", 'oclock', 'noon', 'midday', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirty', 'fifteen', 'forty-five',
]);

/**
 * M5 Step 8 rulings (b) and fix round 1 I2: the meal reminders the player's own words set for themself, read by M4's
 * clock parser. For each slot, the first clause naming it with a time, when that clause is reminder phrasing (a
 * reminder or habit word, or a bare "lunch at half twelve"), is about the player (no other person), says no meal
 * was eaten, and carries no health or symptom word ("dinner at 7:30 pm made me sick" sets nothing). Fixed slot order.
 */
export function reminderSlots(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): { name: MealSlot; start: string }[] {
  const out: { name: MealSlot; start: string }[] = [];
  const clauses = text.split(CLAUSE_SPLIT).map((c) => normalizeTurn(c)).filter((c) => c !== '');
  for (const [slot, word] of Object.entries(SLOT_WORDS) as [MealSlot, RegExp | null][]) {
    if (word === null) continue;
    for (const c of clauses) {
      if (!word.test(c)) continue;
      const clock = parseClock(c);
      if (clock === null) continue;
      const bare = c
        .replace(word, ' ')
        .split(/\s+/)
        .filter((w) => w !== '' && !/^[\d:.]+(am|pm)?$/.test(w))
        .every((w) => BARE_WORDS.has(w));
      // Health or symptom words (HEALTH_WORDS: "made me sick"), any ingredient or rule term, a severity or a rule
      // statement. Not classifyTurn: the M4 gate's health intent over-catches every meal time on purpose.
      const health = HEALTH_WORDS.test(c) || mentionsHealthTerm(c, graph, terms) || severityFromText(c, graph) !== null || parseRuleStatement(c, graph) !== null;
      if (!(REMINDER_CUE.test(c) || bare) || THIRD_PARTY.test(c) || EATEN.test(c) || health) continue;
      out.push({ name: slot, start: clock });
      break;
    }
  }
  return out;
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
    mentionsHealthTerm(text, graph, terms) ||
    severityFromText(text, graph) !== null ||
    parseRuleStatement(text, graph) !== null
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

/** Intents that win over any plan or navigation reading: the safety pre-routes (emergency, medical, child). */
const SAFETY_INTENTS: ReadonlySet<TurnIntent> = new Set(['emergency', 'medical', 'child']);

/**
 * A hard-week phrase in the player's words ("it's a rough week", "hard week"). Core's one list: a model's
 * `hard_week: true` is kept only when the player's own words match it (Step 8 post-check).
 */
const HARD_WORDS = '(?:hard|rough|tough|busy|stressful|exhausting|tiring|difficult|heavy|mad|crazy)\\s+week';
export const HARD_WEEK_PATTERN = new RegExp(`\\b${HARD_WORDS}\\b`);

/** One day word as a plan names it: a weekday (or its abbreviation or plural), "weekend", "tonight" or "tomorrow". */
const DAY_NAME = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|weekend|tonight|tomorrow)(?:'s|s)?";
const DAY = `(?:(?:on|for|at|over)\\s+)?(?:the\\s+)?${DAY_NAME}`;
const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const PLAN_LEAD =
  /^(?:(?:please|pls|can you|could you|would you|help me)\s+)?(?:plan|sort out|sort)\s+(?:out\s+)?(?:my|the|this|our)\s+week(?:'s)?(?:\s+(?:plan|meals|dinners))?(?:\s+for me)?\s*(?:[:,.;!-]+\s*|$)/;
const PICK = new RegExp(
  `^(?:(?:just|please|pls|can you|could you)\\s+)*(?:pick|choose|suggest|plan)(?:\\s+(?:me|us|out))?\\s+(\\d|${Object.keys(NUMBER_WORDS).join('|')})(?:\\s+(?:dishes|dish|things|meals|dinners|recipes))?(?:\\s+for\\s+(?:this|the|my)\\s+week)?(?:\\s+(?:after|from)\\s+${DAY})?$`,
);
const AFTER = new RegExp(`^(?:(?:do|put|have|plan)\\s+(?:them|it|those|the rest)\\s+)?(?:after|from)\\s+${DAY}$`);
const HARD_CLAUSE = new RegExp(
  `^(?:(?:it'?s|it is|this is|it'?ll be|its gonna be|it's going to be)\\s+)?(?:a\\s+)?(?:(?:really|very|super|pretty)\\s+)?${HARD_WORDS}(?:\\s+for me)?$`,
);
const ON_DAY = `\\s+(?:on|for|at|over)\\s+(?:the\\s+)?${DAY_NAME}(?:\\s+(?:plan|night|dinner|lunch|supper|tea))?$`;
const DISH_ON_DAY = new RegExp(`^(?:(?:put|have|do|make|cook|plan)\\s+)?(.+?)${ON_DAY}`);
const PUT_ON_DAY = new RegExp(`^put\\s+(.+?)${ON_DAY}`);
const DAY_FIRST = new RegExp(`^${DAY}\\s*[:-]?\\s+(.+)$`);
const DISH_THEN_DAY = new RegExp(`^(.+?)\\s+${DAY}$`);
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

/** A dish phrase is a short name: at most this many words. */
const DISH_MAX_WORDS = 6;
const CLAUSE = /\s*(?:[,;.!?]|\band then\b|\bthen\b|\band\b|\balso\b|\bplus\b)\s*/;

const dayWord = (m: string): string => m.replace(/'s$/, '');
const dishWords = (s: string): string | null => {
  const d = s.trim();
  return d === '' || d.split(/\s+/).length > DISH_MAX_WORDS || /\d/.test(d) ? null : d;
};

/**
 * A plan request read by code alone (M5 Step 8; §7.5: planning works with the AI off): "plan my week: parippu on
 * Sunday, onigiri Monday", "pick 3", "pick 3 after saturday", "put frijoles de olla on Saturday", "it's a hard week".
 * Dish words are passed on as the player typed them; core `resolvePlanRequest` matches them (no aliases, Ruling
 * 22). The reading is strict: every clause must be a plan clause, else null (the turn goes on, and a message that
 * also states a rule, a meal or anything else is never cut short). Without the "plan my week" lead, a dish clause
 * needs "put". Null for a safety turn (emergency, medical, child: they win) and for text cut by the injection
 * marker or a pasted block (only the player's own words plan).
 */
export function planIntent(
  text: string,
  /** Fix round 1 I1: with the graph and rule terms, a plan clause that states a health rule makes the whole reading null. */
  health?: { graph: IngredientGraph; terms: readonly RuleTerm[] },
): { days: { weekday: string; dish: string }[] | null; pick: number | null; hard: boolean | null; after: string | null } | null {
  const whole = stripPageEvents(text).text;
  if (SAFETY_INTENTS.has(classifyTurn(whole))) return null;
  const own = normalizeTurn(ownWords(text));
  if (own === '' || own !== normalizeTurn(whole)) return null;
  const lead = PLAN_LEAD.exec(own);
  const rest = (lead ? own.slice(lead[0].length) : own).replace(/[.!?]+$/, '').trim();
  const days: { weekday: string; dish: string }[] = [];
  let pick: number | null = null;
  let hard: boolean | null = null;
  let after: string | null = null;
  for (const clause of rest === '' ? [] : rest.split(CLAUSE).filter((c) => c !== '')) {
    let m: RegExpExecArray | null;
    if (HARD_CLAUSE.test(clause)) hard = true;
    else if ((m = PICK.exec(clause)) !== null) {
      pick = /^\d$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
      const afterWord = m.at(2);
      if (afterWord !== undefined) after = dayWord(afterWord);
    } else if ((m = AFTER.exec(clause)) !== null) after = dayWord(m[1]);
    else if ((m = (lead ? DISH_ON_DAY : PUT_ON_DAY).exec(clause)) !== null && dishWords(m[1]) !== null) {
      days.push({ weekday: dayWord(m[2]), dish: dishWords(m[1])! });
    } else if (lead && (m = DAY_FIRST.exec(clause)) !== null && dishWords(m[2]) !== null) {
      days.push({ weekday: dayWord(m[1]), dish: dishWords(m[2])! });
    } else if (lead && (m = DISH_THEN_DAY.exec(clause)) !== null && dishWords(m[1]) !== null) {
      days.push({ weekday: dayWord(m[2]), dish: dishWords(m[1])! });
    } else return null;
  }
  if (days.length === 0 && pick === null && hard === null) return null;
  if (pick !== null && (pick < 1 || pick > 7)) return null;
  if (health !== undefined && days.some((d) => planClauseHasHealth(d.dish, health.graph, health.terms))) return null;
  return { days: days.length > 0 ? days : null, pick, hard, after };
}

const PICK_ANYWHERE = new RegExp(`\\b(?:pick|choose)(?:\\s+(?:me|us|out))?\\s+(\\d|${Object.keys(NUMBER_WORDS).join('|')})\\b`);
const SENTENCE = /[.!?;\n]+/;
const LEADING_FILLER = /^(?:(?:also|and|then|so|now|please|pls|idk|just|oh|ok|okay)\s+)+/;

/**
 * The plan clauses inside a longer message, read by code (M4's "code wins where code can read the player's
 * words", as for pantry removals): "… Also put the frijoles on Saturday's plan, and …" or "idk just pick 3 things".
 * Only "put <dish> on <day>" clauses and "pick N"; nothing else is guessed. The server adds them as the plan call
 * when the model made none. Null when there are none, for a safety turn, and outside the player's own words.
 */
export function planWordsIn(
  text: string,
  /** Fix round 1 I1: with the graph and rule terms, a clause that states a health rule is never a dish. */
  health?: { graph: IngredientGraph; terms: readonly RuleTerm[] },
): { days: { weekday: string; dish: string }[] | null; pick: number | null; hard: boolean | null; after: null } | null {
  if (SAFETY_INTENTS.has(classifyTurn(stripPageEvents(text).text))) return null;
  const own = normalizeTurn(ownWords(text));
  const days: { weekday: string; dish: string }[] = [];
  let pick: number | null = null;
  for (const sentence of own.split(SENTENCE)) {
    for (const raw of sentence.split(CLAUSE)) {
      const clause = raw.trim().replace(LEADING_FILLER, '');
      const put = PUT_ON_DAY.exec(clause);
      const dish = put === null ? null : dishWords(put[1]);
      if (put !== null && dish !== null && !(health !== undefined && planClauseHasHealth(dish, health.graph, health.terms))) {
        days.push({ weekday: dayWord(put[2]), dish });
      }
      const n = PICK_ANYWHERE.exec(clause);
      if (n !== null && pick === null) pick = /^\d$/.test(n[1]) ? Number(n[1]) : NUMBER_WORDS[n[1]];
    }
  }
  if (days.length === 0 && (pick === null || pick < 1 || pick > 7)) return null;
  return { days: days.length > 0 ? days : null, pick: pick !== null && pick >= 1 && pick <= 7 ? pick : null, hard: HARD_WEEK_PATTERN.test(own) ? true : null, after: null };
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

/** The `{place}` of a chip's `nav.offer` line; `name` is the cook's or the dish's display name for those targets. */
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
  }
}
