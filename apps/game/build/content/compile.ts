import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { ZodType } from 'zod';
import {
  IngredientGraph,
  parseRecipe,
  seasonalAgrees,
  STALL_IDS,
  timerSeconds,
  validateFoodGroups,
  validateFrames,
  validateKeeps,
  validateQuests,
  validateRewards,
  validateRuleTerms,
  validateSeasonTable,
  validateStallFile,
  validateStallMap,
  validateSubstitutions,
  validateTechniques,
  validateThresholds,
  type FoodGroups,
  type IngredientData,
  type KeepsMap,
  type ParsedRecipe,
  type RewardsData,
  type RuleTerm,
  type SeasonTable,
  type StallFile,
  type StallId,
  type StallMap,
  type Substitution,
  type TechniqueNode,
} from '@kitchenquest/core';
import { REQUIRED_DISCLAIMERS, REQUIRED_PAN_TRIGGERS, REQUIRED_STALL_TRIGGERS } from '../../src/content/required';
import type {
  BureauFile,
  BureauForm,
  LineTrigger,
  CookFile,
  FrameFile,
  GameContent,
  LineBank,
  TechniqueData,
} from '../../src/content/types';
import {
  bureauFile,
  cookFile,
  FOOTNOTE_TAGS,
  frameFile,
  idMapFile,
  ingredientsFile,
  lineBank,
  rewardsFile,
  ruleTermsFile,
  seasonalityFile,
  stallFile,
  substitutionsFile,
  techniquesFile,
} from './schemas';
import { pinProblems, stallQuestions, type MarketPins } from './market';

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
const RULE_TERMS = 'data/rule-terms.json';
const REWARDS = 'data/rewards.yaml';
const KEEPS = 'data/keeps.json';
const STALLS = 'data/stalls.json';
const FOOD_GROUPS = 'data/food-groups.json';
const SEASONALITY = 'data/seasonality.yaml';
const FRAME_PATH = /^content\/frames\/[^/]+\.yaml$/;
/** Forms the M5 screens show (Steps 9–11); the build fails without them. */
const REQUIRED_FORMS = ['travel', 'certificate', 'plan', 'market_list', 'margin_note', 'cooked_for', 'technique_certificate', 'frame', 'stall_round'] as const;
/** Form 14-S: its `game` map names every minigame a stall file may use (the known games, M6 Step 5). */
const STALL_ROUND_FORM = 'stall_round';
/** Form 12-M's field whose label is the display name of the `general` stall (C11). */
const GENERAL_STALL_FIELD = 'general_stall';

const VAR = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
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
    Object.entries(triggers).map(([id, { when: _when, notes: _notes, ...rest }]) => [id, rest]),
  );
}

/** Options for `compileContent`. */
export interface CompileOptions {
  /**
   * The committed option-order pins (Ruling 2, build/content/market-pins.json). The build and the real-repo tests
   * always pass them; only the minimal-fixture tests leave them out, which skips the pin check.
   */
  pins?: MarketPins;
}

/** Compile every game input into one validated bundle. Throws a ContentError listing every problem. */
export function compileContent(files: Record<string, string>, opts: CompileOptions = {}): GameContent {
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
    techniques: unknown[];
  }>(TECHNIQUES, techniquesFile);

  let techniques: TechniqueData | null = null;
  const techniqueIds = new Set<string>();
  if (rawTech) {
    const freshness = { warmAfterDays: rawTech.freshness.warm_after_days, rustyAfterDays: rawTech.freshness.rusty_after_days };
    for (const p of validateThresholds(freshness)) fail(TECHNIQUES, `freshness thresholds: ${p}`);
    // Core checks ids, names, adjacent and prereqs (an unknown id, a self reference, a prereqs cycle).
    const techniqueProblems = validateTechniques(rawTech.techniques);
    for (const p of techniqueProblems) fail(TECHNIQUES, p);
    if (techniqueProblems.length === 0) {
      techniques = { freshness, techniques: rawTech.techniques as TechniqueNode[] };
      for (const t of techniques.techniques) techniqueIds.add(t.id);
    }
  }

  const rawRewards = load<unknown>(REWARDS, rewardsFile);
  const rewardsProblems = rawRewards === null ? [] : validateRewards(rawRewards);
  for (const p of rewardsProblems) fail(REWARDS, p);
  const rewards = rawRewards !== null && rewardsProblems.length === 0 ? (rawRewards as RewardsData) : null;

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
  // Core validates each term (its problems name the term); the schema only checks for a list.
  const rawRuleTerms = load<unknown[]>(RULE_TERMS, ruleTermsFile, true);
  const ruleTermProblems = graph && rawRuleTerms !== null ? validateRuleTerms(rawRuleTerms, graph) : [];
  for (const p of ruleTermProblems) fail(RULE_TERMS, p);
  const ruleTerms = rawRuleTerms !== null && graph && ruleTermProblems.length === 0 ? (rawRuleTerms as RuleTerm[]) : null;

  /** One of the week's id maps (keeps, stalls, food groups), checked by core against the graph. */
  function idMap<T>(path: string, check: (d: unknown, g: IngredientGraph) => string[]): T | null {
    const raw = load<Record<string, unknown>>(path, idMapFile, true);
    if (raw === null || !graph) return null;
    const found = check(raw, graph);
    for (const p of found) fail(path, p);
    return found.length === 0 ? (raw as T) : null;
  }
  const keeps = idMap<KeepsMap>(KEEPS, validateKeeps);
  const foodGroups = idMap<FoodGroups>(FOOD_GROUPS, validateFoodGroups);

  // ---- line banks, cooks, stalls, bureau ---------------------------------
  const pan = load<LineBank>(PAN, lineBank);
  if (pan) {
    for (const id of REQUIRED_PAN_TRIGGERS) {
      if (!(id in pan.triggers)) fail(PAN, `required trigger "${id}" is missing`);
    }
    for (const [id, trigger] of Object.entries(pan.triggers)) checkVars(id, trigger);
  }

  /** Every {var} a line uses is declared; an `ai: never` trigger declares nothing its lines don't use. */
  function checkVars(id: string, trigger: LineTrigger, path = PAN): void {
    const declared = new Set(Object.keys(trigger.vars ?? {}));
    const used = new Set<string>();
    trigger.lines.forEach((line, i) => {
      for (const [, name] of line.matchAll(VAR)) {
        used.add(name);
        if (!declared.has(name)) fail(path, `${id} line ${i + 1} uses undeclared {${name}}`);
      }
    });
    if (trigger.ai === 'never') {
      for (const name of declared) if (!used.has(name)) fail(path, `${id} declares {${name}}, which no line uses`);
    }
  }

  // Nothing under content/ or recipes/ may be silently ignored.
  const claimed = (p: string): boolean =>
    p === PAN ||
    p === BUREAU ||
    FRAME_PATH.test(p) ||
    /^content\/cooks\/[^/]+\.yaml$/.test(p) ||
    /^content\/market\/[^/]+\.yaml$/.test(p) ||
    /^recipes\/.+\.cook$/.test(p);
  for (const p of Object.keys(files).sort()) {
    if (!p.startsWith('content/') && !p.startsWith('recipes/')) continue;
    if (claimed(p) || IGNORED_NAMES.has(p.slice(p.lastIndexOf('/') + 1))) continue;
    fail(p, 'file is not loaded by anything (expected content/dialogue/pan.yaml, content/bureau/forms.yaml, content/cooks/*.yaml, content/market/*.yaml, content/frames/*.yaml or recipes/**/*.cook)');
  }

  const cookPaths = Object.keys(files).filter((p) => /^content\/cooks\/[^/]+\.yaml$/.test(p)).sort();
  const stallPaths = Object.keys(files).filter((p) => /^content\/market\/[^/]+\.yaml$/.test(p)).sort();
  const recipePaths = Object.keys(files).filter((p) => /^recipes\/.+\.cook$/.test(p)).sort();

  /**
   * The same {var} check for a cook or stall file (carry from Step 2): in a trigger (an object with `lines`) every
   * {var} must be declared, and an `ai: never` trigger declares none it doesn't use. Anywhere else in the file there is
   * nothing to fill a {var} in, so a stray one would reach the player as written.
   */
  function checkFileVars(path: string, node: unknown, where: string): void {
    if (typeof node === 'string') {
      for (const [, name] of node.matchAll(VAR)) fail(path, `${where} uses {${name}}, but nothing fills it in there`);
    } else if (Array.isArray(node)) {
      node.forEach((x, i) => { checkFileVars(path, x, `${where}[${i}]`); });
    } else if (typeof node === 'object' && node !== null) {
      const o = node as Record<string, unknown>;
      if (Array.isArray(o.lines) && o.lines.every((l) => typeof l === 'string')) {
        checkVars(where, o as unknown as LineTrigger, path);
        for (const [k, v] of Object.entries(o)) if (k !== 'lines' && k !== 'vars') checkFileVars(path, v, `${where}.${k}`);
      } else {
        for (const [k, v] of Object.entries(o)) checkFileVars(path, v, where === '' ? k : `${where}.${k}`);
      }
    }
  }

  const cookIds = new Set(cookPaths.map((p) => p.slice('content/cooks/'.length, -'.yaml'.length)));

  const cooks: Record<string, CookFile> = {};
  const cookByPath = new Map<string, CookFile>();
  for (const path of cookPaths) {
    const cook = load<CookFile>(path, cookFile);
    if (!cook) continue;
    cooks[cook.id] = cook;
    checkFileVars(path, cook, '');
    cookByPath.set(path, cook);
  }
  // Stall files: the strict schema here; core's validateStallFile, seasonalAgrees and the pins after the Bureau loads
  // (Form 14-S names the known games).
  const stalls: Record<string, StallFile> = {};
  const stallPathOf = new Map<string, string>();
  for (const path of stallPaths) {
    const stall = load<StallFile>(path, stallFile);
    if (!stall) continue;
    const fileId = path.slice('content/market/'.length, -'.yaml'.length);
    if (stall.id !== fileId) fail(path, `id "${stall.id}" must equal the file name "${fileId}"`);
    stalls[stall.id] = stall;
    stallPathOf.set(stall.id, path);
    checkFileVars(path, stall, '');
  }

  // data/stalls.json: every value a content/market stall or 'general' (C11); every core StallId has a stall file.
  // By file name, not by the files that loaded (fix round 1, M5): a stall file with its own schema problem is reported
  // once, and data/stalls.json is not blamed for naming it.
  const stallIdSet = new Set([...stallPaths.map((p) => p.slice('content/market/'.length, -'.yaml'.length)), 'general']);
  const stallOf = idMap<StallMap>(STALLS, (d, g) => validateStallMap(d, g, stallIdSet));
  for (const id of Object.keys(stalls)) {
    if (!(STALL_IDS as readonly string[]).includes(id)) fail(`content/market/${id}.yaml`, `stall "${id}" is not a market stall the game knows (${STALL_IDS.join(', ')})`);
  }
  for (const id of STALL_IDS) {
    if (id !== 'general' && stallPaths.length > 0 && !(id in stalls) && !stallPaths.includes(`content/market/${id}.yaml`))
      fail(`content/market/${id}.yaml`, `file is missing: every market stall (${STALL_IDS.filter((s) => s !== 'general').join(', ')}) needs one`);
  }

  // ---- frames --------------------------------------------------------------------
  const framePaths = Object.keys(files).filter((p) => FRAME_PATH.test(p)).sort();
  const frames: FrameFile[] = [];
  for (const path of framePaths) {
    const frame = load<FrameFile>(path, frameFile);
    if (frame === null) continue;
    const fileId = path.slice('content/frames/'.length, -'.yaml'.length);
    if ((frame as { id?: unknown }).id !== fileId) fail(path, `id "${String((frame as { id?: unknown }).id)}" must equal the file name "${fileId}"`);
    // Core checks the slots (graph ids only), steps, technique and rescues; one file, one frame, so problems name it.
    const found = graph && techniques ? validateFrames([frame], graph, techniqueIds) : [];
    for (const p of found) fail(path, p);
    if (found.length === 0) frames.push(frame);
  }
  frames.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bureau = load<BureauFile>(BUREAU, bureauFile);
  if (bureau) {
    for (const id of REQUIRED_FORMS) {
      if (!(id in bureau.forms)) fail(BUREAU, `forms.${id} is missing`);
    }
    if (Object.hasOwn(bureau.forms, 'market_list') && !bureau.forms.market_list.fields.some((f) => f.key === GENERAL_STALL_FIELD))
      fail(BUREAU, `forms.market_list needs a "${GENERAL_STALL_FIELD}" field: its label names the general stall`);
    // Every stamp kind in data/rewards.yaml has a name to show (C13).
    if (rewards) {
      for (const id of Object.keys(rewards.stamps)) {
        if (!Object.hasOwn(bureau.stamp_names, id)) fail(BUREAU, `stamp_names.${id} is missing (a stamp kind in ${REWARDS})`);
      }
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

  // ---- market stalls and The Season's Table (M6 Step 5) ------------------------------
  const rawSeasons = load<Record<string, unknown>>(SEASONALITY, seasonalityFile);
  const seasonProblems = rawSeasons !== null && graph ? validateSeasonTable(rawSeasons, graph) : [];
  for (const p of seasonProblems) fail(SEASONALITY, p);
  const seasonality = rawSeasons !== null && graph && seasonProblems.length === 0 ? (rawSeasons as unknown as SeasonTable) : null;

  const roundForm = bureau && Object.hasOwn(bureau.forms, STALL_ROUND_FORM) ? bureau.forms[STALL_ROUND_FORM] : undefined;
  if (bureau && roundForm && roundForm.game === undefined) fail(BUREAU, `forms.${STALL_ROUND_FORM}.game is missing: it names every minigame a stall may use`);
  const knownGames = new Set(Object.keys(roundForm?.game ?? {}));
  // A question id is unique across every stall too: events and pins name a question by id alone (Step 3 M4).
  const questionAt = new Map<string, string>();
  for (const [id, stall] of Object.entries(stalls)) {
    const path = stallPathOf.get(id) ?? `content/market/${id}.yaml`;
    // Core's check (shared with the API boot, Step 6): ids in the graph, one correct of 3–4 options, games, country
    // scopes, chalkboard arithmetic (M7 Step 7: every figure in the prompt and the option texts too), no currency symbol,
    // duplicate ids, FAQ shape, and the foods each FAQ answer and tip declares (M7 Step 7). Each problem names the key path.
    if (graph && bureau) for (const p of validateStallFile(stall, graph, { knownGames })) fail(path, p);
    // Ruling 9: Wen's seasonal questions agree with the table.
    if (seasonality) for (const p of seasonalAgrees(stall, seasonality)) fail(path, p);
    if (opts.pins) for (const p of pinProblems(stall, opts.pins)) fail(path, p);
    for (const { at, q } of stallQuestions(stall)) {
      const before = questionAt.get(q.id);
      if (before !== undefined && !before.startsWith(`${path} `)) fail(path, `${at} (${q.id}): question id is also used at ${before}`);
      else questionAt.set(q.id, `${path} ${at}`);
    }
    // C19: each stall's safety lines exist, written only.
    const required = Object.hasOwn(REQUIRED_STALL_TRIGGERS, id) ? REQUIRED_STALL_TRIGGERS[id as keyof typeof REQUIRED_STALL_TRIGGERS] : [];
    for (const t of required) {
      if (!Object.hasOwn(stall.triggers, t)) fail(path, `triggers.${t}: required trigger is missing`);
      else if (stall.triggers[t].ai !== 'never') fail(path, `triggers.${t}: a safety line must be ai: never`);
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
  const stallIds = new Set(Object.keys(stalls));
  for (const path of cookPaths) {
    const fileId = path.slice('content/cooks/'.length, -'.yaml'.length);
    const cook = cookByPath.get(path);
    if (!cook) continue; // schema problems already reported
    if (cook.id !== fileId) fail(path, `id "${cook.id}" must equal the file name "${fileId}"`);
    if (!(cook.recipe in recipes)) fail(path, `recipe "${cook.recipe}" does not exist (recipes/${cook.recipe}.cook)`);
    const quest = cook.quest;
    if (quest.cook !== cook.id) fail(path, `quest.cook "${quest.cook}" must equal the cook id "${cook.id}"`);
    for (const level of Object.keys(cook.trust_lines)) {
      if (!/^[1-5]$/.test(level)) fail(path, `trust_lines key "${level}" must be 1 to 5`);
    }
  }

  // Every quest step's references, riddles, unlock.requires (no cycle), recognize steps of a technique learned
  // elsewhere (C2) and cook-step techniques: core's validateQuests, shared with the API catalogue (Step 5).
  if (graph && techniques) {
    const pathOfQuest = new Map([...cookByPath].map(([path, c]) => [c.quest.id, path]));
    const cat = {
      recipes: new Map(Object.entries(recipes).map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
      techniques: techniqueIds,
    };
    const quests = [...cookByPath.values()].map((c) => c.quest);
    for (const p of validateQuests(quests, cat, cookIds, stallIds, graph)) {
      const id = /^quest "([^"]+)"/.exec(p)?.[1] ?? /cycle: ([^ ]+)/.exec(p)?.[1];
      fail(pathOfQuest.get(id ?? '') ?? cookPaths[0], p);
    }
  }

  // Each stall's display name (C11): the content/market file's name, and the general stall from Form 12-M.
  const marketList = bureau && Object.hasOwn(bureau.forms, 'market_list') ? bureau.forms.market_list : undefined;
  const generalStall = marketList?.fields.find((f) => f.key === GENERAL_STALL_FIELD)?.label;
  const stallNames: Partial<Record<StallId, string>> = {};
  for (const id of STALL_IDS) {
    const name = id === 'general' ? generalStall : Object.hasOwn(stalls, id) ? stalls[id].name : undefined;
    if (name !== undefined) stallNames[id] = name;
  }
  const namedAll = STALL_IDS.every((id) => stallNames[id] !== undefined);

  if (
    problems.length > 0 || !pan || !bureau || !ingredients || !substitutions || !techniques || !ruleTerms ||
    !rewards || !keeps || !foodGroups || !stallOf || !namedAll || seasonality === null
  ) {
    throw new ContentError(problems);
  }
  return {
    version: versionOf(files),
    pan: { ...pan, triggers: clientTriggers(pan.triggers) },
    cooks,
    // The full stall files: build/content/market.ts shapes them for the client, and the content module leaves them out.
    stalls,
    seasonality,
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
    ruleTerms,
    rewards,
    frames,
    keeps,
    foodGroups,
    stallOf,
    stallNames: stallNames as Record<StallId, string>,
  };
}
