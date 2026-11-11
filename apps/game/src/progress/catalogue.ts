import {
  frameOptions, type Catalogue, type FrameOption, type IngredientGraph, type PantryItem, type Quest, type Rule, type RulesContext, type StepContext,
} from '@kitchenquest/core/engine';
import { content, graph } from '../content';
import type { ClientContent } from '../content/types';

const built = new WeakMap<ClientContent, Catalogue>();

/**
 * Core's `Catalogue` from the compiled content: the same recipes, quests, techniques and frames the API builds
 * from its catalog (apps/api/src/progress/catalogue.ts), so `grantsFor` on the device judges an event exactly as the
 * server does (C14). Built once per content.
 */
export function catalogueOf(c: ClientContent = content): Catalogue {
  const hit = built.get(c);
  if (hit) return hit;
  const cat: Catalogue = {
    recipes: new Map(Object.entries(c.recipes).map(([slug, r]) => [slug, { cook: r.meta.cook, skills: r.meta.skills, sacred: r.meta.sacred }])),
    quests: new Map(
      questsOf(c).map((q) => [
        q.id,
        { cook: q.cook, steps: q.steps.length, xp: q.rewards.xp, trust: q.rewards.trust, skills: Object.keys(q.rewards.skills), requires: q.unlock.requires },
      ]),
    ),
    techniques: new Set(c.techniques.techniques.map((t) => t.id)),
    frames: new Map(c.frames.map((f) => [f.id, { technique: f.technique }])),
  };
  built.set(c, cat);
  return cat;
}

/** Every cook's quest, in cook-id order. */
export function questsOf(c: ClientContent = content): Quest[] {
  return Object.keys(c.cooks).sort().map((id) => c.cooks[id].quest);
}

/**
 * The player's rules and content for core (I3 claims, C5 errands, the cook step's stand-ins): every canon recipe,
 * and each Pantry Frame with its status as the frame engine (Step 3) fills it from this pantry today.
 */
export function rulesContextOf(rules: Rule[], pantry: readonly PantryItem[], today: string, g: IngredientGraph = graph, c: ClientContent = content): RulesContext {
  const subs = [...c.substitutions];
  const frames: FrameOption[] = frameOptions(c.frames, pantry, { rules, graph: g, subs, today, keeps: c.keeps });
  return { rules, graph: g, subs, recipes: new Map(Object.entries(c.recipes)), frames };
}

/** The full StepContext `advance` needs (C5): the rules context, today, and the catalogue's recipes. */
export function stepContextOf(rules: Rule[], pantry: readonly PantryItem[], today: string, g: IngredientGraph = graph, c: ClientContent = content): StepContext {
  return { ...rulesContextOf(rules, pantry, today, g, c), today, cat: catalogueOf(c) };
}
