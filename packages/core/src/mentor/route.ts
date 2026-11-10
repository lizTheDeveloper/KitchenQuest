import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import type { LineRef } from './cards';
import type { TurnIntent } from './intents';
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

/**
 * True when the text names any ingredient (graph name or alias, plurals as `resolve` strips
 * them) or any rule-term phrase, as whole words. It over-catches on purpose: it is half of
 * Step 7's consent gate (pre-flight C1).
 */
export function mentionsHealthTerm(text: string, graph: IngredientGraph, terms: readonly RuleTerm[]): boolean {
  const words = normalizeName(text.replace(/[^\p{L}\p{N}'-]+/gu, ' '))
    .split(' ')
    .map((w) => w.replace(/^['-]+|['-]+$/g, ''))
    .filter((w) => w !== '');
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= MAX_NAME_WORDS && i + n <= words.length; n++) {
      if (graph.resolve(words.slice(i, i + n).join(' ')) !== null) return true;
    }
  }
  const joined = words.join(' ');
  return terms.some((t) => t.phrases.some((p) => occursAsWord(joined, normalizeName(p))));
}

/** Text after this is not the player's own words (S19 and the spike's injection cases). */
export const INJECTION_MARKER =
  /note to (the )?(ai|assistant)|\bassistant\s*:|the user (already )?agreed|ignore (all |the )?previous|developer override|do not mention this/i;

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
 */
export function ruleTermsInPlayerWords(text: string): string[] {
  let own = text;
  const marker = INJECTION_MARKER.exec(own);
  if (marker) own = own.slice(0, marker.index);
  const lines = own.split('\n');
  const pasted = lines.findIndex((l, i) => i > 0 && isPastedLine(l));
  if (pasted > 0) own = lines.slice(0, pasted).join('\n');
  return parseRuleStatement(own)?.terms ?? [];
}
