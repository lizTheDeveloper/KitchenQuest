import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { LineRef } from './cards';
import { canonicalText, foldConfusables, type TurnIntent } from './intents';
import { parseRuleStatement, weekdaysOf } from './parse';
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
    const key = normalizeName(n).replace(/s$/, '');
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
  const t = normalizeName(text);
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

/** The plural strips `resolve` uses, applied to rule-term phrases too ("vegans", "celiacs"). */
const pluralForms = (g: string): string[] => [g, ...(g.endsWith('es') ? [g.slice(0, -2)] : []), ...(g.endsWith('s') ? [g.slice(0, -1)] : [])];

/**
 * True when the text names any ingredient (graph name or alias, plurals as `resolve` strips
 * them) or any rule-term phrase, as whole words. The text is NFKC-normalised with invisible
 * characters dropped and lookalikes folded, and read three ways: as written ("peanut-free",
 * "gluten-free"), split at hyphens and apostrophes ("peanut", "free"; "peanut", "s"), and with
 * them removed ("pea-nut" → "peanut"). It over-catches on purpose: it is half of Step 7's
 * consent gate (pre-flight C1).
 */
export function mentionsHealthTerm(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const clean = normalizeName(foldConfusables(canonicalText(text)).replace(/[‘’‛]/g, "'"));
  const asWritten = clean
    .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w !== '');
  const readings = [
    asWritten,
    asWritten.flatMap((w) => w.split(/['-]/)).filter((w) => w !== ''),
    asWritten.map((w) => w.replace(/['-]/g, '')),
  ];
  const phrases = new Set(
    terms.flatMap((t) => t.phrases.map(normalizeName)).flatMap((p) => [p, p.replace(/-/g, ' '), p.replace(/-/g, '')]),
  );
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
 * instruction to the AI, a role prefix at the start of a line, or a role tag.
 */
export const INJECTION_MARKER =
  /note to (the )?(ai|assistant)|\bassistant\s*:|the user (already )?agreed|ignore (all |the )?previous|developer override|do not mention this|^[^\S\n]*(system|developer|tool|user)\s*:|<\/?\s*(system|developer|assistant|tool|user)\b/im;

/** A pasted block starts at a line beginning with -, * or a digit, or a line in capitals of 6+ letters. */
function isPastedLine(l: string): boolean {
  const trimmed = l.trim();
  if (/^[-*\d]/.test(trimmed)) return true;
  const letters = trimmed.replace(/[^\p{L}]/gu, '');
  return letters.length >= 6 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

/**
 * The rule terms in the player's own words only, cut at the first injection marker and the
 * first pasted block. Step 7 drops any model `propose_rule` whose term isn't here (C4).
 * Step 7 must call this on the RAW turn text, before `stripPageEvents`: stripping removes the
 * role prefixes and tags this cuts at, which would turn injected text into the player's own.
 */
export function ruleTermsInPlayerWords(text: string): string[] {
  let own = foldConfusables(canonicalText(text));
  const marker = INJECTION_MARKER.exec(own);
  if (marker) own = own.slice(0, marker.index);
  const lines = own.split('\n');
  const pasted = lines.findIndex((l, i) => i > 0 && isPastedLine(l));
  if (pasted > 0) own = lines.slice(0, pasted).join('\n');
  return parseRuleStatement(own)?.terms ?? [];
}
