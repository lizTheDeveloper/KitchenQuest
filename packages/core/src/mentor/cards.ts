import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { SEVERE, type Rule, type Severity } from '../rules/types';
import { capText } from './intents';
import { windowEnd, WEEKDAY_NAMES, type MealSlot } from './parse';
import type { RuleTerm } from './rule-terms';
import { spell } from './spell';
import type { SlotOffer } from '../toolkit/one-more';
import type { PlanItem } from '../week/plan-item';

/**
 * Proposal cards and their read-backs, built by code from confirmed data (§2.1, §7.6b.2). The
 * model may suggest a term or a time; these functions decide what the card says.
 */

/** A written line to say: a `content/dialogue/pan.yaml` trigger and its variables. */
export interface LineRef {
  trigger: string;
  vars: Record<string, string>;
}
export type ProposalKind = 'rule' | 'meal' | 'profile' | 'pantry' | 'plan' | 'check_off';
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
  /**
   * M5 (Ruling 12): the local date the player bought it. Only the market tick (Steps 6 and 10) sets it, together with
   * `source: 'market'`. M4 rows, and everything told to the Pan, have neither field.
   */
  addedOn?: string;
  /** Where it came from. Missing means told (C9): told food is never rescued, since it has no purchase date. */
  source?: 'told' | 'market';
}
export interface PantryCard {
  kind: 'pantry';
  add: PantryItem[];
  remove: string[];
  /**
   * Server cards only: the pantry rows `remove` was resolved to when the card was proposed. The
   * read-back names exactly those rows, and a confirm removes exactly these ids, never matching
   * names again (M4 Step 8). Absent on cards the client builds for its own pantry.
   */
  removeIds?: string[];
  summary: string;
  readback: LineRef[];
}
/**
 * A week's plan as the Pan proposes it (Form 7-W, M5 Step 8), built by core `buildPlanCard` from code-resolved
 * names (Ruling 14). `items` is the whole week the confirm saves (what the week already held, plus the new
 * items). `checks` is each item's rules check on its own date when the card was built: never 'blocked', since a
 * ⛔ item never reaches a card (it is in `dropped`). `unknown` holds the player's words `matchDish` found no dish
 * for (C19), `dropped` the slugs the rules block. `offer` is the week's One More Technique slot, or null. Like
 * every M4 card (C22), `summary` is code-built and `readback` is the lines the Pan says with it.
 */
export interface PlanCard {
  kind: 'plan';
  weekStart: string;
  items: PlanItem[];
  hard: boolean;
  checks: { slug: string; status: 'ok' | 'swap' | 'unverified' }[];
  unknown: string[];
  dropped: string[];
  offer: SlotOffer | null;
  summary: string;
  /** Fix round 1 M2: the items this card adds to the stored week (a stale card is rebuilt from them). */
  added: PlanItem[];
  /** Fix round 1 M2: `planBasis` of the stored week the card was built on; a confirm saves it only while it matches. */
  basis: string;
  readback: LineRef[];
}
/**
 * M6 Step 8 (Ruling 13, 14, C31): what the player said they got at the market and what the stalls were out of, as row
 * keys of one open market run, matched by code (core `checkOffIntent`, `matchCheckOff`). `source: 'grammar'` is built
 * by code from the closed grammar and ticked at once, with an Undo (spec §7.0 "None (undoable)"); `source: 'model'`
 * came from the model's `propose_check_off` and ticks nothing until the player taps it. `missing` rows are never
 * ticked (their "Out of stock?" chip is Step 10's stall swap). `summary` names the run's own rows, never the player's
 * or the model's words; `readback` is `market.checkoff_readback`.
 */
export interface CheckOffCard {
  kind: 'check_off';
  runId: string;
  got: string[];
  missing: string[];
  source: 'grammar' | 'model';
  summary: string;
  readback: LineRef[];
}
export type ProposalCard = RuleCard | MealCard | ProfileCard | PantryCard | PlanCard | CheckOffCard;
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

/**
 * What the rule covers: the names of `ids` first (sorted), then every isA descendant, nearest
 * kinds first and by name within a depth, each once, at most 8 then "and N more". The targets
 * lead so none hides behind its kinds, and subcategories ("tree nut") lead their members.
 */
function coversText(ids: readonly string[], graph: IngredientGraph): string {
  const own = [...new Set(ids.map((id) => graph.get(id).name))].sort();
  const depth = new Map<string, number>();
  for (const id of ids) {
    for (const kind of graph.descendants(id)) {
      const hops = graph.pathTo(kind, id)!.length - 1;
      const name = graph.get(kind).name;
      depth.set(name, Math.min(hops, depth.get(name) ?? Infinity));
    }
  }
  const kinds = [...depth.keys()]
    .filter((name) => !own.includes(name))
    .sort((a, b) => depth.get(a)! - depth.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
  const names = [...own, ...kinds];
  if (names.length <= COVERS_MAX) return joinAnd(names);
  return `${names.slice(0, COVERS_MAX).join(', ')} and ${names.length - COVERS_MAX} more`;
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
  const term = normalizeName(capText(input.term));
  const entry = terms.find((t) => t.phrases.some((p) => normalizeName(p) === term));
  if (entry) {
    const target = { ids: entry.ids, name: entry.name, form: entry.form, termSeverity: entry.severity };
    return { ok: true, card: cardFor(target, input.severity, graph) };
  }
  const id = graph.resolve(term);
  if (id !== null && graph.get(id).broad === true) {
    // "allergic to herbs": too broad to file (C1 ruling). Ask which one, offering the kinds the graph knows; never a card.
    // Only its direct kinds (N1): a sprig is a form of curry leaf, never offered as a peer of it.
    const kinds = graph.descendants(id).filter((k) => graph.get(k).isA?.includes(id) === true).map((k) => ({ id: k, name: graph.get(k).name })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const names = kinds.map((k) => k.name);
    const examples = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : (names[0] ?? graph.get(id).name);
    return { ok: false, reason: 'ambiguous', options: kinds, line: { trigger: 'rule.which_kind', vars: { term, examples } } };
  }
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
