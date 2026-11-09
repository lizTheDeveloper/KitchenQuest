import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import {
  IngredientGraph,
  parseRecipe,
  timerSeconds,
  validateSubstitutions,
  validateThresholds,
  type IngredientData,
  type ParsedRecipe,
  type Substitution,
} from '@kitchenquest/core';
import { REQUIRED_DISCLAIMERS, REQUIRED_PAN_TRIGGERS } from '../../src/content/required';
import type {
  BureauFile,
  BureauForm,
  LineTrigger,
  CookFile,
  GameContent,
  LineBank,
  StallFile,
  StallQuestion,
  TechniqueData,
} from '../../src/content/types';
import {
  bureauFile,
  cookFile,
  FOOTNOTE_TAGS,
  ingredientsFile,
  lineBank,
  stallFile,
  substitutionsFile,
  techniquesFile,
} from './schemas';

export class ContentError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid game content:\n${problems.join('\n')}`);
    this.name = 'ContentError';
    this.problems = problems;
  }
}

const PAN = 'content/dialogue/pan.yaml';
const BUREAU = 'content/bureau/forms.yaml';
const TECHNIQUES = 'data/techniques.yaml';
const INGREDIENTS = 'data/ingredients.json';
const SUBSTITUTIONS = 'data/substitutions.json';

const IGNORED_NAMES = new Set(['README.md', 'LICENSE', 'CONTRIBUTING.md']);

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function versionOf(files: Record<string, string>): string {
  const hash = createHash('sha256');
  for (const path of Object.keys(files).sort()) {
    hash.update(`${path}\0${files[path]}\0`);
  }
  return hash.digest('hex').slice(0, 12);
}

type SourceTrigger = LineTrigger & { when?: unknown; notes?: unknown };

/** Drop the writers' `when` and `notes`; the client never reads them. */
function clientTriggers(triggers: Record<string, SourceTrigger>): Record<string, LineTrigger> {
  return Object.fromEntries(
    Object.entries(triggers).map(([id, { when: _when, notes: _notes, ...rest }]) => [id, rest as LineTrigger]),
  );
}

function clientStall(stall: StallFile): StallFile {
  const out: StallFile = { ...stall, triggers: clientTriggers(stall.triggers as Record<string, SourceTrigger>) };
  const variants = stall.variants as Record<string, { triggers?: Record<string, SourceTrigger> }> | undefined;
  if (variants) {
    out.variants = Object.fromEntries(
      Object.entries(variants).map(([name, v]) => [name, v.triggers ? { ...v, triggers: clientTriggers(v.triggers) } : v]),
    );
  }
  return out;
}

/** Compile every game input into one validated bundle. Throws a ContentError listing every problem. */
export function compileContent(files: Record<string, string>): GameContent {
  const problems: string[] = [];
  const fail = (path: string, message: string): void => void problems.push(`${path}: ${message}`);

  /** Parse one YAML/JSON file and check it against its schema; null (with problems recorded) on failure. */
  function load<T>(path: string, schema: ZodType, json = false): T | null {
    const text = files[path];
    if (text === undefined) {
      fail(path, 'file is missing');
      return null;
    }
    let raw: unknown;
    try {
      raw = json ? JSON.parse(text) : parseYaml(text, { strict: true });
    } catch (e) {
      fail(path, `${json ? 'JSON' : 'YAML'} does not parse: ${errorText(e)}`);
      return null;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        fail(path, `${issue.path.join('.') || '(top level)'}: ${issue.message}`);
      }
      return null;
    }
    return result.data as T;
  }

  // ---- data -------------------------------------------------------------
  const ingredients = load<IngredientData>(INGREDIENTS, ingredientsFile, true);
  const substitutions = load<Substitution[]>(SUBSTITUTIONS, substitutionsFile, true);
  const rawTech = load<{
    freshness: { warm_after_days: number; rusty_after_days: number };
    techniques: { id: string; name: string }[];
  }>(TECHNIQUES, techniquesFile);

  let techniques: TechniqueData | null = null;
  const techniqueIds = new Set<string>();
  if (rawTech) {
    techniques = {
      freshness: {
        warmAfterDays: rawTech.freshness.warm_after_days,
        rustyAfterDays: rawTech.freshness.rusty_after_days,
      },
      techniques: rawTech.techniques,
    };
    for (const p of validateThresholds(techniques.freshness)) fail(TECHNIQUES, `freshness thresholds: ${p}`);
    for (const t of rawTech.techniques) {
      if (techniqueIds.has(t.id)) fail(TECHNIQUES, `duplicate technique id "${t.id}"`);
      techniqueIds.add(t.id);
    }
  }

  let graph: IngredientGraph | null = null;
  if (ingredients) {
    try {
      graph = IngredientGraph.fromData(ingredients);
    } catch (e) {
      fail(INGREDIENTS, errorText(e));
    }
  }
  if (graph && substitutions) {
    for (const p of validateSubstitutions(substitutions, graph)) fail(SUBSTITUTIONS, p);
  }

  // ---- line banks, cooks, stalls, bureau ---------------------------------
  const pan = load<LineBank>(PAN, lineBank);
  if (pan) {
    for (const id of REQUIRED_PAN_TRIGGERS) {
      if (!(id in pan.triggers)) fail(PAN, `required trigger "${id}" is missing`);
    }
  }

  // Nothing under content/ or recipes/ may be silently ignored.
  const claimed = (p: string): boolean =>
    p === PAN ||
    p === BUREAU ||
    /^content\/cooks\/[^/]+\.yaml$/.test(p) ||
    /^content\/market\/[^/]+\.yaml$/.test(p) ||
    /^recipes\/.+\.cook$/.test(p);
  for (const p of Object.keys(files).sort()) {
    if (!p.startsWith('content/') && !p.startsWith('recipes/')) continue;
    if (claimed(p) || IGNORED_NAMES.has(p.slice(p.lastIndexOf('/') + 1))) continue;
    fail(p, 'file is not loaded by anything (expected content/dialogue/pan.yaml, content/bureau/forms.yaml, content/cooks/*.yaml, content/market/*.yaml or recipes/**/*.cook)');
  }

  const cookPaths = Object.keys(files).filter((p) => /^content\/cooks\/[^/]+\.yaml$/.test(p)).sort();
  const stallPaths = Object.keys(files).filter((p) => /^content\/market\/[^/]+\.yaml$/.test(p)).sort();
  const recipePaths = Object.keys(files).filter((p) => /^recipes\/.+\.cook$/.test(p)).sort();

  const cookIds = new Set(cookPaths.map((p) => p.slice('content/cooks/'.length, -'.yaml'.length)));

  const cooks: Record<string, CookFile> = {};
  const cookByPath = new Map<string, CookFile>();
  for (const path of cookPaths) {
    const cook = load<CookFile>(path, cookFile);
    if (!cook) continue;
    cooks[cook.id] = cook;
    cookByPath.set(path, cook);
  }
  const stalls: Record<string, StallFile> = {};
  for (const path of stallPaths) {
    const stall = load<StallFile>(path, stallFile);
    if (!stall) continue;
    const fileId = path.slice('content/market/'.length, -'.yaml'.length);
    if (stall.id !== fileId) fail(path, `id "${stall.id}" must equal the file name "${fileId}"`);
    stalls[stall.id] = stall;
    checkStallQuestions(path, 'questions', stall.questions);
    const variants = (stall.variants ?? {}) as Record<string, { questions?: StallQuestion[] }>;
    for (const [name, variant] of Object.entries(variants)) {
      if (variant.questions) checkStallQuestions(path, `variants.${name}.questions`, variant.questions);
    }
  }

  function checkStallQuestions(path: string, where: string, questions: StallQuestion[]): void {
    for (const q of questions) {
      const label = `${where} "${q.id}"`;
      if (q.options.length < 3 || q.options.length > 4)
        fail(path, `${label}: needs 3 or 4 options, has ${q.options.length}`);
      const correct = q.options.filter((o) => o.correct).length;
      if (correct !== 1) fail(path, `${label}: needs exactly one correct option, has ${correct}`);
    }
  }

  const bureau = load<BureauFile>(BUREAU, bureauFile);
  if (bureau) {
    for (const id of ['travel', 'certificate']) {
      if (!(id in bureau.forms)) fail(BUREAU, `forms.${id} is missing`);
    }
    for (const id of REQUIRED_DISCLAIMERS) {
      if (!Object.hasOwn(bureau.disclaimers, id)) fail(BUREAU, `disclaimers.${id} is missing`);
    }
    for (const note of bureau.footnotes) {
      if (!(FOOTNOTE_TAGS as readonly string[]).includes(note.tag))
        fail(BUREAU, `footnote tag "${note.tag}" must be one of ${FOOTNOTE_TAGS.join(', ')}`);
    }
    for (const [id, form] of Object.entries(bureau.forms)) {
      if (!(form.stamp in bureau.stamps))
        fail(BUREAU, `forms.${id}.stamp "${form.stamp}" is not a key of stamps`);
    }
  }

  for (const [name, count, where] of [
    ['cooks', cookPaths.length, 'content/cooks/*.yaml'],
    ['stalls', stallPaths.length, 'content/market/*.yaml'],
    ['recipes', recipePaths.length, 'recipes/**/*.cook'],
  ] as const) {
    if (count === 0) fail(where, `no ${name} found; the game needs at least one`);
  }

  // ---- recipes -------------------------------------------------------------
  const recipes: Record<string, ParsedRecipe> = {};
  for (const path of recipePaths) {
    const slug = path.slice('recipes/'.length, -'.cook'.length);
    let recipe: ParsedRecipe;
    try {
      recipe = parseRecipe(files[path]);
    } catch (e) {
      fail(path, errorText(e));
      continue;
    }
    recipes[slug] = recipe;
    recipe.timers.forEach((timer, i) => {
      try {
        timerSeconds(timer);
      } catch (e) {
        fail(path, `timer ${i + 1}: ${errorText(e)}`);
      }
    });
    if (!cookIds.has(recipe.meta.cook))
      fail(path, `cook "${recipe.meta.cook}" is not a cook id (content/cooks/*.yaml)`);
    if (techniques) {
      for (const skill of recipe.meta.skills) {
        if (!techniqueIds.has(skill)) fail(path, `skill "${skill}" is not a technique id (${TECHNIQUES})`);
      }
    }
  }

  // ---- cook cross-checks ------------------------------------------------------
  const questIds = new Set(Object.values(cooks).map((c) => c.quest.id));
  const stallIds = new Set(Object.keys(stalls));
  for (const path of cookPaths) {
    const fileId = path.slice('content/cooks/'.length, -'.yaml'.length);
    const cook = cookByPath.get(path);
    if (!cook) continue; // schema problems already reported
    if (cook.id !== fileId) fail(path, `id "${cook.id}" must equal the file name "${fileId}"`);
    if (!(cook.recipe in recipes)) fail(path, `recipe "${cook.recipe}" does not exist (recipes/${cook.recipe}.cook)`);
    const quest = cook.quest;
    if (quest.cook !== cook.id) fail(path, `quest.cook "${quest.cook}" must equal the cook id "${cook.id}"`);
    for (const req of quest.unlock.requires) {
      if (!questIds.has(req)) fail(path, `quest.unlock.requires: "${req}" is not a quest id`);
    }
    quest.steps.forEach((step, i) => {
      const at = `quest.steps[${i}] (${step.type})`;
      switch (step.type) {
        case 'cook':
          if (!(step.recipe in recipes)) fail(path, `${at}: recipe "${step.recipe}" does not exist`);
          break;
        case 'errand':
          if (!stallIds.has(step.stall)) fail(path, `${at}: stall "${step.stall}" is not a stall id`);
          break;
        case 'riddle': {
          const correct = step.options.filter((o) => o.correct).length;
          if (correct !== 1) fail(path, `${at}: needs exactly one correct option, has ${correct}`);
          break;
        }
        case 'drill':
          if (techniques && !techniqueIds.has(step.skill))
            fail(path, `${at}: skill "${step.skill}" is not a technique id (${TECHNIQUES})`);
          break;
        case 'talk':
          break;
      }
    });
    for (const level of Object.keys(cook.trust_lines)) {
      if (!/^[1-5]$/.test(level)) fail(path, `trust_lines key "${level}" must be 1 to 5`);
    }
  }

  if (problems.length > 0 || !pan || !bureau || !ingredients || !substitutions || !techniques) {
    throw new ContentError(problems);
  }
  return {
    version: versionOf(files),
    pan: { ...pan, triggers: clientTriggers(pan.triggers) },
    cooks,
    stalls: Object.fromEntries(Object.entries(stalls).map(([id, s]) => [id, clientStall(s)])),
    bureau: {
      ...bureau,
      forms: Object.fromEntries(
        Object.entries(bureau.forms).map(([id, { purpose: _purpose, ...form }]: [string, BureauForm & { purpose?: unknown }]) => [id, form]),
      ),
    },
    recipes,
    ingredients,
    substitutions,
    techniques,
  };
}
