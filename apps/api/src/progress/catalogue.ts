import type { Catalogue } from '@kitchenquest/core';
import type { LoopContent } from '../catalog.js';
import type { RecipeIndex } from '../recipes/recipe-index.js';

const built = new WeakMap<RecipeIndex, WeakMap<LoopContent, Catalogue>>();

/**
 * Core's `Catalogue` (what `grantsFor` validates events against): the canon recipes from the `RecipeIndex`, and the
 * quests, techniques and frames from the boot-validated `LoopContent`. Built once per index and content, so a recipe
 * sync (a new index, C7) gives the next request a new catalogue and an unchanged table reuses the last one.
 */
export function catalogueFor(recipes: RecipeIndex, loop: LoopContent): Catalogue {
  let forIndex = built.get(recipes);
  if (!forIndex) {
    forIndex = new WeakMap();
    built.set(recipes, forIndex);
  }
  const cached = forIndex.get(loop);
  if (cached) return cached;
  const cat: Catalogue = {
    recipes: new Map([...recipes].map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
    quests: new Map(
      loop.quests.map((q) => [
        q.id,
        { cook: q.cook, steps: q.steps.length, xp: q.rewards.xp, trust: q.rewards.trust, skills: Object.keys(q.rewards.skills), requires: q.unlock.requires },
      ]),
    ),
    techniques: new Set(loop.techniques.map((t) => t.id)),
    frames: new Map(loop.frames.map((f) => [f.id, { technique: f.technique }])),
  };
  forIndex.set(loop, cat);
  return cat;
}
