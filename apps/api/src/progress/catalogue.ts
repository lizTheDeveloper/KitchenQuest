import { validateQuests, type Catalogue } from '@kitchenquest/core';
import type { LoopContent } from '../catalog.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';

const built = new WeakMap<RecipeIndex, WeakMap<LoopContent, { cat: Catalogue; checked: boolean }>>();

/**
 * Core's `Catalogue` (what `grantsFor` validates events against): the canon recipes from the `RecipeIndex`, and the
 * quests, techniques and frames from the boot-validated `LoopContent`. Built once per index and content, so a recipe
 * sync (a new index, C7) gives the next request a new catalogue and an unchanged table reuses the last one.
 *
 * The quests are checked again against each new index (M5): boot checked them against the `recipes/` files, but
 * requests read `canon_recipes`, so a sync that drops or renames a dish a quest names makes this throw, naming the
 * quest, and every progress request fails loudly (500, logged) instead of judging events against a catalogue the
 * content doesn't fit. Not checked: an empty index (a database before its first sync, where no dish can be cooked
 * anyway), and `check: false`, which the export uses so a player's data can always be downloaded.
 */
export function catalogueFor(recipes: RecipeIndex, loop: LoopContent, { check = true }: { check?: boolean } = {}): Catalogue {
  let forIndex = built.get(recipes);
  if (!forIndex) {
    forIndex = new WeakMap();
    built.set(recipes, forIndex);
  }
  const cached = forIndex.get(loop);
  if (cached && (!check || cached.checked)) return cached.cat;
  const recipeMeta = new Map([...recipes].map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }]));
  const techniques = new Set(loop.techniques.map((t) => t.id));
  const problems = check && recipes.size > 0 ? validateQuests(loop.quests, { recipes: recipeMeta, techniques }, loop.cooks, loop.stalls, loop.graph) : [];
  if (problems.length > 0) throw new Error(`Catalog: canon_recipes does not fit the quests: ${problems.join('; ')}`);
  const cat: Catalogue = {
    recipes: recipeMeta,
    quests: new Map(
      loop.quests.map((q) => [
        q.id,
        { cook: q.cook, steps: q.steps.length, xp: q.rewards.xp, trust: q.rewards.trust, skills: Object.keys(q.rewards.skills), requires: q.unlock.requires },
      ]),
    ),
    techniques,
    frames: new Map(loop.frames.map((f) => [f.id, { technique: f.technique }])),
  };
  forIndex.set(loop, { cat, checked: check });
  return cat;
}
