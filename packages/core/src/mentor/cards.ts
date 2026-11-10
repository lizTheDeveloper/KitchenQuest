import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { SEVERE, type Rule, type Severity } from '../rules/types';
import { windowEnd, WEEKDAY_NAMES, type MealSlot } from './parse';
import type { RuleTerm } from './rule-terms';
import { spell } from './spell';

/**
 * Proposal cards and their read-backs, built by code from confirmed data (§2.1, §7.6b.2). The
 * model may suggest a term or a time; these functions decide what the card says.
 */

/** A written line to say: a `content/dialogue/pan.yaml` trigger and its variables. */
export interface LineRef {
  trigger: string;
  vars: Record<string, string>;
}
export type ProposalKind = 'rule' | 'meal' | 'profile' | 'pantry';
type RuleForm = 'rule_allergen' | 'rule_intolerance' | 'rule_diet';

export interface RuleCard {
  kind: 'rule';
  rule: Omit<Rule, 'id'>;
  severe: boolean;
  severityUnclear: boolean;
  form: RuleForm;
  display: { ingredient: string; spelled: string; severity: string; covers: string };
  readback: LineRef[];
}
export type MealItem = { kind: 'dish'; slug: string; servings: number } | { kind: 'free'; description: string };
export interface MealEntry {
  eatenOn: string;
  slot: MealSlot;
  item: MealItem;
}
export interface MealCard {
  kind: 'meal';
  meal: MealEntry;
  summary: string;
  estimate: boolean;
  readback: LineRef[];
}
export interface ProfilePatch {
  marketDays?: number[];
  mealsPerWeek?: number | null;
  country?: string | null;
  region?: string | null;
  mealWindows?: { name: MealSlot; start: string; end: string }[];
}
/** A profile patch as proposed: a meal window may leave out `end` (it becomes start + 60). */
export type ProfilePatchInput = Omit<ProfilePatch, 'mealWindows'> & {
  mealWindows?: { name: MealSlot; start: string; end?: string }[];
};
export interface ProfileCard {
  kind: 'profile';
  patch: ProfilePatch;
  summary: string;
  readback: LineRef[];
}
export interface PantryItem {
  name: string;
  ingredientId: string | null;
}
export interface PantryCard {
  kind: 'pantry';
  add: PantryItem[];
  remove: string[];
  summary: string;
  readback: LineRef[];
}
export type ProposalCard = RuleCard | MealCard | ProfileCard | PantryCard;
export type RuleCardResult =
  | { ok: true; card: RuleCard }
  | { ok: false; reason: 'unknown_term'; line: LineRef }
  | { ok: false; reason: 'ambiguous'; options: { id: string; name: string }[]; line: LineRef };

export const SEVERITY_WORDS: Readonly<Record<Severity, string>> = Object.freeze({
  anaphylactic: 'a severe allergy',
  allergy: 'an allergy',
  intolerance: 'an intolerance',
  preference: 'a preference',
});
export const MEAL_DESCRIPTION_MAX = 200; // N-7; the API imports it (Step 5)
const PANTRY_NAME_MAX = 80;
const COVERS_MAX = 8;
const AMBIGUOUS_OPTIONS = 5;

/** "a", "a and b", "a, b and c". */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The names of `ids` and every isA descendant, unique and sorted, at most 8 then "and N more". */
function coversText(ids: readonly string[], graph: IngredientGraph): string {
  const names = new Set<string>();
  for (const id of ids) for (const each of [id, ...graph.descendants(id)]) names.add(graph.get(each).name);
  const sorted = [...names].sort();
  if (sorted.length <= COVERS_MAX) return joinAnd(sorted);
  return `${sorted.slice(0, COVERS_MAX).join(', ')} and ${sorted.length - COVERS_MAX} more`;
}

interface Resolved {
  ids: string[];
  name: string;
  form: RuleForm | null;
  termSeverity: Severity | null;
}

function cardFor(target: Resolved, inputSeverity: Severity | null, graph: IngredientGraph): RuleCard {
  const severity = inputSeverity ?? target.termSeverity ?? 'anaphylactic';
  const severityUnclear = inputSeverity === null && target.termSeverity === null;
  const severe = SEVERE.has(severity);
  const form: RuleForm = target.form ?? (severe ? 'rule_allergen' : 'rule_intolerance');
  const kind = target.ids.some((id) => graph.descendants(id).length > 0) ? 'category' : 'ingredient';
  const display = {
    ingredient: target.name,
    spelled: spell(target.name),
    severity: form === 'rule_diet' ? 'a diet rule' : SEVERITY_WORDS[severity],
    covers: coversText(target.ids, graph),
  };
  const readback: LineRef[] = [];
  if (severityUnclear) readback.push({ trigger: 'rule.severity_unclear', vars: {} });
  readback.push(
    severe
      ? { trigger: 'rule.readback', vars: { ...display } }
      : {
          trigger: 'rule.readback.no_spelling',
          vars: { ingredient: display.ingredient, severity: display.severity, covers: display.covers },
        },
  );
  return {
    kind: 'rule',
    rule: { target: { kind, ids: [...target.ids] }, type: 'avoid', severity },
    severe,
    severityUnclear,
    form,
    display,
    readback,
  };
}

/**
 * A rule card for what the player named, or why there is none. In order: a rule-term phrase,
 * an exact graph name or alias, else the search hits as options (never auto-picked), else
 * unknown. Can't verify is never safe: nothing narrower than the term is ever proposed.
 */
export function buildRuleCard(
  input: { term: string; severity: Severity | null },
  graph: IngredientGraph,
  terms: readonly RuleTerm[],
): RuleCardResult {
  const term = normalizeName(input.term);
  const entry = terms.find((t) => t.phrases.some((p) => normalizeName(p) === term));
  if (entry) {
    const target = { ids: entry.ids, name: entry.name, form: entry.form, termSeverity: entry.severity };
    return { ok: true, card: cardFor(target, input.severity, graph) };
  }
  const id = graph.resolve(term);
  if (id !== null) {
    const target = { ids: [id], name: graph.get(id).name, form: null, termSeverity: null };
    return { ok: true, card: cardFor(target, input.severity, graph) };
  }
  const hits = graph.search(term, AMBIGUOUS_OPTIONS);
  if (hits.length > 0) {
    return {
      ok: false,
      reason: 'ambiguous',
      options: hits.map((h) => ({ id: h.id, name: h.name })),
      line: { trigger: 'rule.which_one', vars: { term } },
    };
  }
  return { ok: false, reason: 'unknown_term', line: { trigger: 'rule.unknown_term', vars: { term } } };
}

/** The same card with a new severity (the confirm `edits` and the card's severity picker). */
export function withSeverity(card: RuleCard, severity: Severity, graph: IngredientGraph, terms: readonly RuleTerm[]): RuleCard {
  const entry = terms.find((t) => t.name === card.display.ingredient && t.form === card.form);
  const target: Resolved = entry
    ? { ids: entry.ids, name: entry.name, form: entry.form, termSeverity: entry.severity }
    : { ids: card.rule.target.ids, name: card.display.ingredient, form: null, termSeverity: null };
  return cardFor(target, severity, graph);
}

function servingsWords(servings: number): string {
  if (servings === 1) return 'one serving';
  if (servings === 0.5) return 'half a serving';
  if (servings === 2) return 'two servings';
  return `${servings} servings`;
}

export function buildMealCard(input: {
  eatenOn: string;
  slot: MealSlot;
  dish?: { slug: string; title: string; servings: number };
  description?: string;
}): MealCard {
  let item: MealItem;
  let summary: string;
  if (input.dish) {
    item = { kind: 'dish', slug: input.dish.slug, servings: input.dish.servings };
    summary = `${input.dish.title}, ${servingsWords(input.dish.servings)}, ${input.slot}`;
  } else {
    const description = (input.description ?? '').trim().slice(0, MEAL_DESCRIPTION_MAX).trim();
    if (description === '') throw new Error('buildMealCard: a meal needs a dish or a description');
    item = { kind: 'free', description };
    summary = `${description}, ${input.slot}`;
  }
  return {
    kind: 'meal',
    meal: { eatenOn: input.eatenOn, slot: input.slot, item },
    summary,
    estimate: item.kind === 'free',
    readback: [{ trigger: 'log.confirm_readback', vars: { summary } }],
  };
}

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** A profile card. Every meal window carries `end`, so the patch always passes `PUT /profile`. */
export function buildProfileCard(input: ProfilePatchInput): ProfileCard {
  const patch: ProfilePatch = {};
  const parts: string[] = [];
  if (input.marketDays !== undefined) {
    patch.marketDays = [...input.marketDays];
    const names = input.marketDays.map((d) => capitalised(WEEKDAY_NAMES[d] ?? String(d)));
    parts.push(names.length === 0 ? 'no market day' : `market ${names.length === 1 ? 'day' : 'days'} ${joinAnd(names)}`);
  }
  if (input.mealsPerWeek !== undefined) {
    patch.mealsPerWeek = input.mealsPerWeek;
    const n = input.mealsPerWeek;
    parts.push(n === null ? 'meals a week not set' : `${n} ${n === 1 ? 'meal' : 'meals'} a week`);
  }
  if (input.country !== undefined) patch.country = input.country;
  if (input.region !== undefined) patch.region = input.region;
  if (input.country !== undefined || input.region !== undefined) {
    const place = [input.region, input.country].filter((p): p is string => typeof p === 'string' && p !== '').join(', ');
    parts.push(place === '' ? 'no region' : place);
  }
  if (input.mealWindows !== undefined) {
    patch.mealWindows = input.mealWindows.map((w) => ({ name: w.name, start: w.start, end: w.end ?? windowEnd(w.start) }));
    parts.push(...patch.mealWindows.map((w) => `${w.name} ${w.start}`));
  }
  if (Object.keys(patch).length === 0) throw new Error('buildProfileCard: the patch is empty');
  const summary = parts.join('; ');
  return { kind: 'profile', patch, summary, readback: [{ trigger: 'profile.readback', vars: { summary } }] };
}

export function buildPantryCard(input: { add: string[]; remove: string[] }, graph: IngredientGraph): PantryCard {
  const clean = (names: string[]) =>
    names.map((n) => n.trim().slice(0, PANTRY_NAME_MAX).trim()).filter((n) => n !== '');
  const add = clean(input.add).map((name) => ({ name, ingredientId: graph.resolve(name) }));
  const remove = clean(input.remove);
  if (add.length === 0 && remove.length === 0) throw new Error('buildPantryCard: nothing to add or remove');
  const parts: string[] = [];
  if (add.length > 0) parts.push(`add ${joinAnd(add.map((a) => a.name))}`);
  if (remove.length > 0) parts.push(`remove ${joinAnd(remove)}`);
  const summary = parts.join('; ');
  return { kind: 'pantry', add, remove, summary, readback: [{ trigger: 'pantry.readback', vars: { summary } }] };
}

/** A rule card whose severity is severe (`anaphylactic` or `allergy`): it needs a tap (§7.6). */
export function isSevereCard(card: ProposalCard): boolean {
  return card.kind === 'rule' && SEVERE.has(card.rule.severity);
}
