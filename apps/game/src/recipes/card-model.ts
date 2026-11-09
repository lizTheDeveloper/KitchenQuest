import {
  check, DISCLAIMER, nutritionPerServing,
  type CheckStatus, type Finding, type IngredientGraph, type Nutrient,
} from '@kitchenquest/core/engine';
import type { GameContent } from '../content/types';
import type { RulesState } from './rules';

export interface NutritionRow { nutrient: Nutrient; label: string; value: string } // value e.g. '12 g', '480 mg', '310 kcal'

export interface CardFinding {
  ingredient: string;
  /** From core: a rule matched, the ingredient couldn't be identified, or it depends on a label. */
  kind: Finding['kind'];
  status: Exclude<CheckStatus, 'ok'>;
  path: string | null; // names joined ' → '
  ruleNote: string | null; // the player's own words
  swapLabel: string | null; // 'swapped: neutral oil for ghee'
}

export interface RecipeCard {
  slug: string; title: string; country: string; region: string; credit: string; license: string;
  cook: { id: string; name: string }; skills: { id: string; name: string }[];
  draft: boolean; sacred: boolean;
  status: CheckStatus; findings: CardFinding[]; severe: boolean; disclaimer: string | null;
  rulesChecked: number; rulesError: string | null;
  cookable: boolean; notCookableReason: 'blocked' | 'sacred' | null;
  nutrition: { rows: NutritionRow[]; estimated: boolean; missing: string[] };
}

const NUTRIENT_ROWS: { nutrient: Nutrient; label: string; unit: string }[] = [
  { nutrient: 'energy_kcal', label: 'Energy', unit: 'kcal' },
  { nutrient: 'protein_g', label: 'Protein', unit: 'g' },
  { nutrient: 'fat_g', label: 'Fat', unit: 'g' },
  { nutrient: 'carb_g', label: 'Carbohydrate', unit: 'g' },
  { nutrient: 'fiber_g', label: 'Fiber', unit: 'g' },
  { nutrient: 'sugars_g', label: 'Sugars', unit: 'g' },
  { nutrient: 'sodium_mg', label: 'Sodium', unit: 'mg' },
];

/**
 * Everything a recipe card shows. Status comes only from core `check` and nutrition only from core
 * `nutritionPerServing` (§2.1). When the rules can't be read, `check` is not called and the card is
 * unverified: never ok, never blocked (§2.2).
 */
export function buildRecipeCard(input: {
  slug: string; content: GameContent; graph: IngredientGraph; rules: RulesState; today: string; showCalories: boolean;
}): RecipeCard {
  const { slug, content, graph, rules, today, showCalories } = input;
  const recipe = content.recipes[slug];
  if (!recipe) throw new Error(`Unknown recipe "${slug}"`);
  const { meta } = recipe;
  const cook = content.cooks[meta.cook];
  if (!cook) throw new Error(`Recipe "${slug}" names unknown cook "${meta.cook}"`);
  const skillName = (id: string) => content.techniques.techniques.find((t) => t.id === id)?.name ?? id;

  let status: CheckStatus;
  let findings: CardFinding[];
  let severe: boolean;
  let disclaimer: string | null;
  let rulesChecked: number;
  let rulesError: string | null;
  if (rules.status === 'error') {
    status = 'unverified';
    findings = [];
    // A severe rule may be among the ones we couldn't read, so the allergy disclaimer stays up.
    severe = true;
    disclaimer = DISCLAIMER;
    rulesChecked = 0;
    rulesError = rules.message;
  } else {
    const result = check(recipe, rules.rules, graph, content.substitutions, today);
    const notes = new Map(rules.rules.map((r) => [r.id, r.note ?? null]));
    status = result.status;
    severe = result.severe;
    disclaimer = result.disclaimer;
    rulesChecked = rules.rules.length;
    rulesError = null;
    findings = result.findings.map((f) => ({
      ingredient: f.ingredient,
      kind: f.kind,
      status: f.status,
      path: f.path ? f.path.map((id) => graph.get(id).name).join(' → ') : null,
      ruleNote: f.ruleId !== undefined ? (notes.get(f.ruleId) ?? null) : null,
      swapLabel: f.swap ? `swapped: ${f.swap.toName} for ${f.ingredient}` : null,
    }));
  }

  const n = nutritionPerServing(recipe, graph);
  const rows = NUTRIENT_ROWS
    .filter((r) => showCalories || r.nutrient !== 'energy_kcal') // calories hidden by default (§5)
    .map((r) => ({ nutrient: r.nutrient, label: r.label, value: `${Math.round(n.perServing[r.nutrient]) + 0} ${r.unit}` }));

  const sacred = meta.sacred;
  const cookable = !sacred && status !== 'blocked';
  return {
    slug, title: meta.title, country: meta.country, region: meta.region, credit: meta.credit, license: meta.license,
    cook: { id: meta.cook, name: cook.name },
    skills: meta.skills.map((id) => ({ id, name: skillName(id) })),
    draft: meta.status === 'draft', sacred,
    status, findings, severe, disclaimer, rulesChecked, rulesError,
    cookable, notCookableReason: sacred ? 'sacred' : status === 'blocked' ? 'blocked' : null,
    nutrition: { rows, estimated: n.estimated, missing: n.missing },
  };
}
