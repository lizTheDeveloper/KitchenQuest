import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { SEVERE, type Severity } from '../rules/types';
import type { LineRef } from './cards';
import { canonicalText, capText, classifyTurn, foldConfusables, stripPageEvents, type TurnIntent } from './intents';
import { parseClock, parseRuleStatement, severityFromText, weekdaysOf, type MealSlot } from './parse';
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
    mentionsHealthTerm(text, graph, terms) ||
    severityFromText(text, graph) !== null ||
    parseRuleStatement(text, graph) !== null
  );
}

/**
 * M4 Step 9 fix round 2 (E2): an emergency turn whose player words (RAW turn text) also state a rule, or name
 * an ingredient with a severity cue ("I'm allergic to peanuts, I had anaphylaxis once"). The emergency line comes first; the
 * allergy is then never dropped: the rule path (a card, or the ask) follows.
 */
export function emergencyStatesRule(playerText: string, graph: IngredientGraph): boolean {
  const own = ownWords(playerText);
  if (parseRuleStatement(own, graph) !== null) return true;
  // A severity cue (hives, swelling, anaphylaxis) with an ingredient named: the allergen is offered for a card.
  return statesSevere(playerText, graph) && namedIngredients(own, graph).length > 0;
}
