import { CooklangParser, getFlatIngredients, getFlatTimers } from '@cooklang/cooklang';
import type { CooklangRecipe } from '@cooklang/cooklang';
import { RecipeError } from './types';
import type { ParsedRecipe, RecipeMeta, RecipeStatus } from './types';

export { RecipeError } from './types';

const parser = new CooklangParser();

const STRING_KEYS = ['title', 'country', 'region', 'credit', 'cook', 'license'] as const;

function validateMeta(raw: Map<unknown, unknown>): { meta: RecipeMeta | null; problems: string[] } {
  const problems: string[] = [];
  const strings: Record<string, string> = {};

  for (const key of STRING_KEYS) {
    const v = raw.get(key);
    if (v === undefined || v === null) problems.push(`missing required key: ${key}`);
    else if (typeof v !== 'string' || v.trim() === '') problems.push(`${key} must be a non-empty string`);
    else strings[key] = v;
  }

  const difficulty = raw.get('difficulty');
  if (difficulty === undefined || difficulty === null) problems.push('missing required key: difficulty');
  else if (!Number.isInteger(difficulty) || (difficulty as number) < 1 || (difficulty as number) > 5)
    problems.push('difficulty must be an integer from 1 to 5');

  const skills = raw.get('skills');
  if (skills === undefined || skills === null) problems.push('missing required key: skills');
  else if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string'))
    problems.push('skills must be a list of strings');

  const servings = raw.get('servings');
  if (servings === undefined || servings === null) problems.push('missing required key: servings');
  else if (typeof servings !== 'number' || !Number.isFinite(servings) || servings <= 0)
    problems.push('servings must be a number greater than 0');

  const status = raw.get('status');
  if (status === undefined || status === null) problems.push('missing required key: status');
  else if (status !== 'draft' && status !== 'reviewed') problems.push('status must be "draft" or "reviewed"');

  const sacred = raw.get('sacred');
  if (sacred !== undefined && sacred !== null && typeof sacred !== 'boolean')
    problems.push('sacred must be true or false');

  if (problems.length > 0) return { meta: null, problems };

  return {
    problems,
    meta: {
      title: strings.title,
      country: strings.country,
      region: strings.region,
      credit: strings.credit,
      cook: strings.cook,
      difficulty: difficulty as RecipeMeta['difficulty'],
      skills: skills as string[],
      servings: servings as number,
      license: strings.license,
      status: status as RecipeStatus,
      sacred: sacred === true,
    },
  };
}

function reportText(report: string): string {
  return report
    .replace(/<[^>]*>/g, '')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')[0]
    .trim();
}

export function parseRecipe(source: string): ParsedRecipe {
  let recipe: CooklangRecipe;
  let report: string;
  try {
    [recipe, report] = parser.parse(source);
  } catch (e) {
    // The WASM parser traps (RuntimeError) on some malformed input.
    throw new RecipeError([`Cooklang parser failed: ${e instanceof Error ? e.message : String(e)}`]);
  }
  // The report is an HTML-ish string, empty for clean input. Both errors and warnings
  // (e.g. invalid YAML front matter, which the parser silently ignores) are treated as problems.
  if (report.trim() !== '') throw new RecipeError([`Cooklang parse problem: ${reportText(report)}`]);
  const { meta, problems } = validateMeta(recipe.rawMetadata);
  if (meta === null) throw new RecipeError(problems);

  return {
    meta,
    ingredients: getFlatIngredients(recipe).map((i) => ({
      name: i.name,
      quantity: typeof i.quantity === 'number' ? i.quantity : null,
      unit: i.unit || null,
      note: i.note || null,
    })),
    timers: getFlatTimers(recipe).map((t) => ({
      name: t.name || null,
      quantity: typeof t.quantity === 'number' ? t.quantity : null,
      unit: t.unit || null,
    })),
    source,
  };
}
