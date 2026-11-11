import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IngredientGraph,
  parseRecipe,
  validateFoodGroups,
  validateFrames,
  validateKeeps,
  validateQuests,
  validateRewards,
  validateRuleTerms,
  validateStallMap,
  validateSubstitutions,
  validateTechniques,
  validateThresholds,
  type FoodGroups,
  type Frame,
  type FreshnessThresholds,
  type IngredientData,
  type KeepsMap,
  type Quest,
  type RewardsData,
  type RuleTerm,
  type StallMap,
  type Substitution,
  type TechniqueNode,
} from '@kitchenquest/core';
import { parse as parseYaml } from 'yaml';

/** The shared safety data: the ingredient graph, and the substitutions and rule terms checked against it. */
export interface Catalog {
  graph: IngredientGraph;
  substitutions: readonly Substitution[];
  /** `rule-terms.json` (pre-flight C7): words such as "vegetarian" that name a rule, not one ingredient. */
  ruleTerms: readonly RuleTerm[];
}

/** The repository's `data/` directory. */
const DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));

function readJson(dir: string, file: string): unknown {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Catalog: cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Catalog: ${path} is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * Loads `ingredients.json`, `substitutions.json` and `rule-terms.json` from
 * `dir`, builds the graph and checks every substitution and rule term against it. Throws, naming the file and the
 * problem, on anything wrong: the server must not start on bad safety data.
 */
export function loadCatalog(dir: string = DATA_DIR): Catalog {
  const ingredients = readJson(dir, 'ingredients.json') as IngredientData;
  if (typeof ingredients !== 'object' || ingredients === null || !Array.isArray(ingredients.ingredients)) {
    throw new Error(`Catalog: ${join(dir, 'ingredients.json')} must be an object with an "ingredients" array`);
  }
  let graph: IngredientGraph;
  try {
    graph = IngredientGraph.fromData(ingredients);
  } catch (e) {
    throw new Error(`Catalog: ${join(dir, 'ingredients.json')}: ${(e as Error).message}`);
  }
  const substitutions = readJson(dir, 'substitutions.json');
  if (!Array.isArray(substitutions)) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')} must be an array`);
  }
  if (!substitutions.every((s) => typeof s === 'object' && s !== null && !Array.isArray(s))) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')} must hold only objects`);
  }
  const problems = validateSubstitutions(substitutions as Substitution[], graph);
  if (problems.length > 0) {
    throw new Error(`Catalog: ${join(dir, 'substitutions.json')}: ${problems.join('; ')}`);
  }
  const ruleTerms = readJson(dir, 'rule-terms.json');
  const termProblems = validateRuleTerms(ruleTerms, graph);
  if (termProblems.length > 0) {
    throw new Error(`Catalog: ${join(dir, 'rule-terms.json')}: ${termProblems.join('; ')}`);
  }
  return {
    graph,
    substitutions: Object.freeze([...(substitutions as Substitution[])]),
    ruleTerms: Object.freeze([...(ruleTerms as RuleTerm[])]),
  };
}

let loaded: Catalog | undefined;

/** The catalog from `DATA_DIR`, loaded on first use (at boot, from buildApp) and shared after. */
export function defaultCatalog(): Catalog {
  loaded ??= loadCatalog();
  return loaded;
}

// ---- the weekly loop's content (C10) ------------------------------------------------------------------------

/**
 * Everything the progress, plan and market code reads from `data/` and `content/`, validated at boot (C10). The ids
 * in each are checked against `catalog.graph`, the techniques and each other, so a request never meets bad data.
 */
export interface LoopContent {
  rewards: RewardsData;
  techniques: TechniqueNode[];
  thresholds: FreshnessThresholds;
  /** Each cook's quest (`content/cooks/*.yaml`), sorted by id. */
  quests: Quest[];
  /** The cook ids: the `content/cooks/*.yaml` file names. */
  cooks: ReadonlySet<string>;
  /** The market stall ids: the `content/market/*.yaml` file names. */
  stalls: ReadonlySet<string>;
  /** The Pantry Frames (`content/frames/*.yaml`), sorted by id. */
  frames: Frame[];
  stallOf: StallMap;
  foodGroups: FoodGroups;
  keeps: KeepsMap;
  /** The ingredient graph the content was checked against (`catalog.graph`); the quests are checked again with it against each recipe index (M5). */
  graph: IngredientGraph;
}

/** The repository's `content/` and `recipes/` directories. */
const CONTENT_DIR = fileURLToPath(new URL('../../../content/', import.meta.url));
const RECIPES_DIR = fileURLToPath(new URL('../../../recipes/', import.meta.url));

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Throws `Catalog: <path>: <problems>` when there are any: the server must not start on bad loop data. */
function refuse(path: string, problems: readonly string[]): void {
  if (problems.length > 0) throw new Error(`Catalog: ${path}: ${problems.join('; ')}`);
}

/** A mapping read from `path` whose `id` is the file name, or a refusal naming the file. */
function withFileId(path: string, id: string, value: unknown): Record<string, unknown> {
  if (!isObj(value) || value.id !== id) throw new Error(`Catalog: ${path}: id must equal the file name "${id}"`);
  return value;
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new Error(`Catalog: cannot read ${path}: ${(e as Error).message}`);
  }
}

function readYaml(path: string): unknown {
  const text = readText(path);
  try {
    return parseYaml(text, { strict: true }) as unknown;
  } catch (e) {
    throw new Error(`Catalog: ${path} is not valid YAML: ${(e as Error).message}`);
  }
}

/** The `*.yaml` files of `dir` (sorted, with their id: the file name), or a refusal when there are none. */
function yamlFiles(dir: string): { id: string; path: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new Error(`Catalog: cannot read ${dir}: ${(e as Error).message}`);
  }
  const files = names
    .filter((n) => n.endsWith('.yaml'))
    .sort()
    .map((n) => ({ id: n.slice(0, -'.yaml'.length), path: join(dir, n) }));
  if (files.length === 0) throw new Error(`Catalog: ${dir} holds no .yaml files`);
  return files;
}

/** Every `*.cook` under `dir`, slug → recipe meta (cook, skills, sacred), for checking the quests (as the sync reads them). */
function recipeMeta(dir: string): Map<string, { cook: string; skills: readonly string[]; sacred: boolean }> {
  let paths: string[];
  try {
    paths = (readdirSync(dir, { recursive: true }) as string[]).map((f) => f.split(sep).join('/')).filter((f) => f.endsWith('.cook')).sort();
  } catch (e) {
    throw new Error(`Catalog: cannot read ${dir}: ${(e as Error).message}`);
  }
  const out = new Map<string, { cook: string; skills: readonly string[]; sacred: boolean }>();
  for (const path of paths) {
    try {
      const { meta } = parseRecipe(readText(join(dir, path)));
      out.set(path.slice(0, -'.cook'.length), { cook: meta.cook, skills: meta.skills, sacred: meta.sacred });
    } catch (e) {
      throw new Error(`Catalog: ${join(dir, path)}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * Loads and validates, at boot, the weekly loop's data and content (C10): `data/rewards.yaml` (`validateRewards`),
 * `data/techniques.yaml` (`validateTechniques`, `validateThresholds`), the `content/cooks/*.yaml` quests and cook ids,
 * the `content/market/*.yaml` stall ids, `content/frames/*.yaml` (`validateFrames`), `data/stalls.json`,
 * `data/food-groups.json` and `data/keeps.json`, every id checked against `catalog.graph`. `validateQuests` runs with
 * those cook and stall ids and the canon recipes under `recipesDir` (the files the recipe sync reads). Throws, naming
 * the file and its problems, on anything wrong: the server refuses to start on bad data, as it does for rule terms.
 */
export function loadLoopContent(catalog: Catalog, dataDir: string = DATA_DIR, contentDir: string = CONTENT_DIR, recipesDir: string = RECIPES_DIR): LoopContent {
  const { graph } = catalog;

  const rewardsPath = join(dataDir, 'rewards.yaml');
  const rewards = readYaml(rewardsPath);
  refuse(rewardsPath, validateRewards(rewards));

  const techniquesPath = join(dataDir, 'techniques.yaml');
  const tech = readYaml(techniquesPath);
  if (!isObj(tech)) throw new Error(`Catalog: ${techniquesPath} must be a mapping with "freshness" and "techniques"`);
  refuse(techniquesPath, validateTechniques(tech.techniques));
  const f: Record<string, unknown> = isObj(tech.freshness) ? tech.freshness : {};
  const thresholds = { warmAfterDays: f.warm_after_days, rustyAfterDays: f.rusty_after_days } as FreshnessThresholds;
  refuse(techniquesPath, validateThresholds(thresholds).map((p) => `freshness: ${p}`));
  const techniques = tech.techniques as TechniqueNode[];
  const techniqueIds = new Set(techniques.map((t) => t.id));

  const stallFiles = yamlFiles(join(contentDir, 'market'));
  for (const { id, path } of stallFiles) {
    withFileId(path, id, readYaml(path));
  }
  const stalls: ReadonlySet<string> = new Set(stallFiles.map((s) => s.id));

  const cookFiles = yamlFiles(join(contentDir, 'cooks'));
  const cooks: ReadonlySet<string> = new Set(cookFiles.map((c) => c.id));
  const quests: Quest[] = [];
  const pathOfQuest = new Map<string, string>();
  for (const { id, path } of cookFiles) {
    const { quest } = withFileId(path, id, readYaml(path));
    if (!isObj(quest)) throw new Error(`Catalog: ${path}: quest must be a mapping`);
    quests.push(quest as unknown as Quest);
    if (typeof quest.id === 'string') pathOfQuest.set(quest.id, path);
  }
  const recipes = recipeMeta(recipesDir);
  const questProblems = validateQuests(quests, { recipes, techniques: techniqueIds }, cooks, stalls, graph);
  if (questProblems.length > 0) {
    const first = /^quest "([^"]+)"/.exec(questProblems[0])?.[1];
    refuse(pathOfQuest.get(first ?? '') ?? cookFiles[0].path, questProblems);
  }

  const frames: Frame[] = [];
  for (const { id, path } of yamlFiles(join(contentDir, 'frames'))) {
    const frame = withFileId(path, id, readYaml(path)) as unknown as Frame;
    refuse(path, validateFrames([frame], graph, techniqueIds));
    frames.push(frame);
  }
  refuse(join(contentDir, 'frames'), validateFrames(frames, graph, techniqueIds));

  const stallsPath = join(dataDir, 'stalls.json');
  const stallOf = readJson(dataDir, 'stalls.json');
  refuse(stallsPath, validateStallMap(stallOf, graph, new Set([...stalls, 'general'])));
  const foodGroups = readJson(dataDir, 'food-groups.json');
  refuse(join(dataDir, 'food-groups.json'), validateFoodGroups(foodGroups, graph));
  const keeps = readJson(dataDir, 'keeps.json');
  refuse(join(dataDir, 'keeps.json'), validateKeeps(keeps, graph));

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    rewards: rewards as RewardsData,
    techniques,
    thresholds,
    quests: quests.sort(byId),
    cooks,
    stalls,
    frames: frames.sort(byId),
    stallOf: stallOf as StallMap,
    foodGroups: foodGroups as FoodGroups,
    keeps: keeps as KeepsMap,
    graph,
  };
}

let loadedLoop: LoopContent | undefined;

/** The loop content from `data/` and `content/`, checked against `defaultCatalog()`, loaded on first use (at boot) and shared. */
export function defaultLoopContent(): LoopContent {
  loadedLoop ??= loadLoopContent(defaultCatalog());
  return loadedLoop;
}
