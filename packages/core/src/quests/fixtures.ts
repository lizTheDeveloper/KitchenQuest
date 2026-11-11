// Test support for quests/ and toolkit/one-more tests only (not exported from the package): the shipped quests,
// canon recipes, techniques and ingredient data (copies pinned in shipped.fixture.ts), and a catalogue built from
// them, so the engine is tested against real content.
import ingredients from '../../../../data/ingredients.json';
import substitutions from '../../../../data/substitutions.json';
import { IngredientGraph } from '../ingredients/graph';
import { grantsFor } from '../progress/rewards';
import { deriveProgress } from '../progress/derive';
import { DATA, T } from '../progress/fixtures';
import type { Catalogue, ProgressEvent, ProgressHistory, ProgressView } from '../progress/types';
import { parseRecipe } from '../recipe/parse';
import type { ParsedRecipe } from '../recipe/types';
import type { Substitution } from '../rules/check';
import type { TechniqueNode } from '../toolkit/techniques';
import { SHIPPED_QUESTS, SHIPPED_RECIPE_SOURCES, SHIPPED_TECHNIQUES } from './shipped.fixture';
import type { RulesContext } from './alternatives';
import type { Quest } from './types';

export const graph = IngredientGraph.fromData(ingredients);
export const subs = substitutions as Substitution[];
export const techniqueNodes: readonly TechniqueNode[] = SHIPPED_TECHNIQUES;

/** The canon recipes, slug → parsed. */
export const recipes: ReadonlyMap<string, ParsedRecipe> = new Map(
  Object.keys(SHIPPED_RECIPE_SOURCES)
    .sort()
    .map((slug) => [slug, parseRecipe(SHIPPED_RECIPE_SOURCES[slug])]),
);

export const quests: Record<string, Quest> = Object.fromEntries(SHIPPED_QUESTS.map((q) => [q.id, q]));

export const COOKS: ReadonlySet<string> = new Set(['leela', 'marisol', 'haruka']);
export const STALLS: ReadonlySet<string> = new Set(['wen', 'bram', 'okafor-sato', 'spice']);

/** A catalogue for the given quests over the canon recipes, as Step 4/5 build it. */
export function catalogueOf(qs: readonly Quest[], rs: ReadonlyMap<string, ParsedRecipe> = recipes): Catalogue {
  return {
    recipes: new Map([...rs].map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
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
export function record(h: ProgressHistory, events: readonly ProgressEvent[], cat: Catalogue, rules?: RulesContext): ProgressHistory {
  let out = h;
  for (const e of events) {
    const r = grantsFor(e, out, cat, DATA, T, rules);
    if (r.problems.length > 0) throw new Error(`rejected ${e.kind}: ${r.problems.join(', ')}`);
    out = { ...out, events: [...out.events, e], grants: [...out.grants, ...r.grants] };
  }
  return out;
}

export const view = (h: ProgressHistory, cat: Catalogue): ProgressView => deriveProgress(h, cat);
