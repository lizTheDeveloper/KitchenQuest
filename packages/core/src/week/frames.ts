// Pantry Frames (spec §17, Ruling 13): a technique with slots, filled from the cupboard. Every filler is checked by
// the rules engine on its own, and the filled dish is checked as a whole. A blocked filler is never chosen; an
// unresolved or label-dependent one is never chosen for the player (❓), and a required slot with nothing that
// passes stays empty and says so. Browser-safe: the filled recipe is built directly, never parsed.
import type { IngredientGraph } from '../ingredients/graph';
import type { PantryItem } from '../mentor/cards';
import type { FrameOption } from '../quests/alternatives';
import type { ParsedRecipe, RecipeIngredient, RecipeStep, StepItem } from '../recipe/types';
import { check, type CheckResult, type CheckStatus, type Finding, type Substitution } from '../rules/check';
import type { Rule } from '../rules/types';

export interface FrameSlot {
  key: string;
  /** Ingredient ids; a pantry item fits when it is one of them or a kind of one (isA). */
  accepts: string[];
  optional: boolean;
}

export interface Frame {
  id: string;
  title: string;
  technique: string;
  status: 'draft' | 'reviewed';
  credit: string;
  slots: FrameSlot[];
  /** Step text with `{slot}` placeholders. */
  steps: string[];
  /** Ingredient ids it can rescue (Use-It-Up). */
  rescues: string[];
}

export type FrameFill = { name: string; ingredientId: string | null } | null;

export interface FilledFrame {
  frame: string;
  fills: Record<string, FrameFill>;
  recipe: ParsedRecipe;
  /** The filled dish's check. Never 'ok' while a required slot is empty (one ❓ finding per empty slot). */
  check: CheckResult;
  emptyRequired: string[];
}

export interface FrameContext {
  rules: Rule[];
  graph: IngredientGraph;
  subs: Substitution[];
  today: string;
}

const RANK: Record<CheckStatus, number> = { ok: 0, swap: 1, unverified: 2, blocked: 3 };
const PLACEHOLDER = /\{([^{}]*)\}/g;
const line = (name: string): RecipeIngredient => ({ name, displayName: null, quantity: null, unit: null, note: null });

function frameMeta(frame: Frame): ParsedRecipe['meta'] {
  return {
    title: frame.title,
    country: '',
    region: '',
    credit: frame.credit,
    cook: '',
    difficulty: 1,
    skills: [frame.technique],
    servings: 1,
    license: 'CC-BY-SA-4.0',
    status: frame.status,
    sacred: false,
    contributors: [],
  };
}

/** A one-line dish of `name`, so one candidate is checked alone. */
function oneLine(name: string, frame: Frame): ParsedRecipe {
  return { meta: frameMeta(frame), ingredients: [line(name)], timers: [], steps: [], source: '' };
}

/** The pantry item fits the slot: its ingredient is accepted, or a kind of an accepted one. */
function fits(item: PantryItem, slot: FrameSlot, graph: IngredientGraph): boolean {
  const id = item.ingredientId;
  if (id === null || !graph.has(id)) return false;
  return slot.accepts.some((a) => a === id || (graph.has(a) && graph.ancestors(id).includes(a)));
}

/** The frame's steps with each `{slot}` an ingredient item; a step naming an empty slot is left out. */
function buildSteps(frame: Frame, index: ReadonlyMap<string, number>): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const text of frame.steps) {
    const items: StepItem[] = [];
    let last = 0;
    let complete = true;
    for (const m of text.matchAll(PLACEHOLDER)) {
      const at = index.get(m[1]);
      if (at === undefined) {
        complete = false;
        break;
      }
      if (m.index > last) items.push({ type: 'text', value: text.slice(last, m.index) });
      items.push({ type: 'ingredient', index: at });
      last = m.index + m[0].length;
    }
    if (!complete) continue;
    if (last < text.length) items.push({ type: 'text', value: text.slice(last) });
    out.push({ section: null, items });
  }
  return out;
}

/**
 * Fill a frame from the pantry. Each candidate is checked alone on `ctx.today`:
 * - ✅ fillers are chosen first, then labelled swaps (the dish's check carries the swap); an earlier `addedOn` first
 *   (use it up), then by name. A pantry item fills one slot at most.
 * - ⛔ fillers are never chosen, not even when picked.
 * - ❓ fillers (label-dependent) and unresolved pantry names are never chosen for the player. The player may pick one
 *   with `pick` (slot key → pantry item name); then it fills the slot and the frame's check is ❓. An unresolved name
 *   may be picked for any slot (the player knows what it is; the engine still can't verify it).
 * - A required slot with no passing candidate goes in `emptyRequired`, never filled by a guess; an optional one is null.
 */
export function fillFrame(frame: Frame, pantry: readonly PantryItem[], ctx: FrameContext, pick?: Record<string, string>): FilledFrame {
  const statusOf = new Map<PantryItem, CheckStatus>();
  const alone = (item: PantryItem): CheckStatus => {
    let s = statusOf.get(item);
    if (s === undefined) {
      s = check(oneLine(item.name, frame), ctx.rules, ctx.graph, ctx.subs, ctx.today).status;
      statusOf.set(item, s);
    }
    return s;
  };
  const used = new Set<PantryItem>();
  const fills: Record<string, FrameFill> = {};
  const emptyRequired: string[] = [];
  const byUseFirst = (a: PantryItem, b: PantryItem): number => {
    const da = a.addedOn ?? '9999-99-99';
    const db = b.addedOn ?? '9999-99-99';
    return RANK[alone(a)] - RANK[alone(b)] || (da < db ? -1 : da > db ? 1 : 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  for (const slot of frame.slots) {
    let chosen: PantryItem | undefined;
    const wanted = pick && Object.hasOwn(pick, slot.key) ? pick[slot.key] : undefined;
    if (typeof wanted === 'string') {
      chosen = pantry.find(
        (p) => !used.has(p) && p.name === wanted && (p.ingredientId === null || fits(p, slot, ctx.graph)) && alone(p) !== 'blocked',
      );
    }
    chosen ??= pantry
      .filter((p) => !used.has(p) && fits(p, slot, ctx.graph))
      .filter((p) => alone(p) === 'ok' || alone(p) === 'swap')
      .sort(byUseFirst)
      .at(0);
    if (chosen === undefined) {
      fills[slot.key] = null;
      if (!slot.optional) emptyRequired.push(slot.key);
      continue;
    }
    used.add(chosen);
    fills[slot.key] = { name: chosen.name, ingredientId: chosen.ingredientId };
  }
  const ingredients: RecipeIngredient[] = [];
  const index = new Map<string, number>();
  for (const slot of frame.slots) {
    const f = fills[slot.key];
    if (f) {
      index.set(slot.key, ingredients.length);
      ingredients.push(line(f.name));
    }
  }
  const recipe: ParsedRecipe = { meta: frameMeta(frame), ingredients, timers: [], steps: buildSteps(frame, index), source: '' };
  const result = check(recipe, ctx.rules, ctx.graph, ctx.subs, ctx.today);
  if (emptyRequired.length > 0) {
    const empty: Finding[] = emptyRequired.map((key) => ({ ingredient: key, ingredientId: null, kind: 'unresolved', status: 'unverified' }));
    const findings = [...result.findings, ...empty];
    const status: CheckStatus = RANK[result.status] >= RANK.unverified ? result.status : 'unverified';
    return { frame: frame.id, fills, recipe, check: { ...result, findings, status }, emptyRequired };
  }
  return { frame: frame.id, fills, recipe, check: result, emptyRequired };
}

/**
 * Each frame's rules status for the quest engine (`StepContext.frames`, Step 2): the status of the frame filled from
 * this pantry today. The engine only ever offers 'ok' and 'swap' ones.
 */
export function frameOptions(frames: readonly Frame[], pantry: readonly PantryItem[], ctx: FrameContext): FrameOption[] {
  return frames.map((f) => ({ id: f.id, technique: f.technique, status: fillFrame(f, pantry, ctx).check.status }));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLOT_KEY = /^[a-z][a-z0-9_]*$/;

/**
 * Frame content against the graph and the techniques (Steps 4 and 5 refuse to build or boot on a problem). Never
 * throws. Checks: a unique kebab-case id; a title and credit; a known technique; status draft or reviewed; at least one
 * required slot; unique snake_case slot keys, each accepting known ids; steps that use only known slots, with every
 * required slot used; and rescue ids that are known and accepted by some slot.
 */
export function validateFrames(frames: Frame[], graph: IngredientGraph, techniques: ReadonlySet<string>): string[] {
  if (!Array.isArray(frames)) return ['frames: not a list'];
  const problems: string[] = [];
  const ids = new Set<string>();
  frames.forEach((raw: unknown, i) => {
    if (!isObject(raw)) {
      problems.push(`frame ${i}: not an object`);
      return;
    }
    const f = raw as Partial<Record<keyof Frame, unknown>>;
    const at = typeof f.id === 'string' ? `frame "${f.id}"` : `frame ${i}`;
    if (typeof f.id !== 'string' || !ID.test(f.id)) problems.push(`${at}: id is not kebab-case`);
    else if (ids.has(f.id)) problems.push(`${at}: duplicate id`);
    else ids.add(f.id);
    if (typeof f.title !== 'string' || f.title.trim() === '') problems.push(`${at}: no title`);
    if (typeof f.credit !== 'string' || f.credit.trim() === '') problems.push(`${at}: no credit`);
    if (typeof f.technique !== 'string' || !techniques.has(f.technique)) problems.push(`${at}: unknown technique "${String(f.technique)}"`);
    if (f.status !== 'draft' && f.status !== 'reviewed') problems.push(`${at}: status is not draft or reviewed`);
    const keys = new Set<string>();
    const required = new Set<string>();
    const accepted: string[] = [];
    if (!Array.isArray(f.slots) || f.slots.length === 0) problems.push(`${at}: no slots`);
    else {
      f.slots.forEach((s: unknown, j: number) => {
        if (!isObject(s)) {
          problems.push(`${at}: slot ${j} is not an object`);
          return;
        }
        if (typeof s.key !== 'string' || !SLOT_KEY.test(s.key)) problems.push(`${at}: slot ${j} key is not snake_case`);
        else if (keys.has(s.key)) problems.push(`${at}: duplicate slot "${s.key}"`);
        else keys.add(s.key);
        if (typeof s.optional !== 'boolean') problems.push(`${at}: slot ${j} optional is not a boolean`);
        else if (!s.optional && typeof s.key === 'string') required.add(s.key);
        if (!isStrings(s.accepts) || s.accepts.length === 0) problems.push(`${at}: slot ${j} accepts nothing`);
        else
          for (const id of s.accepts) {
            if (!graph.has(id)) problems.push(`${at}: slot ${j} accepts unknown ingredient "${id}"`);
            else accepted.push(id);
          }
      });
      if (required.size === 0) problems.push(`${at}: no required slot`);
    }
    if (!isStrings(f.steps) || f.steps.length === 0) problems.push(`${at}: no steps`);
    else {
      const usedKeys = new Set<string>();
      for (const step of f.steps) for (const m of step.matchAll(PLACEHOLDER)) {
        if (!keys.has(m[1])) problems.push(`${at}: step uses unknown slot "{${m[1]}}"`);
        usedKeys.add(m[1]);
      }
      for (const k of required) if (!usedKeys.has(k)) problems.push(`${at}: required slot "${k}" is in no step`);
    }
    if (!isStrings(f.rescues)) problems.push(`${at}: rescues is not a list`);
    else
      for (const id of f.rescues) {
        if (!graph.has(id)) problems.push(`${at}: rescues unknown ingredient "${id}"`);
        else if (!accepted.some((a) => a === id || graph.ancestors(id).includes(a))) problems.push(`${at}: rescues "${id}", which no slot accepts`);
      }
  });
  return problems;
}
