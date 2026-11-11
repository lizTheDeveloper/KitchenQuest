// Test support for quests/ and toolkit/one-more tests only (not exported from the package): the shipped cook files,
// canon recipes and ingredient data, and a catalogue built from them, so the engine is tested against real content.
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { IngredientGraph } from '../ingredients/graph';
import type { IngredientData } from '../ingredients/types';
import { grantsFor } from '../progress/rewards';
import { deriveProgress } from '../progress/derive';
import { DATA, T } from '../progress/fixtures';
import type { Catalogue, ProgressEvent, ProgressHistory, ProgressView } from '../progress/types';
import { parseRecipe } from '../recipe/parse';
import type { ParsedRecipe } from '../recipe/types';
import type { Substitution } from '../rules/check';
import type { TechniqueNode } from '../toolkit/techniques';
import type { Quest } from './types';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

export const graph = IngredientGraph.fromData(JSON.parse(read('data/ingredients.json')) as IngredientData);
export const subs = JSON.parse(read('data/substitutions.json')) as Substitution[];
export const techniqueNodes = (parse(read('data/techniques.yaml')) as { techniques: TechniqueNode[] }).techniques;

export const recipes: ReadonlyMap<string, ParsedRecipe> = new Map(
  (readdirSync(join(ROOT, 'recipes'), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.cook'))
    .map((f) => f.split(sep).join('/'))
    .sort()
    .map((f) => [f.replace(/\.cook$/, ''), parseRecipe(read(`recipes/${f}`))]),
);

export const quests: Record<string, Quest> = Object.fromEntries(
  ['leela', 'marisol', 'haruka'].map((c) => {
    const q = (parse(read(`content/cooks/${c}.yaml`)) as { quest: Quest }).quest;
    return [q.id, q];
  }),
);

export const COOKS: ReadonlySet<string> = new Set(['leela', 'marisol', 'haruka']);
export const STALLS: ReadonlySet<string> = new Set(['wen', 'bram', 'okafor-sato', 'spice']);

/** A catalogue for the given quests over the canon recipes, as Step 4/5 build it. */
export function catalogueOf(qs: readonly Quest[]): Catalogue {
  return {
    recipes: new Map([...recipes].map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
    quests: new Map(
      qs.map((q) => [q.id, { cook: q.cook, steps: q.steps.length, xp: q.rewards.xp, trust: q.rewards.trust, skills: Object.keys(q.rewards.skills), requires: q.unlock.requires }]),
    ),
    techniques: new Set(techniqueNodes.map((t) => t.id)),
    frames: new Map(),
  };
}

let n = 0;
export const newId = (): string => `q${++n}`;

export const EMPTY_HISTORY: ProgressHistory = { events: [], grants: [], base: null };

/** Record events through grantsFor, as the API does; throws on any rejection so a test sees it. */
export function record(h: ProgressHistory, events: readonly ProgressEvent[], cat: Catalogue): ProgressHistory {
  let out = h;
  for (const e of events) {
    const r = grantsFor(e, out, cat, DATA, T);
    if (r.problems.length > 0) throw new Error(`rejected ${e.kind}: ${r.problems.join(', ')}`);
    out = { ...out, events: [...out.events, e], grants: [...out.grants, ...r.grants] };
  }
  return out;
}

export const view = (h: ProgressHistory, cat: Catalogue): ProgressView => deriveProgress(h, cat);
