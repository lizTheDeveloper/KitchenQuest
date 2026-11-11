// Margin notes (audit M-5, Ruling 9): the player's changes to a recipe, as a structured diff over its ingredients.
// The canon text is never altered: `applyNotes` returns a copy, and "cook with my notes" is checked by the rules
// engine with every change applied. Notes are health data: they never enter a prompt (C-13) and stay private.
import { normalizeName, type IngredientGraph } from '../ingredients/graph';
import { canonicalText } from '../mentor/intents';
import type { ParsedRecipe, RecipeIngredient, StepItem } from '../recipe/types';
import { isValidDate } from '../rules/active';
import { check, type CheckResult, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';

export type NoteOp = { op: 'add'; name: string } | { op: 'swap'; from: string; to: string } | { op: 'remove'; name: string };

export interface MarginNote {
  recipe: string;
  ops: NoteOp[];
  /** The player's own words that aren't an ingredient change ("less salt"), at most NOTE_TEXT_MAX code points. */
  text: string | null;
  /** The local date (YYYY-MM-DD) or ISO timestamp it was written. */
  at: string;
}

export const NOTE_TEXT_MAX = 280;
export const MAX_NOTES_PER_RECIPE = 20;
export const MAX_NOTE_OPS = 12;
export const NOTE_NAME_MAX = 80;

const CLAUSES = /\s*[,;\n]\s*/;
const AND = /\s+(?:and|&|\+)\s+/;
const LEAD = /^(?:(?:i|we)\s+)?(?:also\s+|just\s+)?/;
const AMOUNT = /^(?:(?:some|a|an|the|more|extra|a bit of|a little|a pinch of|a handful of|a squeeze of|a splash of|a dash of)\s+)+/;
const SWAP_INSTEAD = /^(?:used|use|subbed in|subbed|substituted|went with|tried)\s+(.+?)\s+(?:instead of|in place of|rather than)\s+(.+)$/;
const SWAP_FOR = /^(?:swapped|swap|subbed|sub|replaced|replace|switched|switch|changed|change)\s+(?:out\s+)?(?:the\s+)?(.+?)\s+(?:for|with|to)\s+(.+)$/;
const ADD = /^(?:added|add|adding|used|use|threw in|put in|tossed in|stirred in|plus|with|extra)\s+(.+)$/;
const REMOVE = /^(?:no|without|skipped|skip|left out|leave out|omitted|omit|dropped|drop|removed|remove|didn'?t use|did not use|didn'?t add|did not add)\s+(.+)$/;
/** Trailing words that are about amount or manner, not the ingredient: "lime on top" → "lime". */
const TAIL = /\s+(?:on top|at the end|to taste|to finish|as well|too|instead)$/;

function cleanName(raw: string): string {
  return raw.replace(AMOUNT, '').replace(/^the\s+/, '').replace(TAIL, '').replace(/[.!?]+$/, '').trim();
}

const names = (raw: string): string[] =>
  raw
    .split(AND)
    .map(cleanName)
    .filter((n) => n !== '' && [...n].length <= NOTE_NAME_MAX);

/**
 * The recipe line a note names, as written in the recipe: the same normalised name or display name, or the same
 * ingredient once both resolve in the graph ("lentils" → "split moong dal" only if the graph says they are one).
 */
function recipeLine(name: string, recipe: ParsedRecipe, graph: IngredientGraph): string | null {
  const n = normalizeName(name);
  const id = graph.resolve(name);
  for (const l of recipe.ingredients) {
    if (normalizeName(l.name) === n || (l.displayName !== null && normalizeName(l.displayName) === n)) return l.name;
    if (id !== null && graph.resolve(l.name) === id) return l.name;
  }
  return null;
}

/**
 * A typed margin note read by code: "added lime, used chickpeas instead of lentils, less salt" → add lime, swap
 * lentils → chickpeas, rest "less salt". A swap's or removal's name is the recipe's own line when one matches, so
 * `applyNotes` finds it. Clauses it can't read as an ingredient change are kept, in order, as `rest` (null when
 * none), capped at NOTE_TEXT_MAX. At most MAX_NOTE_OPS ops; any beyond go to `rest` unread.
 */
export function parseMarginNote(text: string, recipe: ParsedRecipe, graph: IngredientGraph): { ops: NoteOp[]; rest: string | null } {
  const ops: NoteOp[] = [];
  const rest: string[] = [];
  for (const raw of canonicalText(text).split(CLAUSES)) {
    const clause = raw.trim();
    if (clause === '') continue;
    const c = clause.toLowerCase().replace(/\s+/g, ' ').replace(LEAD, '').replace(/[.!?]+$/, '');
    const found: NoteOp[] = [];
    const swap = SWAP_INSTEAD.exec(c);
    const swapFor = swap ? null : SWAP_FOR.exec(c);
    if (swap || swapFor) {
      const [to, from] = swap ? [swap[1], swap[2]] : [swapFor![2], swapFor![1]];
      const toNames = names(to);
      const fromNames = names(from);
      if (toNames.length === 1 && fromNames.length === 1) {
        found.push({ op: 'swap', from: recipeLine(fromNames[0], recipe, graph) ?? fromNames[0], to: toNames[0] });
      }
    } else {
      const add = ADD.exec(c);
      const remove = add ? null : REMOVE.exec(c);
      if (add) found.push(...names(add[1]).map((name): NoteOp => ({ op: 'add', name })));
      else if (remove) found.push(...names(remove[1]).map((name): NoteOp => ({ op: 'remove', name: recipeLine(name, recipe, graph) ?? name })));
    }
    if (found.length === 0 || ops.length + found.length > MAX_NOTE_OPS) rest.push(clause);
    else ops.push(...found);
  }
  const joined = rest.join(', ');
  return { ops, rest: joined === '' ? null : Array.from(joined).slice(0, NOTE_TEXT_MAX).join('') };
}

const lineOf = (name: string): RecipeIngredient => ({ name, displayName: null, quantity: null, unit: null, note: null });

/**
 * The recipe with every note's ops applied in order, as a copy; the canon recipe is never changed. Names compare
 * normalised. `add` appends a line; `remove` drops every matching line (a missing name is a no-op); `swap` renames
 * matching lines, keeping their amounts, and when the recipe has no such line it adds `to`, so what the player used is
 * always checked. A step that named a removed line keeps the recipe's words for it as plain text.
 */
export function applyNotes(recipe: ParsedRecipe, notes: readonly MarginNote[]): ParsedRecipe {
  type Line = { item: RecipeIngredient; from: number | null };
  let lines: Line[] = recipe.ingredients.map((item, i) => ({ item: { ...item }, from: i }));
  const same = (a: string, b: string): boolean => normalizeName(a) === normalizeName(b);
  for (const note of notes) {
    for (const op of note.ops) {
      if (op.op === 'add') lines.push({ item: lineOf(op.name), from: null });
      else if (op.op === 'remove') lines = lines.filter((l) => !same(l.item.name, op.name));
      else {
        const hit = lines.filter((l) => same(l.item.name, op.from));
        if (hit.length === 0) lines.push({ item: lineOf(op.to), from: null });
        for (const l of hit) l.item = { ...l.item, name: op.to, displayName: null };
      }
    }
  }
  const newIndex = new Map<number, number>();
  lines.forEach((l, i) => {
    if (l.from !== null) newIndex.set(l.from, i);
  });
  const steps = recipe.steps.map((s) => ({
    section: s.section,
    items: s.items.map((it): StepItem => {
      if (it.type !== 'ingredient') return { ...it };
      const at = newIndex.get(it.index);
      if (at !== undefined) return { type: 'ingredient', index: at };
      const old = recipe.ingredients[it.index];
      return { type: 'text', value: old?.displayName ?? old?.name ?? '' };
    }),
  }));
  return {
    meta: { ...recipe.meta, skills: [...recipe.meta.skills], contributors: [...recipe.meta.contributors] },
    ingredients: lines.map((l) => l.item),
    timers: recipe.timers.map((t) => ({ ...t })),
    steps,
    source: recipe.source,
  };
}

/** "Cook with my notes": the rules engine's check of the recipe with every note applied (spec §4.4). */
export function checkWithNotes(
  recipe: ParsedRecipe,
  notes: readonly MarginNote[],
  rules: Rule[],
  graph: IngredientGraph,
  subs: Substitution[],
  date: string,
): CheckResult {
  return check(applyNotes(recipe, notes), rules, graph, subs, date);
}

const NOTE_KEYS = new Set(['recipe', 'ops', 'text', 'at']);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ISO_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const validAt = (at: unknown): boolean => {
  if (typeof at !== 'string') return false;
  if (isValidDate(at)) return true;
  const m = ISO_TIME.exec(at);
  return m !== null && isValidDate(m[1]) && !Number.isNaN(Date.parse(at));
};
const nameOk = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '' && [...v].length <= NOTE_NAME_MAX;

/**
 * A note's shape before it is stored (Step 7). Never throws. Problems: an unknown or sacred recipe (no notes on a
 * sacred dish, audit M-5); not 1–MAX_NOTE_OPS well-formed ops with names of 1–80 characters (an empty note needs text);
 * text over NOTE_TEXT_MAX; a bad `at`; any field outside the shape.
 */
export function validateNote(n: unknown, recipes: ReadonlyMap<string, ParsedRecipe>): string[] {
  if (!isObject(n)) return ['note: not an object'];
  const problems = Object.keys(n)
    .filter((k) => !NOTE_KEYS.has(k))
    .map((k) => `note: unknown field "${k}"`);
  const r = typeof n.recipe === 'string' ? recipes.get(n.recipe) : undefined;
  if (r === undefined) problems.push('note: unknown recipe');
  else if (r.meta.sacred) problems.push('note: sacred recipes take no margin notes');
  if (!Array.isArray(n.ops)) problems.push('note: ops is not a list');
  else {
    if (n.ops.length > MAX_NOTE_OPS) problems.push(`note: more than ${MAX_NOTE_OPS} ops`);
    n.ops.slice(0, MAX_NOTE_OPS + 1).forEach((op: unknown, i: number) => {
      const at = `note: op ${i}`;
      if (!isObject(op)) return problems.push(`${at} is not an object`);
      const keys = op.op === 'swap' ? ['op', 'from', 'to'] : op.op === 'add' || op.op === 'remove' ? ['op', 'name'] : null;
      if (keys === null) return problems.push(`${at}: op is not add, swap or remove`);
      for (const k of Object.keys(op)) if (!keys.includes(k)) problems.push(`${at}: unknown field "${k}"`);
      for (const k of keys.slice(1)) if (!nameOk(op[k])) problems.push(`${at}: ${k} is not 1–${NOTE_NAME_MAX} characters`);
    });
  }
  if (n.text !== null && (typeof n.text !== 'string' || [...n.text].length > NOTE_TEXT_MAX)) problems.push(`note: text is not null or at most ${NOTE_TEXT_MAX} characters`);
  if (Array.isArray(n.ops) && n.ops.length === 0 && (typeof n.text !== 'string' || n.text.trim() === '')) problems.push('note: empty');
  if (!validAt(n.at)) problems.push('note: at is not a date');
  return problems;
}
