import {
  ANAPHYLACTIC_CUE,
  clockForSlot,
  dropMealsMatchingRemovals,
  normalizeName,
  normalizeTurn,
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
  type RuleTerm,
  type Severity,
} from '@kitchenquest/core';
import { filterReply, screenText, touchesHealth } from './filter.js';
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
  const t = normalizeName(screenText(text));
  const variants = new Set(forms(screenText(term)).flatMap((f) => [f, `${f}s`, `${f}es`]));
  return [...variants].some((v) => v !== '' && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(v)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(t));
}

const isSevere = (s: Severity | null): s is Severity => s !== null && SEVERE.has(s);

/**
 * R5 (fix round 2): a model-sourced string may reach a card only when it
 * occurs verbatim in `text` (normalised) and passes the output filter and the
 * health screen (medicines, safety and fit words), so no claim rides in a field.
 */
function cardString(value: string | null, text: string): string | null {
  if (value === null || !occursVerbatim(text, value)) return null;
  const f = filterReply(value, { finish: 'stop' });
  return f.ok && !touchesHealth(value) ? value : null;
}

/**
 * Fix round 5: a place or a pantry item is a short name, so a claim the player typed
 * ("Oaxaca, the frijoles won't make you sick") can't ride in one: at most four words, no
 * sentence punctuation.
 */
const shortName = (value: string | null, text: string): string | null => {
  const v = cardString(value, text);
  return v !== null && !/[,.;:!?]/.test(v) && v.trim().split(/\s+/).length <= 4 ? v : null;
};
/** Fix round 5: "a nut free brownie" names what a dish lacks, which is a claim; a meal card never carries one. */
const MEAL_CLAIM = /\b[a-z]+[ -]free\b/i;
const mealString = (value: string | null, text: string): string | null => {
  const v = cardString(value, text);
  return v !== null && !MEAL_CLAIM.test(screenText(v)) ? v : null;
};

/** The graph or a rule term knows the term, so it is an ingredient name and no claim (fix round 5). */
const knownTerm = (term: string, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): boolean =>
  graph.resolve(term) !== null || ruleTerms.some((t) => t.phrases.some((p) => forms(p).some((f) => forms(term).includes(f))));

/** At most this many words between a severe cue and a term the model proposed (fix round 1, M3). */
const CUE_REACH = 4;
const ALLERGY_CUE = /\ballerg/;

/**
 * The term occurs verbatim within CUE_REACH words of a severe cue ("peanuts
 * nearly killed me"), so an ingredient mentioned in passing ("I had rice with
 * peanuts last week and nearly died": rice) is not kept by the Step 1 bypass.
 */
function nearSevereCue(text: string, term: string): boolean {
  const t = normalizeTurn(text);
  const tokens = [...t.matchAll(/[\p{L}\p{N}'-]+/gu)].map((m) => ({ from: m.index, to: m.index + m[0].length }));
  const wordAt = (pos: number) => {
    const i = tokens.findIndex((w) => w.to > pos);
    return i < 0 ? tokens.length - 1 : i;
  };
  const spans = (re: RegExp) =>
    [...t.matchAll(new RegExp(re.source, `${re.flags.replace('g', '')}g`))].map((m) => [wordAt(m.index), wordAt(m.index + Math.max(0, m[0].length - 1))] as const);
  const cues = [...spans(ANAPHYLACTIC_CUE), ...spans(ALLERGY_CUE)];
  const variants = [...new Set(forms(term).flatMap((f) => [f, `${f}s`, `${f}es`]))].filter((v) => v !== '');
  const terms = variants.flatMap((v) => spans(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'u')));
  return terms.some(([ts, te]) =>
    cues.some(([cs, ce]) => (te < cs ? cs - te - 1 : ce < ts ? ts - ce - 1 : 0) <= CUE_REACH),
  );
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
export function applyPostChecks(calls: ToolArgs[], playerText: string, graph: IngredientGraph, ruleTerms: readonly RuleTerm[]): ToolArgs[] {
  const own = ownWords(playerText);
  const stripped = stripPageEvents(playerText).text;
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
        // R5: a term is checked by C4 below (the player's own rule words); no claim may ride in it,
        // since an unknown or ambiguous term is echoed in a line (fix round 5).
        if (!filterReply(term, { finish: 'stop' }).ok || touchesHealth(term)) break;
        const own_ = ownTerms.some((t) => sameTerm(t, term, graph));
        // The near-cue bypass keeps only a term the graph or a rule term knows (fix round 5); any
        // other is dropped, and severeTermsLeftOut asks.
        if (!own_ && !(isSevere(messageSeverity) && nearSevereCue(own, term) && knownTerm(term, graph, ruleTerms))) break;
        const item = statement?.items.find((i) => sameTerm(i.term, term, graph));
        const modelSevere = isSevere(call.args.severity) ? call.args.severity : null;
        const severity = item ? (item.severity ?? modelSevere) : (messageSeverity ?? modelSevere);
        out.push({ name: 'propose_rule', args: { term, severity } });
        break;
      }
      case 'propose_profile': {
        const args = { ...call.args, region: shortName(call.args.region, own), country: shortName(call.args.country, own) };
        if (args.meal_windows !== null) args.meal_windows = args.meal_windows.map((w) => ({ ...w, start: clockForSlot(own, w.name) ?? w.start }));
        if (args.market_days !== null && weekdays.length > 0) args.market_days = weekdays.map((d) => WEEKDAY_NAMES[d]);
        out.push({ name: 'propose_profile', args });
        break;
      }
      case 'propose_pantry_change': {
        // M4: only items the player named in their own words (the few-shot "milk" is not theirs).
        const add = call.args.add.filter((a) => shortName(a, own) !== null && !removals.some((r) => sameTerm(r, a, graph)));
        const remove = call.args.remove.filter((r) => shortName(r, own) !== null);
        out.push({ name: 'propose_pantry_change', args: { add, remove } });
        break;
      }
      case 'propose_meal_log': {
        // M4: a meal the player's text names (a pasted recipe counts: it is data, and the card asks).
        // R5: each free field must be the player's text and pass the screen, else it is dropped.
        const description = mealString(call.args.description, stripped);
        const dish = mealString(call.args.dish, stripped);
        if (description !== null || dish !== null) out.push({ name: 'propose_meal_log', args: { ...call.args, description, dish } });
        break;
      }
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
  return out.filter(
    (c) => (c.name !== 'propose_meal_log' || keptMeals.has(c.args)) && (c.name !== 'propose_pantry_change' || c.args.add.length + c.args.remove.length > 0),
  );
}

/**
 * The ask-for-dropped-terms checks live in core, so the client's scripted engine uses the same
 * rule (pre-flight C14); re-exported for this module's tests.
 */
export { severeTermsLeftOut } from '@kitchenquest/core';
