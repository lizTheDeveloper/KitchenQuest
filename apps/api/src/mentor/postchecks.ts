import {
  dropMealsMatchingRemovals,
  normalizeName,
  parseClock,
  parsePantryRemovals,
  parseRuleStatement,
  parseWeekdays,
  playerOwnWords,
  ruleTermsInPlayerWords,
  SEVERE,
  severityFromText,
  stripPageEvents,
  WEEKDAY_NAMES,
  type IngredientGraph,
  type MealSlot,
  type Severity,
} from '@kitchenquest/core';
import type { ToolArgs } from './tools.js';

/**
 * Code wins where code can read the player's words (spike §6.8). Built from
 * core's parsers only; nothing here re-implements one. `playerText` is the RAW
 * turn text: the injection cut (`playerOwnWords`, `ruleTermsInPlayerWords`)
 * runs before `stripPageEvents`, which would otherwise remove the role
 * prefixes it cuts at (Step 1 fix round 1, I1). The parsers then read the
 * player's own words with page events stripped. The graph is always passed
 * (controller ruling, Step 1 round 4).
 */

/** The player's own words, cut at injected or pasted text, with page events stripped. */
const ownWords = (raw: string): string => stripPageEvents(playerOwnWords(raw)).text;

/** A term and its plural strips, normalised, as the graph's `resolve` strips them. */
function forms(term: string): string[] {
  const t = normalizeName(term);
  return [t, ...(t.endsWith('es') ? [t.slice(0, -2)] : []), ...(t.endsWith('s') ? [t.slice(0, -1)] : [])];
}

/** Two terms name the same thing: a shared form, or the graph resolves both to one ingredient. */
function sameTerm(a: string, b: string, graph: IngredientGraph): boolean {
  const fa = forms(a);
  if (forms(b).some((f) => fa.includes(f))) return true;
  const ra = graph.resolve(a);
  return ra !== null && ra === graph.resolve(b);
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The term (or a plural of it) occurs in the text as whole words. */
function occursVerbatim(text: string, term: string): boolean {
  const t = normalizeName(text);
  const variants = new Set(forms(term).flatMap((f) => [f, `${f}s`, `${f}es`]));
  return [...variants].some((v) => v !== '' && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(v)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(t));
}

const isSevere = (s: Severity | null): s is Severity => s !== null && SEVERE.has(s);

const SLOT_WORDS: Readonly<Record<MealSlot, RegExp | null>> = {
  breakfast: /\b(breakfast|brekkie)\b/i,
  lunch: /\blunch\b/i,
  dinner: /\b(dinner|supper)\b/i,
  snack: /\bsnacks?\b/i,
  other: null,
};
const CLAUSE_SPLIT = /[,;.!?]|\band\b|\bthen\b/i;

/** The clock time in the first clause naming `slot`, or null. */
function clockFor(own: string, slot: MealSlot): string | null {
  const word = SLOT_WORDS[slot];
  if (word === null) return null;
  const clause = own.split(CLAUSE_SPLIT).find((c) => word.test(c));
  return clause === undefined ? null : parseClock(clause);
}

/**
 * The model's calls corrected by what the player's own words say:
 * - C4: a rule whose term is not in the player's own rule statement is dropped,
 *   unless a severe cue is present and the player named the term verbatim (Step 1 carry).
 * - Severity: the player's words for that term win (S07); else the message's
 *   severity; else the model's, but only when severe. A model `intolerance` or
 *   `preference` the grammar did not read becomes null, and the card asks.
 * - Meal windows: the clock in the clause naming the slot (T04).
 * - Market days: the weekdays named (T03).
 * - Pantry: every removal the player said is removed (T05, T12), never added,
 *   and a "meal" that is a removed item is dropped (T05).
 */
export function applyPostChecks(calls: ToolArgs[], playerText: string, graph: IngredientGraph): ToolArgs[] {
  const own = ownWords(playerText);
  const statement = parseRuleStatement(own, graph);
  const ownTerms = [...ruleTermsInPlayerWords(playerText), ...(statement?.terms ?? [])];
  const messageSeverity = severityFromText(own, graph);
  const removals = parsePantryRemovals(own);
  const weekdays = parseWeekdays(own);

  const out: ToolArgs[] = [];
  for (const call of calls) {
    switch (call.name) {
      case 'propose_rule': {
        const { term } = call.args;
        const own_ = ownTerms.some((t) => sameTerm(t, term, graph));
        if (!own_ && !(isSevere(messageSeverity) && occursVerbatim(own, term))) break;
        const item = statement?.items.find((i) => sameTerm(i.term, term, graph));
        const modelSevere = isSevere(call.args.severity) ? call.args.severity : null;
        const severity = item ? (item.severity ?? modelSevere) : (messageSeverity ?? modelSevere);
        out.push({ name: 'propose_rule', args: { term, severity } });
        break;
      }
      case 'propose_profile': {
        const args = { ...call.args };
        if (args.meal_windows !== null) args.meal_windows = args.meal_windows.map((w) => ({ ...w, start: clockFor(own, w.name) ?? w.start }));
        if (args.market_days !== null && weekdays.length > 0) args.market_days = weekdays.map((d) => WEEKDAY_NAMES[d]);
        out.push({ name: 'propose_profile', args });
        break;
      }
      case 'propose_pantry_change': {
        const add = call.args.add.filter((a) => !removals.some((r) => sameTerm(r, a, graph)));
        out.push({ name: 'propose_pantry_change', args: { add, remove: [...call.args.remove] } });
        break;
      }
      case 'propose_meal_log':
        out.push({ name: 'propose_meal_log', args: { ...call.args } });
        break;
    }
  }

  const pantryCalls = out.filter((c): c is Extract<ToolArgs, { name: 'propose_pantry_change' }> => c.name === 'propose_pantry_change');
  const missing = removals.filter((r) => !pantryCalls.some((c) => c.args.remove.some((x) => sameTerm(x, r, graph))));
  if (missing.length > 0) {
    if (pantryCalls.length > 0) pantryCalls[0].args.remove.push(...missing);
    else out.push({ name: 'propose_pantry_change', args: { add: [], remove: missing } });
  }

  const meals = out.filter((c): c is Extract<ToolArgs, { name: 'propose_meal_log' }> => c.name === 'propose_meal_log');
  const keptMeals = new Set(dropMealsMatchingRemovals(meals.map((m) => m.args), removals));
  return out.filter((c) => c.name !== 'propose_meal_log' || keptMeals.has(c.args));
}

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
 * Step 1 carry: the player's own words state a severe allergy, but they name an
 * ingredient that neither the rule grammar nor any kept card covers ("i'm
 * vegetarian, peanuts nearly killed me"). The turn then adds a scripted ask
 * (`rule.ask_what_else`), so the dropped term is never silently lost.
 * Over-asks on purpose.
 */
export function severeTermsLeftOut(playerText: string, keptRuleTerms: readonly string[], graph: IngredientGraph): boolean {
  const own = ownWords(playerText);
  if (!isSevere(severityFromText(own, graph))) return false;
  const covered = new Set(
    [...(parseRuleStatement(own, graph)?.terms ?? []), ...keptRuleTerms].map((t) => graph.resolve(t)).filter((id) => id !== null),
  );
  return namedIngredients(own, graph).some((id) => !covered.has(id));
}
