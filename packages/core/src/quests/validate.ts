// Quest file checks, shared by the content build (Step 4) and the API catalogue (Step 5). Data in, problems out.
import type { IngredientGraph } from '../ingredients/graph';
import type { Catalogue } from '../progress/types';
import type { Quest } from './types';

/** The trust ladder's range (Ruling 1): 0 Stranger … 5 Keeper of the dish. */
const MAX_TRUST = 5;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Every problem with the quests: each step's references (recipe, technique, stall, ingredient, cook to travel to),
 * riddles with exactly one correct option, `requires` naming known quests with no cycle, `unlock.trust` in 0–5, and
 * every `recognize` step's technique learned elsewhere (not a skill of any of the quest's own cook's recipes), and a
 * cook step's optional `technique` one of its recipe's skills.
 * Reads its input defensively: a quest parsed from YAML may not be the shape its type says.
 */
export function validateQuests(
  quests: Quest[],
  cat: Pick<Catalogue, 'recipes' | 'techniques'>,
  cooks: ReadonlySet<string>,
  stalls: ReadonlySet<string>,
  graph: IngredientGraph,
): string[] {
  const p: string[] = [];
  const ids = new Set<string>();
  for (const q of quests) {
    if (isObj(q) && isStr(q.id)) {
      if (ids.has(q.id)) p.push(`quest "${q.id}": duplicate id`);
      ids.add(q.id);
    }
  }

  const requires = new Map<string, string[]>();
  quests.forEach((q, qi) => {
    if (!isObj(q) || !isStr(q.id)) {
      p.push(`quest ${qi}: needs an id`);
      return;
    }
    const where = `quest "${q.id}"`;
    if (!isStr(q.cook) || !cooks.has(q.cook)) p.push(`${where}: unknown cook "${String(q.cook)}"`);
    if (!isStr(q.title)) p.push(`${where}: needs a title`);

    const unlock: Record<string, unknown> = isObj(q.unlock) ? q.unlock : {};
    if (!isStrList(unlock.requires)) p.push(`${where}: unlock.requires must be a list of quest ids`);
    else {
      for (const r of unlock.requires) {
        if (r === q.id) p.push(`${where}: unlock.requires names itself`);
        else if (!ids.has(r)) p.push(`${where}: unlock.requires names unknown quest "${r}"`);
      }
      requires.set(q.id, unlock.requires.filter((r) => r !== q.id && ids.has(r)));
    }
    const trust = unlock.trust;
    if (typeof trust !== 'number' || !Number.isInteger(trust) || trust < 0 || trust > MAX_TRUST)
      p.push(`${where}: unlock.trust must be a whole number from 0 to ${MAX_TRUST}`);

    const rewards: Record<string, unknown> = isObj(q.rewards) ? q.rewards : {};
    for (const t of Object.keys(isObj(rewards.skills) ? rewards.skills : {}))
      if (!cat.techniques.has(t)) p.push(`${where}: rewards.skills names unknown technique "${t}"`);

    // The techniques the quest's own cook teaches through their dishes: recognition must come from elsewhere.
    const ownSkills = new Set<string>();
    for (const r of cat.recipes.values()) if (r.cook === q.cook) for (const s of r.skills) ownSkills.add(s);

    if (!Array.isArray(q.steps) || q.steps.length === 0) {
      p.push(`${where}: needs at least one step`);
      return;
    }
    (q.steps as unknown[]).forEach((raw, si) => {
      const at = `${where} step ${si + 1}`;
      if (!isObj(raw)) {
        p.push(`${at}: not a step`);
        return;
      }
      const s = raw;
      if (['talk', 'travel', 'drill', 'errand'].includes(s.type as string) && !isStrList(s.lines)) p.push(`${at}: lines must be a list of lines`);
      switch (s.type) {
        case 'talk':
          break;
        case 'travel':
          if (!isStr(s.place) || !cooks.has(s.place)) p.push(`${at}: travel to unknown place "${String(s.place)}"`);
          break;
        case 'riddle': {
          const options: unknown[] = Array.isArray(s.options) ? s.options : [];
          const correct = options.filter((o) => isObj(o) && o.correct === true).length;
          if (correct !== 1) p.push(`${at}: a riddle needs exactly one correct option (has ${correct})`);
          options.forEach((o, oi) => {
            if (!isObj(o) || typeof o.text !== 'string' || typeof o.reaction !== 'string' || typeof o.correct !== 'boolean')
              p.push(`${at}: riddle option ${oi + 1} needs text, reaction and correct`);
          });
          if (typeof s.prompt !== 'string' || typeof s.explain !== 'string') p.push(`${at}: a riddle needs a prompt and an explain`);
          break;
        }
        case 'drill':
          if (!isStr(s.skill) || !cat.techniques.has(s.skill)) p.push(`${at}: drill names unknown technique "${String(s.skill)}"`);
          break;
        case 'errand':
          if (!isStr(s.stall) || !stalls.has(s.stall)) p.push(`${at}: errand to unknown stall "${String(s.stall)}"`);
          if (!isStr(s.item) || !graph.has(s.item)) p.push(`${at}: errand item "${String(s.item)}" is not in the ingredient graph`);
          if (s.adapted !== undefined && !isStrList(s.adapted)) p.push(`${at}: errand adapted must be a list of lines`);
          break;
        case 'recognize':
          if (!isStr(s.technique) || !cat.techniques.has(s.technique)) p.push(`${at}: recognize names unknown technique "${String(s.technique)}"`);
          else if (ownSkills.has(s.technique))
            p.push(`${at}: recognize "${s.technique}" is taught by ${String(q.cook)}'s own recipe; recognition must be of something learned elsewhere`);
          if (!isStrList(s.lines) || !isStrList(s.otherwise)) p.push(`${at}: recognize needs lines and otherwise lists`);
          break;
        case 'cook': {
          const recipe = isStr(s.recipe) ? cat.recipes.get(s.recipe) : undefined;
          if (!recipe) p.push(`${at}: cook names unknown recipe "${String(s.recipe)}"`);
          if (s.technique !== undefined) {
            if (!isStr(s.technique) || !cat.techniques.has(s.technique)) p.push(`${at}: cook technique "${String(s.technique)}" is not a technique`);
            else if (recipe && !recipe.skills.includes(s.technique))
              p.push(`${at}: cook technique "${s.technique}" is not one of ${String(s.recipe)}'s skills`);
          }
          break;
        }
        default:
          p.push(`${at}: unknown step type "${String(s.type)}"`);
      }
    });
  });

  // A requires cycle: depth-first search with a colour per quest (1 on the path, 2 done).
  const colour = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    colour.set(id, 1);
    for (const next of requires.get(id) ?? []) {
      if (colour.get(next) === 1) p.push(`unlock.requires cycle: ${[...path.slice(path.indexOf(next)), next].join(' → ')}`);
      else if (!colour.has(next)) visit(next, [...path, next]);
    }
    colour.set(id, 2);
  };
  for (const id of requires.keys()) if (!colour.has(id)) visit(id, [id]);
  return p;
}
