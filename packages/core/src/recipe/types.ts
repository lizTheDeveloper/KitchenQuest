export type RecipeStatus = 'draft' | 'reviewed';

export interface RecipeMeta {
  title: string;
  country: string;
  region: string;
  credit: string;
  cook: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  skills: string[];
  servings: number;
  license: string;
  status: RecipeStatus;
  sacred: boolean;
  /** Stable contributor ids (e.g. GitHub handles), exactly as written in the front matter; empty when absent. */
  contributors: string[];
}

export interface RecipeIngredient {
  /** The ingredient as written before any `|alias`; this is what gets resolved and checked. */
  name: string;
  /** The Cooklang display alias (`@peanut|nuts{}` gives "nuts"), or null when there is none. */
  displayName: string | null;
  quantity: number | null;
  unit: string | null;
  note: string | null;
}

export interface RecipeTimer {
  name: string | null;
  quantity: number | null;
  unit: string | null;
}

export type StepItem =
  | { type: 'text'; value: string }
  /** `index` points into ParsedRecipe.ingredients. */
  | { type: 'ingredient'; index: number }
  | { type: 'cookware'; name: string }
  /** `index` points into ParsedRecipe.timers. */
  | { type: 'timer'; index: number };

export interface RecipeStep {
  section: string | null;
  items: StepItem[];
}

export interface ParsedRecipe {
  meta: RecipeMeta;
  ingredients: RecipeIngredient[];
  timers: RecipeTimer[];
  steps: RecipeStep[];
  source: string;
}

export class RecipeError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`Invalid recipe: ${problems.join('; ')}`);
    this.name = 'RecipeError';
    this.problems = problems;
  }
}
